const BRIDGE_BASE = 'http://127.0.0.1:4318'
const POLL_ALARM = 'zero-poll-command'

// Ensure alarm exists on every service worker startup (covers reload/update/install)
async function ensureAlarm() {
  const existing = await chrome.alarms.get(POLL_ALARM)
  if (!existing) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.05 })
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.05 })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.05 })
})

// Run immediately when service worker starts
void ensureAlarm()

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void pollCommand()
  }
})

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  return tab
}

async function getTargetTab(payload) {
  const parsedTabId = Number(payload?.tabId)
  if (Number.isInteger(parsedTabId) && parsedTabId > 0) {
    let tab = await chrome.tabs.get(parsedTabId)
    if (!tab?.id) throw new Error(`Tab not found: ${parsedTabId}`)

    // If the tab was discarded by Chrome (memory saver), reload it and wait for it to finish
    if (tab.discarded) {
      await chrome.tabs.reload(parsedTabId)
      // Wait for the tab to finish loading (poll up to 15s)
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        tab = await chrome.tabs.get(parsedTabId)
        if (tab.status === 'complete') break
      }
      if (tab.status !== 'complete') {
        console.warn(`Tab ${parsedTabId} reload timed out (status: ${tab.status}), proceeding anyway`)
      }
    }

    return tab
  }
  return getActiveTab()
}

function uniqLinks(links) {
  const seen = new Set()
  return links.filter((link) => {
    const key = `${link.href}\n${link.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function collectWarnings({ bodyText, mainText, title }) {
  const haystack = `${title}\n${mainText}\n${bodyText}`.toLowerCase()
  const warnings = []
  if (haystack.includes('log in') || haystack.includes('sign up')) warnings.push('login_wall_signals')
  if (haystack.includes('this page is not supported')) warnings.push('unsupported_page')
  if (haystack.includes('something went wrong')) warnings.push('error_shell')
  if (!mainText?.trim()) warnings.push('main_text_empty')
  if ((bodyText?.trim().length ?? 0) < 200) warnings.push('body_text_short')
  return warnings
}

function toTabSummary(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function serializeEvalValue(value) {
  if (value === undefined) return { value: null, warnings: ['eval_returned_undefined'] }

  try {
    const normalized = JSON.parse(JSON.stringify(value))
    return { value: normalized, warnings: [] }
  } catch {
    return {
      value: String(value),
      warnings: ['eval_value_stringified'],
    }
  }
}

async function listTabs(payload = {}) {
  const { query, limit, maxTitleLength } = payload
  const allTabs = await chrome.tabs.query({})
  const activeTab = await getActiveTab()

  let filtered = allTabs.filter((tab) => typeof tab.id === 'number' && typeof tab.windowId === 'number')

  // keyword filter: match against title or url (case-insensitive)
  if (query && typeof query === 'string') {
    const lowerQuery = query.toLowerCase()
    filtered = filtered.filter(
      (tab) =>
        (tab.title ?? '').toLowerCase().includes(lowerQuery) ||
        (tab.url ?? '').toLowerCase().includes(lowerQuery),
    )
  }

  const totalCount = filtered.length

  // apply limit (default 30 to keep response compact)
  const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 30
  const truncated = filtered.length > effectiveLimit
  const sliced = filtered.slice(0, effectiveLimit)

  // map to summary with optional title truncation
  const titleLimit = typeof maxTitleLength === 'number' && maxTitleLength > 0 ? maxTitleLength : 80
  const tabs = sliced.map((tab) => {
    const summary = toTabSummary(tab)
    if (summary.title.length > titleLimit) {
      summary.title = summary.title.slice(0, titleLimit) + '…'
    }
    return summary
  })

  return {
    tabId: activeTab.id,
    windowId: activeTab.windowId,
    totalCount,
    truncated,
    tabs,
  }
}

async function selectTab(tabId) {
  const parsedTabId = Number(tabId)
  if (!Number.isInteger(parsedTabId) || parsedTabId <= 0) throw new Error('Missing or invalid tabId')

  const tab = await chrome.tabs.get(parsedTabId)
  if (!tab?.id) throw new Error(`Tab not found: ${parsedTabId}`)

  await chrome.tabs.update(parsedTabId, { active: true })
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  await new Promise((resolve) => setTimeout(resolve, 300))

  const selected = await chrome.tabs.get(parsedTabId)
  return toTabSummary(selected)
}

async function captureTabScreenshot(payload) {
  // mode: "visible" (default) — captureVisibleTab, requires tab to become active
  // mode: "cdp"               — chrome.debugger Page.captureScreenshot, works on
  //                              non-active and even non-foreground tabs without
  //                              changing the user's active selection.
  // restoreActive: when true (and we had to switch tabs), restore the previous
  //                active tab when done.
  const mode = payload?.mode === 'cdp' ? 'cdp' : 'visible'
  const restoreActive = payload?.restoreActive === true

  // Remember the originally active tab so we can restore it if needed.
  let originalActive = null
  if (restoreActive || mode === 'cdp') {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (active?.id) originalActive = { id: active.id, windowId: active.windowId }
    } catch (_) { /* ignore */ }
  }

  let tab
  if (mode === 'cdp') {
    // CDP path: do NOT switch tabs. Just resolve target tab.
    if (payload?.tabId !== undefined) {
      tab = await chrome.tabs.get(Number(payload.tabId))
      if (!tab?.id) throw new Error(`Tab not found: ${payload.tabId}`)
    } else {
      tab = await getActiveTab()
    }
    const cdp = await captureViaDebugger(tab.id, payload)
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      dataUrl: cdp.dataUrl,
      meta: cdp.meta,
      clip: cdp.clip,
      mode: 'cdp',
    }
  }

  // Visible path (default)
  if (payload?.tabId !== undefined) {
    const selected = await selectTab(payload.tabId)
    tab = await chrome.tabs.get(selected.id)
    await new Promise((resolve) => setTimeout(resolve, 350))
  } else {
    tab = await getActiveTab()
  }

  if (typeof tab?.windowId !== 'number') throw new Error('Unable to determine target window for screenshot')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })

  // Restore original tab if requested
  if (restoreActive && originalActive && originalActive.id !== tab.id) {
    try {
      await chrome.tabs.update(originalActive.id, { active: true })
    } catch (_) { /* tab may have been closed */ }
  }

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    dataUrl,
    mode: 'visible',
    restoredActive: restoreActive && originalActive ? originalActive.id : null,
  }
}

/**
 * Element screenshot via Chrome DevTools Protocol (Puppeteer-style).
 *
 * Flow (mirrors ElementHandle.screenshot() in Puppeteer/Playwright):
 *   1. Briefly make the tab foreground-active so Chrome actually paints it
 *      (remember the previous active tab so we can restore).
 *   2. Attach chrome.debugger.
 *   3. Measure the element rect in page coordinates (scroll into view first).
 *   4. Page.captureScreenshot with {clip, captureBeyondViewport:true}.
 *   5. Detach.
 *   6. Restore the original active tab so the user sees no visible switch
 *      (a short blip in the tab bar is unavoidable; like Puppeteer's
 *       `bringToFront`).
 *
 * No CSS hacks. No DOM mutations. No deviceMetrics override. The clip is
 * Chrome's native element bounding rect and Chrome paints the element with
 * its normal pipeline — exactly what the user would see if they switched to
 * that tab themselves.
 */
/**
 * Element-screenshot via DOM-to-image rendering (html2canvas).
 *
 * This is the iOS/Android "render view to bitmap" equivalent: we walk the
 * target element's DOM, read computed styles, fetch any referenced images
 * (CORS permitting) and rasterize them to a canvas. It completely bypasses
 * the screen compositor, so it works on background/inactive tabs and is
 * unaffected by CDP paint-layer issues.
 *
 * Required payload:
 *   tabId: number
 *   selector: string
 * Optional:
 *   selectorIndex: number    (default 0)
 *   padding: number|object   (extra CSS px around the element)
 *   backgroundColor: string|null  (html2canvas option, default null = transparent)
 *   scale: number            (default devicePixelRatio)
 */
async function captureElementViaDomRender(payload) {
  const tabId = Number(payload?.tabId)
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('dom render requires tabId')
  const selector = typeof payload?.selector === 'string' ? payload.selector : null
  if (!selector) throw new Error('dom render requires selector')
  const selectorIndex = Number.isInteger(payload?.selectorIndex) ? Number(payload.selectorIndex) : 0
  const padding = payload?.padding ?? 0
  const backgroundColor = payload?.backgroundColor ?? null
  const scaleHint = typeof payload?.scale === 'number' ? payload.scale : null

  // Resolve target tab (DO NOT activate / switch)
  const tab = await chrome.tabs.get(tabId)
  if (!tab?.id) throw new Error(`Tab not found: ${tabId}`)

  // Step 1: inject html-to-image into the MAIN world of the target tab.
  // MAIN world is required because the library walks the real page DOM.
  // html-to-image uses SVG <foreignObject> which delegates rendering back
  // to the browser's native engine — it handles nested position:absolute,
  // padding-bottom:100% boxes, CSS transforms etc. correctly (html2canvas
  // does its own layout simulation and gets these wrong on X.com).
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    files: ['html-to-image.js'],
  })

  // Step 2: call html2canvas(el, opts) and return a PNG data URL via message.
  // We use chrome.scripting.executeScript with an async function that returns
  // a JSON-serializable object. Data URLs can be large — we rely on MV3
  // allowing large serialized strings back from executeScript.
  const args = [{ selector, selectorIndex, padding, backgroundColor, scaleHint }]
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args,
    func: async (opts) => {
      const { selector, selectorIndex, padding, backgroundColor, scaleHint } = opts
      const nodes = document.querySelectorAll(selector)
      if (!nodes.length) return { ok: false, error: 'No element matches selector: ' + selector }
      const el = nodes[selectorIndex] || nodes[0]
      try { el.scrollIntoView({ block: 'start', inline: 'start' }) } catch (_) {}
      // Let layout settle
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

      // Wait briefly for any images inside the element to finish loading
      const imgs = el.querySelectorAll('img')
      const pendingImgs = []
      for (const img of imgs) {
        if (img.complete && img.naturalWidth > 0) continue
        pendingImgs.push(new Promise(resolve => {
          const done = () => resolve()
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
          setTimeout(done, 3000)
        }))
      }
      if (pendingImgs.length) await Promise.race([
        Promise.all(pendingImgs),
        new Promise(r => setTimeout(r, 4000)),
      ])

      // html-to-image attaches itself to window.htmlToImage
      const h2i = window.htmlToImage
      if (!h2i || typeof h2i.toPng !== 'function') {
        return { ok: false, error: 'html-to-image not injected' }
      }

      let pad = { top: 0, right: 0, bottom: 0, left: 0 }
      if (typeof padding === 'number') pad = { top: padding, right: padding, bottom: padding, left: padding }
      else if (padding && typeof padding === 'object') {
        pad = {
          top: Number(padding.top ?? padding.y ?? 0) || 0,
          right: Number(padding.right ?? padding.x ?? 0) || 0,
          bottom: Number(padding.bottom ?? padding.y ?? 0) || 0,
          left: Number(padding.left ?? padding.x ?? 0) || 0,
        }
      }

      const rect = el.getBoundingClientRect()
      const scale = scaleHint || window.devicePixelRatio || 1

      // Render the element itself (no cloning/wrapping — X's React-generated
      // CSS classes live in the page's stylesheet and won't apply to a clone
      // that's detached from the hydrated tree). Padding is added to the
      // final canvas after we draw the element image.
      try {
        const opts = {
          pixelRatio: scale,
          skipFonts: false,
        }
        // html-to-image respects the `backgroundColor` option as the canvas fill
        if (backgroundColor != null) opts.backgroundColor = backgroundColor
        const elDataUrl = await h2i.toPng(el, opts)

        // Load the generated image back and composite onto a padded canvas.
        const img = new Image()
        img.src = elDataUrl
        await new Promise((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('failed to load generated image back'))
        })

        const outW = Math.round((rect.width + pad.left + pad.right) * scale)
        const outH = Math.round((rect.height + pad.top + pad.bottom) * scale)
        const canvas = document.createElement('canvas')
        canvas.width = outW
        canvas.height = outH
        const ctx = canvas.getContext('2d')
        if (backgroundColor != null) {
          ctx.fillStyle = backgroundColor
          ctx.fillRect(0, 0, outW, outH)
        }
        ctx.drawImage(img, Math.round(pad.left * scale), Math.round(pad.top * scale))
        const dataUrl = canvas.toDataURL('image/png')

        return {
          ok: true,
          dataUrl,
          meta: {
            rect: { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height },
            canvas: { width: outW, height: outH },
            scale,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          },
        }
      } catch (e) {
        return { ok: false, error: 'html-to-image failed: ' + (e && e.message ? e.message : String(e)) }
      }
    },
  })

  const r = results && results[0] && results[0].result
  if (!r) throw new Error('dom render: no result')
  if (!r.ok) throw new Error(r.error || 'dom render failed')
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    dataUrl: r.dataUrl,
    meta: r.meta,
  }
}

async function captureViaDebugger(tabId, payload) {
  const target = { tabId }
  const format = payload?.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = typeof payload?.quality === 'number' ? payload.quality : undefined
  const selector = typeof payload?.selector === 'string' ? payload.selector : null
  const selectorIndex = Number.isInteger(payload?.selectorIndex) ? Number(payload.selectorIndex) : 0
  const padding = normalizePaddingPayload(payload?.padding)
  const restoreActive = payload?.restoreActive !== false // default true
  const reload = payload?.reload === true
  const waitMs = Number.isFinite(payload?.waitMs) ? Number(payload.waitMs) : 0
  const explicitClip = payload?.clip && typeof payload.clip === 'object' ? payload.clip : null
  const fullPage = payload?.fullPage === true

  // Remember the original active tab so we can restore focus at the end.
  let originalActive = null
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (active?.id && active.id !== tabId) originalActive = { id: active.id, windowId: active.windowId }
  } catch (_) {}

  // Bring the target tab to the foreground so the browser actually runs its
  // paint pipeline for it. Without this, Chrome throttles background tabs
  // and captureScreenshot can return stale / placeholder frames.
  let targetTab
  try {
    targetTab = await chrome.tabs.get(tabId)
    if (!targetTab?.id) throw new Error(`Tab not found: ${tabId}`)
    await chrome.tabs.update(tabId, { active: true })
    if (targetTab.windowId !== undefined) {
      try { await chrome.windows.update(targetTab.windowId, { focused: true }) } catch (_) {}
    }
  } catch (e) {
    throw new Error(`Failed to focus target tab: ${e && e.message ? e.message : e}`)
  }

  // Detach any stale debugger session first.
  try { await chrome.debugger.detach(target) } catch (_) {}
  await chrome.debugger.attach(target, '1.3')

  try {
    await chrome.debugger.sendCommand(target, 'Page.enable', {})

    if (reload) {
      const loadDone = new Promise((resolve) => {
        const listener = (src, method) => {
          if (src.tabId === tabId && method === 'Page.loadEventFired') {
            chrome.debugger.onEvent.removeListener(listener)
            resolve()
          }
        }
        chrome.debugger.onEvent.addListener(listener)
        setTimeout(() => { chrome.debugger.onEvent.removeListener(listener); resolve() }, 15000)
      })
      await chrome.debugger.sendCommand(target, 'Page.reload', { ignoreCache: false })
      await loadDone
    }

    // Give the page a beat to finish initial paint after focus/reload.
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
    else await new Promise((r) => setTimeout(r, 400))

    // Measure + scrollIntoView in the same sync eval so clip coords match.
    let clip = explicitClip
    let measuredMeta = null
    if (selector) {
      const expr = `(function(){
        var SEL = ${JSON.stringify(selector)};
        var IDX = ${selectorIndex};
        var nodes = document.querySelectorAll(SEL);
        if (!nodes.length) throw new Error('No element matches selector: ' + SEL);
        var el = nodes[IDX] || nodes[0];
        try { window.scrollTo(0, 0); } catch(_) {}
        try { el.scrollIntoView({block:'start', inline:'start'}); } catch(_) {}
        var r = el.getBoundingClientRect();
        return JSON.stringify({
          rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
          dpr: window.devicePixelRatio || 1,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          page: { width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) },
        });
      })()`
      const evalResult = await Promise.race([
        chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          timeout: 8000,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('measurement_timeout_10s')), 10000)),
      ])
      if (!evalResult || !evalResult.result || typeof evalResult.result.value !== 'string') {
        throw new Error('CDP measurement failed: ' + JSON.stringify(evalResult?.exceptionDetails || evalResult))
      }
      const meta = JSON.parse(evalResult.result.value)
      measuredMeta = meta
      if (!fullPage) {
        clip = {
          x: meta.rect.x - padding.left,
          y: meta.rect.y - padding.top,
          width: meta.rect.width + padding.left + padding.right,
          height: meta.rect.height + padding.top + padding.bottom,
          scale: 1,
        }
      }
      // After scrollIntoView: let Chrome finish layout + paint (2 frames + a breath)
      await new Promise((r) => setTimeout(r, 300))
    }

    const params = { format, captureBeyondViewport: true }
    if (format === 'jpeg' && typeof quality === 'number') params.quality = quality
    if (clip && !fullPage) params.clip = clip
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params)
    if (!result || typeof result.data !== 'string') throw new Error('Page.captureScreenshot returned no data')
    return {
      dataUrl: `data:image/${format};base64,${result.data}`,
      meta: measuredMeta,
      clip,
    }
  } finally {
    try { await chrome.debugger.detach(target) } catch (_) {}
    // Restore original active tab so the user doesn't see a lingering tab switch.
    if (restoreActive && originalActive && originalActive.id !== tabId) {
      try { await chrome.tabs.update(originalActive.id, { active: true }) } catch (_) {}
      if (originalActive.windowId !== undefined) {
        try { await chrome.windows.update(originalActive.windowId, { focused: true }) } catch (_) {}
      }
    }
  }
}

function normalizePaddingPayload(value) {
  if (value == null) return { top: 0, right: 0, bottom: 0, left: 0 }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { top: value, right: value, bottom: value, left: value }
  }
  if (typeof value === 'object') {
    return {
      top: Number(value.top ?? value.y ?? 0) || 0,
      right: Number(value.right ?? value.x ?? 0) || 0,
      bottom: Number(value.bottom ?? value.y ?? 0) || 0,
      left: Number(value.left ?? value.x ?? 0) || 0,
    }
  }
  return { top: 0, right: 0, bottom: 0, left: 0 }
}

async function runEvalInWorld(tabId, source, world) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [source],
    func: async (rawExpression) => {
      try {
        // Indirect eval — in ISOLATED world this is NOT subject to page CSP;
        // in MAIN world it IS subject to page CSP but can access page JS globals.
        // eslint-disable-next-line no-eval
        const output = await (0, eval)(`(async () => { return (${rawExpression}) })()`)
        return {
          ok: true,
          ...(() => {
            if (output === undefined) return { value: null, warnings: ['eval_returned_undefined'] }
            try {
              return { value: JSON.parse(JSON.stringify(output)), warnings: [] }
            } catch {
              return { value: String(output), warnings: ['eval_value_stringified'] }
            }
          })(),
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })

  const payload = result?.result
  if (!payload) throw new Error('No eval result returned')
  return payload
}

// Use chrome.debugger API (CDP Runtime.evaluate) to execute JS in the page.
// This completely bypasses both page CSP and extension CSP restrictions.
async function runEvalViaCDP(tabId, source) {
  const debuggee = { tabId }

  await chrome.debugger.attach(debuggee, '1.3')
  try {
    const evalResult = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: `(async () => { return (${source}) })()`,
      awaitPromise: true,
      returnByValue: true,
    })

    if (evalResult.exceptionDetails) {
      const errMsg = evalResult.exceptionDetails.exception?.description
        ?? evalResult.exceptionDetails.text
        ?? 'Unknown eval error'
      return { ok: false, error: errMsg }
    }

    const value = evalResult.result?.value
    if (value === undefined) {
      return { value: null, warnings: ['eval_returned_undefined'] }
    }
    return { value, warnings: ['via_cdp_debugger'] }
  } finally {
    try { await chrome.debugger.detach(debuggee) } catch { /* ignore detach errors */ }
  }
}

async function runEval(tabId, expression) {
  const source = String(expression ?? '').trim()
  if (!source) throw new Error('Missing expression')

  // Strategy: try ISOLATED world first (immune to page CSP, can access DOM but
  // not page JS globals), then fall back to MAIN world (can access page JS
  // globals but subject to page CSP — will fail on strict-CSP sites).
  const isolated = await runEvalInWorld(tabId, source, 'ISOLATED')
  if (isolated.ok) {
    return serializeEvalValue(isolated.value)
  }

  // ISOLATED failed (likely needs page JS globals) — try MAIN world
  const main = await runEvalInWorld(tabId, source, 'MAIN')
  if (main.ok) {
    const result = serializeEvalValue(main.value)
    result.warnings = [...(result.warnings || []), 'fell_back_to_main_world']
    return result
  }

  // Both scripting worlds failed (likely due to page CSP blocking eval).
  // Fall back to chrome.debugger CDP which bypasses CSP entirely.
  try {
    const cdpResult = await runEvalViaCDP(tabId, source)
    if (cdpResult.ok === false) throw new Error(cdpResult.error)
    const result = serializeEvalValue(cdpResult.value)
    result.warnings = [...(result.warnings || []), ...(cdpResult.warnings || []), 'fell_back_to_cdp_debugger']
    return result
  } catch (cdpError) {
    // All three methods failed
    throw new Error(
      cdpError instanceof Error ? cdpError.message
        : main.error
          ?? isolated.error
          ?? 'Eval failed in ISOLATED, MAIN, and CDP worlds',
    )
  }
}

async function extractPage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const main = document.querySelector('main, article, [role="main"]')
      const links = [...document.querySelectorAll('a[href]')]
        .map((anchor) => ({
          href: anchor.href,
          text: (anchor.innerText || anchor.textContent || '').trim(),
        }))
        .filter((link) => link.href)
      const meta = Object.fromEntries(
        [...document.querySelectorAll('meta[name], meta[property]')]
          .map((node) => {
            const key = node.getAttribute('name') || node.getAttribute('property')
            const value = node.getAttribute('content') || ''
            return key ? [key, value] : null
          })
          .filter(Boolean),
      )

      return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        selectionText: window.getSelection()?.toString() ?? '',
        bodyText: document.body?.innerText ?? '',
        mainText: main?.innerText ?? '',
        html: document.documentElement?.outerHTML ?? '',
        mainHtml: main?.outerHTML ?? '',
        links,
        meta,
        scrollY: window.scrollY,
      }
    },
  })

  const page = result?.result ?? null
  if (!page) return page

  return {
    ...page,
    links: uniqLinks(page.links ?? []),
    warnings: collectWarnings(page),
  }
}

async function clickOnPage(tabId, selector, index) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector, index ?? 0],
    func: (sel, idx) => {
      const elements = document.querySelectorAll(sel)
      const el = elements[idx]
      if (!el) return { ok: false, error: `No element found for selector: ${sel} [${idx}]` }
      el.scrollIntoView({ block: 'center' })
      el.click()
      return { ok: true, tag: el.tagName, text: (el.innerText || el.textContent || '').trim().slice(0, 100) }
    },
  })
  const payload = result?.result
  if (!payload?.ok) throw new Error(payload?.error ?? 'Click failed')
  return payload
}

async function inputOnPage(tabId, selector, value) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector, value],
    func: (sel, val) => {
      const el = document.querySelector(sel)
      if (!el) return { ok: false, error: `No element found for selector: ${sel}` }
      el.focus()
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, val)
      } else {
        el.value = val
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: el.value }
    },
  })
  const payload = result?.result
  if (!payload?.ok) throw new Error(payload?.error ?? 'Input failed')
  return payload
}

async function getElementsOnPage(tabId, selector) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (sel) => {
      const elements = [...document.querySelectorAll(sel)]
      return elements.map((el, i) => ({
        index: i,
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 200),
        html: el.outerHTML.slice(0, 300),
        href: el.href ?? null,
        value: el.value ?? null,
        type: el.type ?? null,
        disabled: el.disabled ?? null,
        ariaLabel: el.getAttribute('aria-label'),
      }))
    },
  })
  return result?.result ?? []
}

async function scrollByOnPage(tabId, y) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [y],
    func: async (offsetY) => {
      window.scrollBy(0, Number(offsetY) || 0)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return {
        url: location.href,
        title: document.title,
        scrollY: window.scrollY,
      }
    },
  })
  return result?.result
}

async function openUrl(url) {
  const [existingTab] = await chrome.tabs.query({ url })

  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, { active: true })
    if (existingTab.windowId !== undefined) {
      await chrome.windows.update(existingTab.windowId, { focused: true })
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    return existingTab
  }

  const tab = await chrome.tabs.create({ url, active: true })
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  await new Promise((resolve) => setTimeout(resolve, 1200))
  return tab
}

async function fetchNextCommand() {
  const response = await fetch(`${BRIDGE_BASE}/extension/next-command`)
  if (!response.ok) throw new Error(`next-command HTTP ${response.status}`)
  return response.json()
}

async function postCommandResult(result) {
  const response = await fetch(`${BRIDGE_BASE}/extension/command-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  })
  if (!response.ok) throw new Error(`command-result HTTP ${response.status}`)
  return response.json()
}

async function postPageContext(payload) {
  await fetch(`${BRIDGE_BASE}/page-context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'browser-extension',
      ...payload,
      timestamp: new Date().toISOString(),
    }),
  })
}

async function executeCommand(command) {
  switch (command.type) {
    case 'openUrl': {
      const url = String(command.payload?.url ?? '')
      if (!url) throw new Error('Missing url')
      const tab = await openUrl(url)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        url,
        title: tab.title ?? '',
        tabId: tab.id,
        windowId: tab.windowId,
      }
    }

    case 'listTabs': {
      const result = await listTabs(command.payload ?? {})
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: result.tabId,
        windowId: result.windowId,
        totalCount: result.totalCount,
        truncated: result.truncated,
        tabs: result.tabs,
      }
    }

    case 'selectTab': {
      const selected = await selectTab(command.payload?.tabId)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: selected.id,
        windowId: selected.windowId,
        title: selected.title,
        url: selected.url,
      }
    }

    case 'closeTabs': {
      const tabIds = command.payload?.tabIds
      if (!tabIds || !Array.isArray(tabIds) || tabIds.length === 0) {
        return { id: command.id, ok: false, error: 'tabIds (array) is required' }
      }
      await chrome.tabs.remove(tabIds)
      return { id: command.id, ok: true, type: command.type, closed: tabIds.length }
    }

    case 'screenshot': {
      // If selector is provided and mode is "dom" (default for selector-based),
      // use the html2canvas-based DOM-to-image renderer which walks the DOM,
      // reads computed styles, and rasterizes the element tree. This works
      // on background tabs, doesn't need to focus the tab, and doesn't suffer
      // from the CDP paint-layer loss that affects X.com avatars.
      const p = command.payload
      const wantsDomRender = p && p.mode === 'dom' && typeof p.selector === 'string'
      if (wantsDomRender) {
        const shot = await captureElementViaDomRender(p)
        return {
          id: command.id,
          ok: true,
          type: command.type,
          tabId: shot.tabId,
          windowId: shot.windowId,
          title: shot.title,
          url: shot.url,
          dataUrl: shot.dataUrl,
          mode: 'dom',
          domMeta: shot.meta ?? null,
        }
      }
      const screenshot = await captureTabScreenshot(command.payload)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: screenshot.tabId,
        windowId: screenshot.windowId,
        title: screenshot.title,
        url: screenshot.url,
        dataUrl: screenshot.dataUrl,
        mode: screenshot.mode ?? null,
        cdpMeta: screenshot.meta ?? null,
        cdpClip: screenshot.clip ?? null,
      }
    }

    case 'reloadExtension': {
      // Schedule a self-reload after returning the result so the bridge sees ok.
      setTimeout(() => { try { chrome.runtime.reload() } catch (_) {} }, 200)
      return { id: command.id, ok: true, type: command.type, scheduled: true }
    }

    case 'eval': {
      const tab = await getTargetTab(command.payload)
      const evaluated = await runEval(tab.id, command.payload?.expression)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? '',
        url: tab.url ?? '',
        value: evaluated.value,
        warnings: evaluated.warnings,
      }
    }

    case 'getPageText':
    case 'getPageContext': {
      const tab = await getTargetTab(command.payload)
      const page = await extractPage(tab.id)
      await postPageContext(page)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: tab.id,
        windowId: tab.windowId,
        url: page.url,
        title: page.title,
        readyState: page.readyState,
        selectionText: page.selectionText,
        bodyText: page.bodyText,
        mainText: page.mainText,
        html: page.html,
        mainHtml: page.mainHtml,
        links: page.links,
        meta: page.meta,
        warnings: page.warnings,
        scrollY: page.scrollY,
      }
    }

    case 'click': {
      const tab = await getTargetTab(command.payload)
      const selector = String(command.payload?.selector ?? '')
      const index = Number(command.payload?.index ?? 0)
      if (!selector) throw new Error('Missing selector')
      const clicked = await clickOnPage(tab.id, selector, index)
      return { id: command.id, ok: true, type: command.type, tabId: tab.id, ...clicked }
    }

    case 'input': {
      const tab = await getTargetTab(command.payload)
      const selector = String(command.payload?.selector ?? '')
      const value = String(command.payload?.value ?? '')
      if (!selector) throw new Error('Missing selector')
      const inputted = await inputOnPage(tab.id, selector, value)
      return { id: command.id, ok: true, type: command.type, tabId: tab.id, ...inputted }
    }

    case 'getElements': {
      const tab = await getTargetTab(command.payload)
      const selector = String(command.payload?.selector ?? '*')
      const elements = await getElementsOnPage(tab.id, selector)
      return { id: command.id, ok: true, type: command.type, tabId: tab.id, elements }
    }

    case 'getAccessibilityTree': {
      const tab = await getTargetTab(command.payload)
      const options = {
        compact: command.payload?.compact !== false,
        maxDepth: command.payload?.maxDepth ?? 0,
      }
      const axResult = await getAccessibilityTree(tab.id, options)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? '',
        url: tab.url ?? '',
        tree: axResult.tree,
        nodeCount: axResult.nodeCount,
        visibleNodeCount: axResult.visibleNodeCount,
      }
    }

    case 'scrollBy': {
      const tab = await getTargetTab(command.payload)
      const offsetY = Number(command.payload?.y ?? 0)
      const page = await scrollByOnPage(tab.id, offsetY)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: tab.id,
        windowId: tab.windowId,
        url: page.url,
        title: page.title,
        scrollY: page.scrollY,
      }
    }

    default:
      throw new Error(`Unsupported command type: ${command.type}`)
  }
}

// ---------------------------------------------------------------------------
// Accessibility Tree via CDP
// ---------------------------------------------------------------------------

async function getAccessibilityTree(tabId, options = {}) {
  const compact = options.compact !== false
  const maxDepth = Number(options.maxDepth) || 0

  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  try {
    const { nodes } = await chrome.debugger.sendCommand(debuggee, 'Accessibility.getFullAXTree', {})

    const nodesById = new Map(nodes.map((n) => [n.nodeId, n]))
    const childrenByParent = new Map()
    for (const node of nodes) {
      if (!node.parentId) continue
      if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, [])
      childrenByParent.get(node.parentId).push(node)
    }

    // Roles that carry their text in name — child StaticText is redundant
    const TEXT_CARRYING_ROLES = new Set([
      'link', 'button', 'heading', 'tab', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'treeitem', 'option', 'radio', 'checkbox', 'switch',
    ])

    // Walk up the parent chain to find the nearest shown (non-generic/none) ancestor
    function findShownAncestor(node) {
      let cur = node.parentId ? nodesById.get(node.parentId) : null
      while (cur) {
        const r = cur.role?.value || ''
        if (r !== 'none' && r !== 'generic' && r !== 'InlineTextBox') return cur
        cur = cur.parentId ? nodesById.get(cur.parentId) : null
      }
      return null
    }

    function shouldShow(node) {
      const role = node.role?.value || ''
      const name = node.name?.value ?? ''
      const value = node.value?.value

      if (compact && role === 'InlineTextBox') return false
      if (role === 'none' || role === 'generic') return false
      if (name === '' && (value === '' || value == null)) return false

      // Dedup: skip StaticText whose text is already in the nearest shown ancestor's name
      if (compact && role === 'StaticText') {
        const ancestor = findShownAncestor(node)
        if (ancestor) {
          const ancestorRole = ancestor.role?.value || ''
          const ancestorName = ancestor.name?.value ?? ''
          if (TEXT_CARRYING_ROLES.has(ancestorRole) && ancestorName.includes(name)) {
            return false
          }
        }
      }

      return true
    }

    function formatNode(node, visibleDepth) {
      const role = node.role?.value || ''
      const name = node.name?.value ?? ''
      const value = node.value?.value
      const indent = '  '.repeat(Math.min(visibleDepth, 20))
      let line = `${indent}[${role}]`
      if (name !== '') line += ` ${name}`
      if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`
      return line
    }

    function orderedChildren(node) {
      const children = []
      const seen = new Set()
      for (const childId of node.childIds || []) {
        const child = nodesById.get(childId)
        if (child && !seen.has(child.nodeId)) {
          seen.add(child.nodeId)
          children.push(child)
        }
      }
      for (const child of childrenByParent.get(node.nodeId) || []) {
        if (!seen.has(child.nodeId)) {
          seen.add(child.nodeId)
          children.push(child)
        }
      }
      return children
    }

    const lines = []
    const visited = new Set()

    // visibleDepth: only increments when the node itself is shown,
    // so hidden generic/none wrappers don't inflate indentation.
    function visit(node, visibleDepth) {
      if (!node || visited.has(node.nodeId)) return
      if (maxDepth > 0 && visibleDepth > maxDepth) return
      visited.add(node.nodeId)

      const show = shouldShow(node)
      if (show) lines.push(formatNode(node, visibleDepth))

      const nextDepth = show ? visibleDepth + 1 : visibleDepth
      for (const child of orderedChildren(node)) {
        visit(child, nextDepth)
      }
    }

    const roots = nodes.filter((n) => !n.parentId || !nodesById.has(n.parentId))
    for (const root of roots) visit(root, 0)
    for (const node of nodes) visit(node, 0)

    return {
      ok: true,
      tree: lines.join('\n'),
      nodeCount: nodes.length,
      visibleNodeCount: lines.length,
    }
  } finally {
    try { await chrome.debugger.detach(debuggee) } catch { /* ignore */ }
  }
}

async function pollCommand() {
  try {
    const data = await fetchNextCommand()
    if (!data.command) return

    try {
      const result = await executeCommand(data.command)
      await postCommandResult({ ...result, timestamp: new Date().toISOString() })
    } catch (error) {
      await postCommandResult({
        id: data.command.id,
        ok: false,
        type: data.command.type,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    console.error('pollCommand failed', error)
  }
}
