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

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  const activeTab = await getActiveTab()
  return {
    tabId: activeTab.id,
    windowId: activeTab.windowId,
    tabs: tabs
      .filter((tab) => typeof tab.id === 'number' && typeof tab.windowId === 'number')
      .map(toTabSummary),
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
      const result = await listTabs()
      return {
        id: command.id,
        ok: true,
        type: command.type,
        tabId: result.tabId,
        windowId: result.windowId,
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

    case 'eval': {
      const tab = await getActiveTab()
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
      const tab = await getActiveTab()
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
      const tab = await getActiveTab()
      const selector = String(command.payload?.selector ?? '')
      const index = Number(command.payload?.index ?? 0)
      if (!selector) throw new Error('Missing selector')
      const clicked = await clickOnPage(tab.id, selector, index)
      return { id: command.id, ok: true, type: command.type, tabId: tab.id, ...clicked }
    }

    case 'input': {
      const tab = await getActiveTab()
      const selector = String(command.payload?.selector ?? '')
      const value = String(command.payload?.value ?? '')
      if (!selector) throw new Error('Missing selector')
      const inputted = await inputOnPage(tab.id, selector, value)
      return { id: command.id, ok: true, type: command.type, tabId: tab.id, ...inputted }
    }

    case 'getElements': {
      const tab = await getActiveTab()
      const selector = String(command.payload?.selector ?? '*')
      const elements = await getElementsOnPage(tab.id, selector)
      return { id: command.id, ok: true, type: command.type, tabId: tab.id, elements }
    }

    case 'scrollBy': {
      const tab = await getActiveTab()
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
