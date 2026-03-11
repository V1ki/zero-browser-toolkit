import { $ } from 'bun'

type Action =
  | 'health'
  | 'getFrontBrowserInfo'
  | 'openUrl'
  | 'copySelection'
  | 'getClipboardText'
  | 'screenshotFrontWindow'
  | 'saveContext'
  | 'captureContext'
  | 'getPageContext'
  | 'listTabs'
  | 'selectTab'
  | 'eval'
  | 'click'
  | 'input'
  | 'getElements'

type BrowserName = 'Google Chrome' | 'Safari'

type ActionRequest = {
  action?: Action
  url?: string
  browser?: BrowserName
  timeoutMs?: number
  tabId?: number | string
  expression?: string
  selector?: string
  index?: number
  value?: string
  fields?: string[]
  maxLinks?: number
}

type PageLink = {
  text: string
  href: string
}

type BrowserTab = {
  id: number
  windowId: number
  active: boolean
  title: string
  url: string
}

type PageContextPayload = {
  source?: string
  title?: string
  url?: string
  selectionText?: string
  bodyText?: string
  mainText?: string
  html?: string
  mainHtml?: string
  links?: PageLink[]
  meta?: Record<string, string>
  warnings?: string[]
  readyState?: string
  timestamp?: string
}

type CommandType = 'openUrl' | 'getPageText' | 'scrollBy' | 'getPageContext' | 'listTabs' | 'selectTab' | 'eval' | 'click' | 'input' | 'getElements'

type ExtensionCommand = {
  id: string
  type: CommandType
  payload?: Record<string, unknown>
  createdAt: string
}

type ExtensionCommandResult = {
  id: string
  ok: boolean
  type?: CommandType
  url?: string
  title?: string
  selectionText?: string
  bodyText?: string
  mainText?: string
  html?: string
  mainHtml?: string
  links?: PageLink[]
  meta?: Record<string, string>
  warnings?: string[]
  readyState?: string
  scrollY?: number
  tabId?: number
  windowId?: number
  tabs?: BrowserTab[]
  value?: unknown
  error?: string
  timestamp?: string
  tag?: string
  text?: string
  elements?: unknown[]
}

type JsonRecord = Record<string, unknown>

type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

type BrowserInfo = {
  browser: BrowserName
  title: string
  url: string
}

type ScreenshotResult = {
  browser: BrowserName
  filePath: string
  bounds: WindowBounds
}

const PORT = Number(Bun.env.BROWSER_GUI_BRIDGE_PORT ?? '4318')
const DEFAULT_BROWSER: BrowserName = 'Google Chrome'
const SHARED_DIR = Bun.env.BROWSER_GUI_BRIDGE_SHARED_DIR ?? '/tmp/zero-browser-toolkit/browser-gui-bridge'
const LATEST_CONTEXT_PATH = `${SHARED_DIR}/latest-context.json`
const PAGE_CONTEXT_PATH = `${SHARED_DIR}/latest-page-context.json`
const COMMAND_QUEUE_PATH = `${SHARED_DIR}/command-queue.json`
const COMMAND_RESULT_PATH = `${SHARED_DIR}/latest-command-result.json`
const DEFAULT_COMMAND_TIMEOUT_MS = Number(Bun.env.BROWSER_GUI_BRIDGE_COMMAND_TIMEOUT_MS ?? '15000')
const COMMAND_POLL_INTERVAL_MS = 250
const DEFAULT_PAGE_CONTEXT_FIELDS = ['title', 'url', 'selectionText', 'bodyText', 'mainText', 'links', 'meta', 'warnings', 'readyState']
const DEFAULT_MAX_LINKS = 50

const commandQueue: ExtensionCommand[] = []
let latestCommandResult: ExtensionCommandResult | null = null

function json(data: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function timestampId(date = new Date()): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function createCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeTabId(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Missing or invalid tabId')
  }
  return parsed
}

async function ensureDir(path: string): Promise<void> {
  await runCommand(['mkdir', '-p', path])
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(value, null, 2))
}

async function persistCommandQueue(): Promise<void> {
  await ensureDir(SHARED_DIR)
  await writeJsonFile(COMMAND_QUEUE_PATH, {
    queuedAt: new Date().toISOString(),
    size: commandQueue.length,
    commands: commandQueue,
  })
}

async function persistLatestCommandResult(): Promise<void> {
  await ensureDir(SHARED_DIR)
  await writeJsonFile(COMMAND_RESULT_PATH, latestCommandResult)
}

async function runAppleScript(script: string): Promise<string> {
  const proc = Bun.spawn(['osascript', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `osascript exited with code ${exitCode}`)
  }

  return stdout.trim()
}

async function runCommand(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command[0]} exited with code ${exitCode}`)
  }

  return stdout.trim()
}

async function getFrontBrowserInfo(browser = DEFAULT_BROWSER): Promise<BrowserInfo> {
  const script = `
    tell application "${browser}"
      if not (exists front window) then
        error "No front window"
      end if
      set theTab to active tab of front window
      set theTitle to title of theTab
      set theUrl to URL of theTab
      return theTitle & linefeed & theUrl
    end tell
  `
  const result = await runAppleScript(script)
  const [title = '', url = ''] = result.split(/\r?\n/)
  return { browser, title, url }
}

async function getWindowBounds(browser = DEFAULT_BROWSER): Promise<WindowBounds> {
  const script = `
    tell application "${browser}"
      activate
      delay 0.1
      if not (exists front window) then
        error "No front window"
      end if
      set winPos to bounds of front window
      set x1 to item 1 of winPos
      set y1 to item 2 of winPos
      set x2 to item 3 of winPos
      set y2 to item 4 of winPos
      return (x1 as string) & "," & (y1 as string) & "," & ((x2 - x1) as string) & "," & ((y2 - y1) as string)
    end tell
  `
  const result = await runAppleScript(script)
  const [x, y, width, height] = result.split(',').map((value) => Number(value.trim()))

  if ([x, y, width, height].some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid window bounds: ${result}`)
  }

  return { x, y, width, height }
}

async function openUrl(url: string, browser = DEFAULT_BROWSER): Promise<JsonRecord> {
  const result = await enqueueCommand('openUrl', { url, browser })
  return {
    ok: true,
    browser,
    url,
    via: 'extension-command-queue',
    queued: true,
    ...(result.command ? { command: result.command } : {}),
  }
}

async function copySelection(browser = DEFAULT_BROWSER): Promise<{ browser: BrowserName; attempted: true }> {
  const script = `
    tell application "${browser}" to activate
    delay 0.2
    tell application "System Events"
      keystroke "c" using command down
    end tell
    return "ok"
  `
  await runAppleScript(script)
  await Bun.sleep(300)
  return { browser, attempted: true }
}

async function getClipboardText(): Promise<{ text: string }> {
  const text = await $`pbpaste`.text()
  return { text }
}

async function screenshotFrontWindow(browser = DEFAULT_BROWSER): Promise<ScreenshotResult> {
  await ensureDir(SHARED_DIR)
  const bounds = await getWindowBounds(browser)
  const filePath = `${SHARED_DIR}/${timestampId()}-${browser.replaceAll(' ', '-').toLowerCase()}.png`
  const rect = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`

  await runCommand(['screencapture', '-x', '-R', rect, filePath])

  return {
    browser,
    filePath,
    bounds,
  }
}

async function buildContext(browser = DEFAULT_BROWSER, attemptCopySelection = false): Promise<JsonRecord> {
  await ensureDir(SHARED_DIR)

  let selectionAttempted = false
  if (attemptCopySelection) {
    const copyResult = await copySelection(browser)
    selectionAttempted = copyResult.attempted
  }

  const browserInfo = await getFrontBrowserInfo(browser)
  const clipboard = await getClipboardText()
  const screenshot = await screenshotFrontWindow(browser)

  return {
    ok: true,
    browser,
    timestamp: new Date().toISOString(),
    title: browserInfo.title,
    url: browserInfo.url,
    clipboardText: clipboard.text,
    screenshotPath: screenshot.filePath,
    bounds: screenshot.bounds,
    selectionAttempted,
  }
}

async function saveContext(browser = DEFAULT_BROWSER, attemptCopySelection = false): Promise<JsonRecord> {
  const context = await buildContext(browser, attemptCopySelection)
  await writeJsonFile(LATEST_CONTEXT_PATH, context)

  return {
    ...context,
    savedTo: LATEST_CONTEXT_PATH,
  }
}

async function savePageContext(payload: PageContextPayload): Promise<JsonRecord> {
  await ensureDir(SHARED_DIR)

  const pageContext = {
    ok: true,
    source: payload.source ?? 'browser-extension',
    timestamp: payload.timestamp ?? new Date().toISOString(),
    title: payload.title ?? '',
    url: payload.url ?? '',
    selectionText: payload.selectionText ?? '',
    bodyText: payload.bodyText ?? '',
    mainText: payload.mainText ?? '',
    html: payload.html ?? '',
    mainHtml: payload.mainHtml ?? '',
    links: payload.links ?? [],
    meta: payload.meta ?? {},
    warnings: payload.warnings ?? [],
    readyState: payload.readyState ?? 'unknown',
  }

  await writeJsonFile(PAGE_CONTEXT_PATH, pageContext)

  return {
    ...pageContext,
    savedTo: PAGE_CONTEXT_PATH,
  }
}

async function enqueueCommand(type: CommandType, payload?: Record<string, unknown>): Promise<{ ok: true; command: ExtensionCommand; queueSize: number }> {
  const command: ExtensionCommand = {
    id: createCommandId(),
    type,
    payload,
    createdAt: new Date().toISOString(),
  }
  commandQueue.push(command)
  await persistCommandQueue()
  return { ok: true, command, queueSize: commandQueue.length }
}

async function dequeueCommand(): Promise<JsonRecord> {
  const command = commandQueue.shift() ?? null
  await persistCommandQueue()
  return { ok: true, command }
}

async function saveCommandResult(result: ExtensionCommandResult): Promise<JsonRecord> {
  latestCommandResult = {
    ...result,
    timestamp: result.timestamp ?? new Date().toISOString(),
  }
  await persistLatestCommandResult()
  return { ok: true, savedTo: COMMAND_RESULT_PATH, result: latestCommandResult }
}

async function waitForCommandResult(commandId: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<ExtensionCommandResult> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    if (latestCommandResult?.id === commandId) {
      return latestCommandResult
    }
    await Bun.sleep(COMMAND_POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for command result: ${commandId}`)
}

async function requestCommand(type: CommandType, payload?: Record<string, unknown>, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<ExtensionCommandResult> {
  const { command } = await enqueueCommand(type, payload)
  const result = await waitForCommandResult(command.id, timeoutMs)
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to run command: ${type}`)
  }
  return result
}

async function getPageContext(timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, fields?: string[], maxLinks?: number): Promise<JsonRecord> {
  const result = await requestCommand('getPageContext', undefined, timeoutMs)

  // Save full context to file for debugging
  const saved = await savePageContext({
    source: 'browser-extension',
    title: result.title,
    url: result.url,
    selectionText: result.selectionText,
    bodyText: result.bodyText,
    mainText: result.mainText,
    html: result.html,
    mainHtml: result.mainHtml,
    links: result.links,
    meta: result.meta,
    warnings: result.warnings,
    readyState: result.readyState,
    timestamp: result.timestamp,
  })

  // Build filtered context based on requested fields
  const requestedFields = fields ?? DEFAULT_PAGE_CONTEXT_FIELDS
  const effectiveMaxLinks = maxLinks ?? DEFAULT_MAX_LINKS
  const filteredContext: JsonRecord = {}
  for (const field of requestedFields) {
    if (field in saved) {
      filteredContext[field] = saved[field]
    }
  }

  // Truncate links if present and exceeds maxLinks
  if (Array.isArray(filteredContext.links) && filteredContext.links.length > effectiveMaxLinks) {
    filteredContext.links = filteredContext.links.slice(0, effectiveMaxLinks)
  }

  return {
    ok: true,
    via: 'extension-command-queue',
    commandId: result.id,
    savedTo: saved.savedTo,
    pageContext: filteredContext,
  }
}

async function listTabs(timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
  const result = await requestCommand('listTabs', undefined, timeoutMs)
  return {
    ok: true,
    via: 'extension-command-queue',
    commandId: result.id,
    tabs: result.tabs ?? [],
    activeTabId: result.tabId ?? null,
    activeWindowId: result.windowId ?? null,
    result,
  }
}

async function selectTab(tabId: number | string | undefined, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
  const normalizedTabId = normalizeTabId(tabId)
  const result = await requestCommand('selectTab', { tabId: normalizedTabId }, timeoutMs)
  return {
    ok: true,
    via: 'extension-command-queue',
    commandId: result.id,
    tabId: result.tabId ?? normalizedTabId,
    windowId: result.windowId ?? null,
    title: result.title ?? '',
    url: result.url ?? '',
    result,
  }
}

async function evalInPage(expression: string | undefined, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
  const source = String(expression ?? '').trim()
  if (!source) throw new Error('Missing expression')

  const result = await requestCommand('eval', { expression: source }, timeoutMs)
  return {
    ok: true,
    via: 'extension-command-queue',
    commandId: result.id,
    tabId: result.tabId ?? null,
    windowId: result.windowId ?? null,
    value: result.value ?? null,
    result,
  }
}

async function clickInPage(selector: string, index = 0, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
  if (!selector) throw new Error('Missing selector')
  const result = await requestCommand('click', { selector, index }, timeoutMs)
  return { ok: true, via: 'extension-command-queue', commandId: result.id, tabId: result.tabId ?? null, tag: result.tag, text: result.text }
}

async function inputInPage(selector: string, value: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
  if (!selector) throw new Error('Missing selector')
  const result = await requestCommand('input', { selector, value }, timeoutMs)
  return { ok: true, via: 'extension-command-queue', commandId: result.id, tabId: result.tabId ?? null, value: result.value }
}

async function getElementsInPage(selector: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
  const result = await requestCommand('getElements', { selector }, timeoutMs)
  return { ok: true, via: 'extension-command-queue', commandId: result.id, tabId: result.tabId ?? null, elements: result.elements }
}

async function handleAction(body: ActionRequest): Promise<JsonRecord> {
  const action = body.action
  const browser = body.browser ?? DEFAULT_BROWSER

  switch (action) {
    case 'health':
      return { ok: true, service: 'browser-gui-bridge', port: PORT }
    case 'getFrontBrowserInfo': {
      const info = await getFrontBrowserInfo(browser)
      return { ok: true, ...info }
    }
    case 'openUrl':
      if (!body.url) throw new Error('Missing url')
      return openUrl(body.url, browser)
    case 'copySelection': {
      const result = await copySelection(browser)
      return { ok: true, ...result }
    }
    case 'getClipboardText': {
      const clipboard = await getClipboardText()
      return { ok: true, ...clipboard }
    }
    case 'screenshotFrontWindow': {
      const screenshot = await screenshotFrontWindow(browser)
      return { ok: true, ...screenshot }
    }
    case 'saveContext':
      return saveContext(browser, false)
    case 'captureContext':
      return saveContext(browser, true)
    case 'getPageContext':
      return getPageContext(body.timeoutMs, body.fields, body.maxLinks)
    case 'listTabs':
      return listTabs(body.timeoutMs)
    case 'selectTab':
      return selectTab(body.tabId, body.timeoutMs)
    case 'eval':
      return evalInPage(body.expression, body.timeoutMs)
    case 'click':
      if (!body.selector) throw new Error('Missing selector')
      return clickInPage(body.selector, body.index, body.timeoutMs)
    case 'input':
      if (!body.selector) throw new Error('Missing selector')
      return inputInPage(body.selector, body.value ?? '', body.timeoutMs)
    case 'getElements':
      return getElementsInPage(body.selector ?? '*', body.timeoutMs)
    default:
      throw new Error(`Unsupported action: ${String(action)}`)
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      const url = new URL(req.url)

      if (req.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'browser-gui-bridge', port: PORT })
      }

      if (req.method === 'POST' && url.pathname === '/action') {
        const body = (await req.json()) as ActionRequest
        const result = await handleAction(body)
        return json(result)
      }

      if (req.method === 'POST' && url.pathname === '/page-context') {
        const body = (await req.json()) as PageContextPayload
        const result = await savePageContext(body)
        return json(result)
      }

      if (req.method === 'POST' && url.pathname === '/extension/enqueue-command') {
        const body = (await req.json()) as { type?: CommandType; payload?: Record<string, unknown> }
        if (!body.type) return json({ ok: false, error: 'Missing type' }, 400)
        const result = await enqueueCommand(body.type, body.payload)
        return json(result)
      }

      if (req.method === 'GET' && url.pathname === '/extension/next-command') {
        const result = await dequeueCommand()
        return json(result)
      }

      if (req.method === 'POST' && url.pathname === '/extension/command-result') {
        const body = (await req.json()) as ExtensionCommandResult
        if (!body.id) return json({ ok: false, error: 'Missing id' }, 400)
        const result = await saveCommandResult(body)
        return json(result)
      }

      if (req.method === 'GET' && url.pathname === '/extension/latest-result') {
        return json({ ok: true, result: latestCommandResult })
      }

      return json({ ok: false, error: 'Not found' }, 404)
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  },
})

console.log(`browser-gui-bridge listening on http://127.0.0.1:${server.port}`)
