import { $ } from 'bun'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

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
  | 'getAccessibilityTree'
  | 'listTabs'
  | 'selectTab'
  | 'closeTab'
  | 'closeTabs'
  | 'screenshot'
  | 'eval'
  | 'click'
  | 'input'
  | 'getElements'
  | 'reloadExtension'

type BrowserName = 'Google Chrome' | 'Safari'

type ActionRequest = {
  action?: Action
  url?: string
  browser?: BrowserName
  timeoutMs?: number
  tabId?: number | string
  tabIds?: Array<number | string>
  expression?: string
  selector?: string
  index?: number
  value?: string
  fields?: string[]
  maxLinks?: number
  compact?: boolean
  maxDepth?: number
  // listTabs filtering
  query?: string
  limit?: number
  maxTitleLength?: number
  saveTo?: string
  // screenshot cropping
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number; x?: number; y?: number }
  rect?: { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number }
  format?: 'png' | 'jpeg'
  quality?: number
  mode?: 'visible' | 'cdp' | 'dom'
  restoreActive?: boolean
  reload?: boolean
  waitMs?: number
  evalBefore?: string
  deviceMetrics?: { width?: number; height?: number; deviceScaleFactor?: number } | null
  forceImgOpacity?: boolean
  backgroundColor?: string | null
  scale?: number
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

type CommandType = 'openUrl' | 'getPageText' | 'scrollBy' | 'getPageContext' | 'getAccessibilityTree' | 'listTabs' | 'selectTab' | 'closeTabs' | 'screenshot' | 'eval' | 'click' | 'input' | 'getElements' | 'reloadExtension'

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
  dataUrl?: string
  cropRect?: { x: number; y: number; width: number; height: number; dpr?: number } | null
  cdpMeta?: { rect: { x: number; y: number; width: number; height: number }; dpr: number; viewport: { width: number; height: number } } | null
  cdpClip?: { x: number; y: number; width: number; height: number; scale?: number } | null
  domMeta?: { rect: { x: number; y: number; width: number; height: number }; canvas: { width: number; height: number }; scale: number; viewport: { width: number; height: number } } | null
  tabs?: BrowserTab[]
  totalCount?: number
  truncated?: boolean
  value?: unknown
  error?: string
  timestamp?: string
  tag?: string
  text?: string
  elements?: unknown[]
  tree?: string
  nodeCount?: number
  visibleNodeCount?: number
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
const DEFAULT_SCREENSHOT_DIR = join(homedir(), '.zero', 'browser', 'shared')
const DEFAULT_PAGE_CONTEXT_FIELDS = ['title', 'url', 'selectionText', 'bodyText', 'mainText', 'links', 'meta', 'warnings', 'readyState']
const DEFAULT_MAX_LINKS = 50
const INLINE_TEXT_LIMITS = {
  selectionText: 1_500,
  bodyText: 4_000,
  mainText: 4_000,
  html: 2_000,
  mainHtml: 2_000,
  accessibilityTree: 8_000,
} as const

const commandQueue: ExtensionCommand[] = []
let latestCommandResult: ExtensionCommandResult | null = null

function json(data: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function timestampId(date = new Date()): string {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-')
}

function createCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function buildInlinePreview(text: string, limit: number, label: string, savedTo: string): string {
  if (text.length <= limit) return text

  const headChars = Math.max(200, Math.floor(limit * 0.65))
  const tailChars = Math.max(120, Math.floor(limit * 0.2))
  const head = text.slice(0, headChars)
  const tail = text.slice(-tailChars)

  return [
    head,
    '',
    `[${label} omitted: ${text.length} chars total. Full content saved to ${savedTo}]`,
    '',
    tail,
  ].join('\n')
}

function sanitizePageContextField(field: string, value: unknown, savedTo: string): unknown {
  if (typeof value !== 'string') return value

  switch (field) {
    case 'selectionText':
      return buildInlinePreview(value, INLINE_TEXT_LIMITS.selectionText, 'selectionText', savedTo)
    case 'bodyText':
      return buildInlinePreview(value, INLINE_TEXT_LIMITS.bodyText, 'bodyText', savedTo)
    case 'mainText':
      return buildInlinePreview(value, INLINE_TEXT_LIMITS.mainText, 'mainText', savedTo)
    case 'html':
      return buildInlinePreview(value, INLINE_TEXT_LIMITS.html, 'html', savedTo)
    case 'mainHtml':
      return buildInlinePreview(value, INLINE_TEXT_LIMITS.mainHtml, 'mainHtml', savedTo)
    case 'accessibilityTree':
      return buildInlinePreview(value, INLINE_TEXT_LIMITS.accessibilityTree, 'accessibilityTree', savedTo)
    default:
      return value
  }
}

class BadRequestError extends Error {
  status = 400 as const
}

function normalizeTabId(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestError('Missing or invalid tabId')
  }
  return parsed
}

function normalizeTabIds(values: Array<number | string> | undefined): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new BadRequestError('tabIds (array) is required')
  }
  return values.map((value) => normalizeTabId(value))
}

function resolveScreenshotPath(saveTo?: string, tabId?: number): string {
  if (typeof saveTo === 'string' && saveTo.trim()) {
    if (!isAbsolute(saveTo)) {
      throw new Error('saveTo must be an absolute path')
    }
    return saveTo
  }

  const fileName = [
    timestampId(),
    'tab-screenshot',
    typeof tabId === 'number' ? `tab-${tabId}` : 'active-tab',
  ].join('-') + '.png'

  return join(DEFAULT_SCREENSHOT_DIR, fileName)
}

function decodePngDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl.trim())
  if (!match) {
    throw new Error('Invalid screenshot data URL')
  }
  return Buffer.from(match[1], 'base64')
}

function decodeImageDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/s.exec(dataUrl.trim())
  if (!match) {
    throw new Error('Invalid image data URL')
  }
  return Buffer.from(match[2], 'base64')
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

async function copySelection(browser = DEFAULT_BROWSER): Promise<{ browser: BrowserName; attempted: true; selectionText?: string }> {
  // Use extension eval to get selection text directly, no need to activate browser or simulate keystrokes
  try {
    const result = await requestCommand('eval', { expression: 'window.getSelection().toString()' }, 5000)
    const text = typeof result.value === 'string' ? result.value : ''
    if (text) {
      // Also put it on clipboard for backward compatibility
      const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
      proc.stdin.write(text)
      proc.stdin.end()
      await proc.exited
    }
    return { browser, attempted: true, selectionText: text }
  } catch {
    // Fallback: just return without selection
    return { browser, attempted: true, selectionText: '' }
  }
}

async function getClipboardText(): Promise<{ text: string }> {
  const text = await $`pbpaste`.text()
  return { text }
}

async function screenshotFrontWindow(browser = DEFAULT_BROWSER): Promise<ScreenshotResult> {
  await ensureDir(SHARED_DIR)
  const filePath = `${SHARED_DIR}/${timestampId()}-${browser.replace(/ /g, '-').toLowerCase()}.png`

  // Use extension's captureVisibleTab API instead of screencapture + activate
  try {
    const result = await requestCommand('screenshot', undefined, 10000)
    const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
    if (dataUrl) {
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      writeFileSync(filePath, Buffer.from(base64, 'base64'))
      return { browser, filePath, bounds: { x: 0, y: 0, width: 0, height: 0 } }
    }
  } catch {
    // Fallback to screencapture without activate
  }

  // Fallback: screencapture without activate (captures whatever is visible)
  const bounds = await getWindowBounds(browser)
  const rect = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`
  await runCommand(['screencapture', '-x', '-R', rect, filePath])

  return { browser, filePath, bounds }
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

async function getPageContext(
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  fields?: string[],
  maxLinks?: number,
  tabId?: number,
): Promise<JsonRecord> {
  const payload: Record<string, unknown> = {}
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('getPageContext', Object.keys(payload).length > 0 ? payload : undefined, timeoutMs)

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
      filteredContext[field] = sanitizePageContextField(field, saved[field], saved.savedTo as string)
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
    contentSizes: {
      selectionTextChars: String(saved.selectionText ?? '').length,
      bodyTextChars: String(saved.bodyText ?? '').length,
      mainTextChars: String(saved.mainText ?? '').length,
      htmlChars: String(saved.html ?? '').length,
      mainHtmlChars: String(saved.mainHtml ?? '').length,
      linkCount: Array.isArray(saved.links) ? saved.links.length : 0,
    },
    pageContext: filteredContext,
  }
}

const AX_TREE_PATH = `${SHARED_DIR}/latest-accessibility-tree.txt`

async function getAccessibilityTree(
  compact = true,
  maxDepth = 0,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  tabId?: number,
): Promise<JsonRecord> {
  const payload: Record<string, unknown> = { compact, maxDepth }
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('getAccessibilityTree', payload, timeoutMs)

  const fullTree = result.tree as string ?? ''
  const nodeCount = result.nodeCount as number ?? 0
  const visibleNodeCount = result.visibleNodeCount as number ?? 0

  // Save full tree to file
  await ensureDir(SHARED_DIR)
  await Bun.write(AX_TREE_PATH, fullTree)

  // Build inline preview
  const inlineTree = sanitizePageContextField('accessibilityTree', fullTree, AX_TREE_PATH) as string

  return {
    ok: true,
    via: 'extension-command-queue',
    commandId: result.id,
    title: result.title ?? '',
    url: result.url ?? '',
    savedTo: AX_TREE_PATH,
    stats: {
      totalNodes: nodeCount,
      visibleNodes: visibleNodeCount,
      treeChars: fullTree.length,
    },
    tree: inlineTree,
  }
}

async function listTabs(
  query?: string,
  limit?: number,
  maxTitleLength?: number,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<JsonRecord> {
  const payload: Record<string, unknown> = {}
  if (query) payload.query = query
  if (typeof limit === 'number') payload.limit = limit
  if (typeof maxTitleLength === 'number') payload.maxTitleLength = maxTitleLength

  const result = await requestCommand('listTabs', Object.keys(payload).length > 0 ? payload : undefined, timeoutMs)
  return {
    ok: true,
    via: 'extension-command-queue',
    commandId: result.id,
    totalCount: result.totalCount ?? (result.tabs as unknown[])?.length ?? 0,
    truncated: result.truncated ?? false,
    tabs: result.tabs ?? [],
    activeTabId: result.tabId ?? null,
    activeWindowId: result.windowId ?? null,
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

async function evalInPage(
  expression: string | undefined,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  tabId?: number,
): Promise<JsonRecord> {
  const source = String(expression ?? '').trim()
  if (!source) throw new Error('Missing expression')

  const payload: Record<string, unknown> = { expression: source }
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('eval', payload, timeoutMs)
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

type PaddingInput =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number; x?: number; y?: number }
  | undefined

type RectInput = { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number } | undefined

type ScreenshotOptions = {
  tabId?: number
  saveTo?: string
  selector?: string
  index?: number
  padding?: PaddingInput
  rect?: RectInput
  mode?: 'visible' | 'cdp' | 'dom'
  restoreActive?: boolean
  reload?: boolean
  waitMs?: number
  evalBefore?: string
  deviceMetrics?: { width?: number; height?: number; deviceScaleFactor?: number } | null
  forceImgOpacity?: boolean
  backgroundColor?: string | null
  scale?: number
}

type NormalizedPadding = { top: number; right: number; bottom: number; left: number }
type CropRect = { x: number; y: number; width: number; height: number }

function normalizePadding(value: PaddingInput): NormalizedPadding {
  if (value == null) return { top: 0, right: 0, bottom: 0, left: 0 }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { top: value, right: value, bottom: value, left: value }
  }
  if (typeof value === 'object') {
    const top = Number((value as any).top ?? (value as any).y ?? 0) || 0
    const right = Number((value as any).right ?? (value as any).x ?? 0) || 0
    const bottom = Number((value as any).bottom ?? (value as any).y ?? 0) || 0
    const left = Number((value as any).left ?? (value as any).x ?? 0) || 0
    return { top, right, bottom, left }
  }
  return { top: 0, right: 0, bottom: 0, left: 0 }
}

function normalizeRectInput(rect: RectInput): CropRect | null {
  if (!rect || typeof rect !== 'object') return null
  const x = Number(rect.x ?? rect.left)
  const y = Number(rect.y ?? rect.top)
  const width = Number(rect.width)
  const height = Number(rect.height)
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null
  return { x, y, width, height }
}

async function measureElement(
  tabId: number,
  selector: string,
  index: number,
  timeoutMs: number,
): Promise<{ rect: CropRect; dpr: number; viewport: { width: number; height: number } }> {
  const expression = `(function(){
    var nodes = document.querySelectorAll(${JSON.stringify(selector)});
    if (!nodes.length) throw new Error('No element matches selector: ' + ${JSON.stringify(selector)});
    var el = nodes[${index}] || nodes[0];
    el.scrollIntoView({block: 'center', inline: 'center'});
    var r = el.getBoundingClientRect();
    return { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, dpr: window.devicePixelRatio || 1, viewport: { width: window.innerWidth, height: window.innerHeight } };
  })()`
  const result = await requestCommand('eval', { expression, tabId }, timeoutMs)
  const value = result.value as any
  if (!value || !value.rect) throw new Error('Failed to measure element rect')
  return value
}

async function getViewportInfoBridge(tabId: number, timeoutMs: number): Promise<{ dpr: number; viewport: { width: number; height: number } }> {
  const expression = `({ dpr: window.devicePixelRatio || 1, viewport: { width: window.innerWidth, height: window.innerHeight } })`
  const result = await requestCommand('eval', { expression, tabId }, timeoutMs)
  return result.value as any
}

/**
 * Crop a PNG file in-place using pure JS (pngjs). Cross-platform: no sips/imagemagick.
 * Returns the actual cropped rect (clamped to image bounds).
 */
async function cropPngFile(
  inputPath: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<{ x: number; y: number; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
  const buf = readFileSync(inputPath)
  const { PNG } = await import('pngjs')
  const src = PNG.sync.read(buf)

  let sx = Math.round(rect.x)
  let sy = Math.round(rect.y)
  let sw = Math.round(rect.width)
  let sh = Math.round(rect.height)
  if (sx < 0) { sw += sx; sx = 0 }
  if (sy < 0) { sh += sy; sy = 0 }
  if (sx + sw > src.width) sw = src.width - sx
  if (sy + sh > src.height) sh = src.height - sy
  if (sw <= 0 || sh <= 0) throw new Error(`Empty crop rect after clamp: ${JSON.stringify({ sx, sy, sw, sh })}`)

  const dst = new PNG({ width: sw, height: sh })
  // pngjs always exposes data as 4 bytes per pixel (RGBA) regardless of source colorType
  const bpp = 4
  for (let row = 0; row < sh; row++) {
    const srcStart = ((sy + row) * src.width + sx) * bpp
    const dstStart = row * sw * bpp
    src.data.copy(dst.data, dstStart, srcStart, srcStart + sw * bpp)
  }
  const out = PNG.sync.write(dst)
  writeFileSync(inputPath, out)
  return { x: sx, y: sy, width: sw, height: sh, sourceWidth: src.width, sourceHeight: src.height }
}

/**
 * Capture one visible-tab screenshot via the extension and return the buffer.
 * Pass extra fields to the extension's screenshot command via `extra`.
 */
async function captureVisibleTabBuffer(
  tabId: number | undefined,
  timeoutMs: number,
  extra: Record<string, unknown> = {},
): Promise<Buffer> {
  const payload: Record<string, unknown> = { ...extra }
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('screenshot', Object.keys(payload).length > 0 ? payload : undefined, timeoutMs)
  const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
  if (!dataUrl) throw new Error('Extension did not return screenshot data')
  return decodeImageDataUrl(dataUrl)
}

/**
 * Capture an entire tab (or a clip rect inside it) via Chrome DevTools Protocol.
 * Works for non-active tabs and even tabs in non-foreground windows without
 * changing user focus or switching tabs. Supports captureBeyondViewport so we
 * don't need to scroll-and-stitch.
 *
 * Selector measurement happens INSIDE the same chrome.debugger attach session
 * inside the extension, so DOM state is consistent with the capture (important
 * for virtualized lists / single-page apps).
 */
async function captureViaCdp(
  tabId: number,
  timeoutMs: number,
  opts: {
    clip?: { x: number; y: number; width: number; height: number; scale?: number }
    selector?: string
    selectorIndex?: number
    padding?: { top: number; right: number; bottom: number; left: number }
    captureBeyondViewport?: boolean
    reload?: boolean
    waitMs?: number
    restoreActive?: boolean
    fullPage?: boolean
  } = {},
): Promise<{ buf: Buffer; meta: any; clip: any }> {
  const payload: Record<string, unknown> = { tabId, mode: 'cdp' }
  if (opts.clip) payload.clip = { ...opts.clip, scale: opts.clip.scale ?? 1 }
  if (opts.selector) payload.selector = opts.selector
  if (Number.isInteger(opts.selectorIndex)) payload.selectorIndex = opts.selectorIndex
  if (opts.padding) payload.padding = opts.padding
  if (opts.captureBeyondViewport !== false) payload.captureBeyondViewport = true
  if (opts.reload) payload.reload = true
  if (typeof opts.waitMs === 'number') payload.waitMs = opts.waitMs
  if (opts.restoreActive === false) payload.restoreActive = false
  if (opts.fullPage) payload.fullPage = true
  const result = await requestCommand('screenshot', payload, timeoutMs)
  const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
  if (!dataUrl) throw new Error('Extension did not return screenshot data (cdp)')
  return {
    buf: decodeImageDataUrl(dataUrl),
    meta: (result as any).cdpMeta ?? null,
    clip: (result as any).cdpClip ?? null,
  }
}

/**
 * Programmatically scroll the page to a CSS Y offset and wait for layout to settle.
 */
async function scrollPageTo(tabId: number, scrollY: number, timeoutMs: number): Promise<{ scrollY: number; dpr: number; viewport: { width: number; height: number } }> {
  const expression = `(function(){
    window.scrollTo(0, ${Math.max(0, Math.round(scrollY))});
    return { scrollY: window.scrollY, dpr: window.devicePixelRatio || 1, viewport: { width: window.innerWidth, height: window.innerHeight } };
  })()`
  const result = await requestCommand('eval', { expression, tabId }, timeoutMs)
  return result.value as any
}

/**
 * Stitch multiple captureVisibleTab PNGs into a single tall image. Each segment is
 * pasted at its physical Y offset (scrollY * dpr). Overlapping rows are overwritten
 * by the later segment, which keeps things simple and works as long as we paste in
 * scroll order.
 */
async function stitchSegments(
  segments: Array<{ buf: Buffer; physicalY: number }>,
  totalHeight: number,
): Promise<Buffer> {
  const { PNG } = await import('pngjs')
  if (!segments.length) throw new Error('No segments to stitch')
  // Decode first to learn width
  const first = PNG.sync.read(segments[0].buf)
  const width = first.width
  const dst = new PNG({ width, height: Math.ceil(totalHeight) })

  for (const seg of segments) {
    const png = seg === segments[0] ? first : PNG.sync.read(seg.buf)
    const yOffset = Math.round(seg.physicalY)
    const drawHeight = Math.min(png.height, dst.height - yOffset)
    if (drawHeight <= 0) continue
    const drawWidth = Math.min(png.width, width)
    for (let row = 0; row < drawHeight; row++) {
      const srcStart = row * png.width * 4
      const dstStart = ((yOffset + row) * width) * 4
      png.data.copy(dst.data, dstStart, srcStart, srcStart + drawWidth * 4)
    }
  }
  return PNG.sync.write(dst)
}

async function screenshotTab(
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  options: ScreenshotOptions = {},
): Promise<JsonRecord> {
  // Mode matrix (v0.7.1):
  //   "dom"     — html2canvas-based DOM→image render (default when selector is
  //               provided). Works on background tabs, doesn't switch focus,
  //               no paint-layer issues, no stitching. REQUIRES the element to
  //               be reachable from the current DOM.
  //   "visible" — captureVisibleTab + scroll/stitch. Briefly focuses the tab.
  //   "cdp"     — chrome.debugger Page.captureScreenshot. Works in background
  //               but some GPU-composited layers (X.com avatars) render black.
  const { tabId, saveTo, selector, index, padding, rect, restoreActive = true, reload, waitMs, evalBefore } = options
  const mode = options.mode ?? (selector ? 'dom' : 'visible')

  // ----- DOM render path (html2canvas) -----
  if (mode === 'dom') {
    if (typeof tabId !== 'number') throw new Error('dom mode requires tabId')
    if (!selector) throw new Error('dom mode requires selector')
    const payload: Record<string, unknown> = {
      tabId,
      mode: 'dom',
      selector,
    }
    if (Number.isInteger(index)) payload.selectorIndex = index
    if (padding !== undefined) payload.padding = padding
    if (options.backgroundColor !== undefined) payload.backgroundColor = options.backgroundColor
    if (typeof options.scale === 'number') payload.scale = options.scale
    const result = await requestCommand('screenshot', payload, timeoutMs)
    const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
    if (!dataUrl) throw new Error('dom render: no dataUrl returned')
    const filePath = resolveScreenshotPath(saveTo, tabId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, decodeImageDataUrl(dataUrl))
    return {
      ok: true,
      via: 'extension-command-queue',
      tabId,
      savedTo: filePath,
      mode: 'dom',
      meta: (result as any).domMeta ?? null,
    }
  }

  // Simple path: no selector / rect → just full screenshot (CDP or visible)
  if (!selector && !rect) {
    if (mode === 'cdp') {
      if (typeof tabId !== 'number') throw new Error('cdp mode requires tabId')
      const { buf } = await captureViaCdp(tabId, timeoutMs, {
        captureBeyondViewport: true,
        reload,
        waitMs,
        restoreActive: (options as any).restoreActive !== false,
      })
      const filePath = resolveScreenshotPath(saveTo, tabId)
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, buf)
      return { ok: true, via: 'extension-command-queue', tabId, savedTo: filePath, mode: 'cdp' }
    }
    const buf = await captureVisibleTabBuffer(tabId, timeoutMs, restoreActive ? { restoreActive: true } : {})
    const filePath = resolveScreenshotPath(saveTo, tabId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, buf)
    return {
      ok: true,
      via: 'extension-command-queue',
      tabId: tabId ?? null,
      savedTo: filePath,
      mode: 'visible',
    }
  }

  if (typeof tabId !== 'number') throw new Error('selector/rect cropping requires tabId')

  const pad = normalizePadding(padding)

  // ----- CDP path: delegate measurement + capture to extension in one attach session -----
  // This avoids cross-context DOM races (e.g. virtualized lists where chrome.scripting
  // eval and Page.captureScreenshot would see different snapshots).
  //
  // Strategy: ask the extension to (a) optionally reload + wait, (b) measure the
  // selector inside the same chrome.debugger session, (c) capture the FULL page
  // beyond viewport (no clip — clip semantics with captureBeyondViewport are
  // unreliable for elements positioned at the very top of the viewport on some
  // sites). Then crop the result with pngjs using the measured rect, which is
  // guaranteed correct because measurement and capture see identical DOM.
  if (mode === 'cdp') {
    // Puppeteer-style: let CDP Page.captureScreenshot produce the clipped
    // element image directly. The extension briefly foregrounds the target
    // tab, measures the selector, runs captureScreenshot with clip, then
    // restores the original active tab.
    const cdpOpts: any = {
      captureBeyondViewport: true,
      padding: { top: pad.top, right: pad.right, bottom: pad.bottom, left: pad.left },
      restoreActive: (options as any).restoreActive !== false,
    }
    if (selector) {
      cdpOpts.selector = selector
      if (Number.isInteger(index)) cdpOpts.selectorIndex = index
    } else if (rect) {
      const r = normalizeRectInput(rect)
      if (!r) throw new Error('Invalid rect')
      cdpOpts.clip = { x: r.x - pad.left, y: r.y - pad.top, width: r.width + pad.left + pad.right, height: r.height + pad.top + pad.bottom, scale: 1 }
    }
    if (reload) cdpOpts.reload = true
    if (typeof waitMs === 'number') cdpOpts.waitMs = waitMs

    const { buf, meta, clip } = await captureViaCdp(tabId, timeoutMs, cdpOpts)
    const filePath = resolveScreenshotPath(saveTo, tabId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, buf)
    const { PNG } = await import('pngjs')
    const png = PNG.sync.read(buf)
    return {
      ok: true,
      via: 'extension-command-queue',
      tabId,
      savedTo: filePath,
      mode: 'cdp',
      cropRect: { x: Math.round((clip?.x ?? 0) * (meta?.dpr ?? 1)), y: Math.round((clip?.y ?? 0) * (meta?.dpr ?? 1)), width: png.width, height: png.height, dpr: meta?.dpr ?? 1 },
      meta,
    }
  }

  // ----- Visible path: bridge measures via chrome.scripting eval, then scroll-and-stitch -----
  // Step 1: locate target rect in absolute document coordinates
  let absRect: { x: number; y: number; width: number; height: number }
  let dpr: number
  let viewport: { width: number; height: number }
  let pageWidth: number
  let pageHeight: number

  if (selector) {
    const expression = `(function(){
      var nodes = document.querySelectorAll(${JSON.stringify(selector)});
      if (!nodes.length) throw new Error('No element matches selector: ' + ${JSON.stringify(selector)});
      var el = nodes[${Number.isInteger(index) ? Number(index) : 0}] || nodes[0];
      el.scrollIntoView({block: 'start', inline: 'start'});
      var r = el.getBoundingClientRect();
      return {
        rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
        dpr: window.devicePixelRatio || 1,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        page: { width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) },
        scrollY: window.scrollY,
      };
    })()`
    const result = await requestCommand('eval', { expression, tabId }, timeoutMs)
    const value = result.value as any
    if (!value || !value.rect) throw new Error('Failed to measure element rect')
    absRect = value.rect
    dpr = value.dpr
    viewport = value.viewport
    pageWidth = value.page.width
    pageHeight = value.page.height
  } else {
    const r = normalizeRectInput(rect)
    if (!r) throw new Error('Invalid rect')
    const info = await getViewportInfoBridge(tabId, timeoutMs)
    dpr = info.dpr
    viewport = info.viewport
    // Treat input rect as absolute document coordinates
    absRect = r
    const expression = `(function(){return { width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) }})()`
    const dim = await requestCommand('eval', { expression, tabId }, timeoutMs)
    const v = dim.value as any
    pageWidth = v.width
    pageHeight = v.height
  }

  // Apply padding in CSS pixels
  absRect = {
    x: absRect.x - pad.left,
    y: absRect.y - pad.top,
    width: absRect.width + pad.left + pad.right,
    height: absRect.height + pad.top + pad.bottom,
  }

  // ----- Visible path: scroll-and-stitch (note: this WILL switch to the target tab) -----
  // Step 2: capture in segments by scrolling the viewport across the target
  const segments: Array<{ buf: Buffer; physicalY: number }> = []
  const targetTop = Math.max(0, absRect.y)
  const targetBottom = Math.min(pageHeight, absRect.y + absRect.height)
  const segmentStep = Math.max(50, viewport.height - 16) // small overlap to avoid gaps
  let cursor = targetTop
  let safety = 0
  const seenY = new Set<number>()
  let firstSegmentExtra: Record<string, unknown> = {}
  // Pass restoreActive only on the LAST capture to avoid switching back mid-way.
  while (cursor < targetBottom && safety < 30) {
    safety++
    const scroll = await scrollPageTo(tabId, cursor, timeoutMs)
    const actualScrollY = scroll.scrollY
    if (seenY.has(actualScrollY) && segments.length > 0) {
      break
    }
    seenY.add(actualScrollY)
    await new Promise((r) => setTimeout(r, 280))
    const buf = await captureVisibleTabBuffer(tabId, timeoutMs, firstSegmentExtra)
    firstSegmentExtra = {} // already on the right tab after first capture
    segments.push({ buf, physicalY: actualScrollY * dpr })
    if (actualScrollY + viewport.height >= targetBottom) break
    cursor = actualScrollY + segmentStep
  }
  if (!segments.length) throw new Error('Failed to capture any segment')

  // Step 3: stitch segments into a full-document slice covering the target band,
  // then crop to absRect (in physical pixels).
  const physBottom = (absRect.y + absRect.height) * dpr + 16
  const stitched = await stitchSegments(segments, physBottom)

  // Step 4: write stitched buffer, then crop in-place
  const filePath = resolveScreenshotPath(saveTo, tabId)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, stitched)

  const cropped = await cropPngFile(filePath, {
    x: absRect.x * dpr,
    y: absRect.y * dpr,
    width: absRect.width * dpr,
    height: absRect.height * dpr,
  })

  // restoreActive: after stitching, ask extension to switch back to whatever
  // was active before. We do this by selecting the tracked original tab.
  // (We only know it inside the extension; bridge can't track that here, so we
  // delegate via a no-op screenshot call with restoreActive=true… simpler:
  // just expose a separate "selectTab" call to whatever the user remembered.
  // For now, surface the flag in the response and let the caller handle it.)

  return {
    ok: true,
    via: 'extension-command-queue',
    tabId: tabId,
    savedTo: filePath,
    cropRect: { ...cropped, dpr },
    segments: segments.length,
    mode: 'visible',
    restoreActiveRequested: restoreActive,
  }
}

async function clickInPage(
  selector: string,
  index = 0,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  tabId?: number,
): Promise<JsonRecord> {
  if (!selector) throw new Error('Missing selector')
  const payload: Record<string, unknown> = { selector, index }
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('click', payload, timeoutMs)
  return { ok: true, via: 'extension-command-queue', commandId: result.id, tabId: result.tabId ?? null, tag: result.tag, text: result.text }
}

async function inputInPage(
  selector: string,
  value: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  tabId?: number,
): Promise<JsonRecord> {
  if (!selector) throw new Error('Missing selector')
  const payload: Record<string, unknown> = { selector, value }
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('input', payload, timeoutMs)
  return { ok: true, via: 'extension-command-queue', commandId: result.id, tabId: result.tabId ?? null, value: result.value }
}

async function getElementsInPage(selector: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, tabId?: number): Promise<JsonRecord> {
  const payload: Record<string, unknown> = { selector }
  if (typeof tabId === 'number') payload.tabId = tabId
  const result = await requestCommand('getElements', payload, timeoutMs)
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
      return getPageContext(body.timeoutMs, body.fields, body.maxLinks, typeof body.tabId === 'number' ? body.tabId : undefined)
    case 'getAccessibilityTree':
      return getAccessibilityTree(body.compact !== false, body.maxDepth ?? 0, body.timeoutMs, typeof body.tabId === 'number' ? body.tabId : undefined)
    case 'listTabs':
      return listTabs(body.query as string | undefined, body.limit as number | undefined, body.maxTitleLength as number | undefined, body.timeoutMs)
    case 'selectTab':
      return selectTab(body.tabId, body.timeoutMs)
    case 'closeTab': {
      const tabId = normalizeTabId(body.tabId)
      const result = await requestCommand('closeTabs', { tabIds: [tabId] }, body.timeoutMs)
      return result
    }
    case 'closeTabs': {
      const tabIds = normalizeTabIds(body.tabIds)
      const result = await requestCommand('closeTabs', { tabIds }, body.timeoutMs)
      return result
    }
    case 'screenshot':
      return screenshotTab(body.timeoutMs, {
        tabId: typeof body.tabId === 'number' ? body.tabId : undefined,
        saveTo: body.saveTo,
        selector: typeof body.selector === 'string' ? body.selector : undefined,
        index: typeof body.index === 'number' ? body.index : undefined,
        padding: body.padding,
        rect: body.rect,
        mode: body.mode === 'cdp' || body.mode === 'visible' || body.mode === 'dom' ? body.mode : undefined,
        restoreActive: body.restoreActive !== false,
        reload: body.reload === true,
        waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined,
        evalBefore: typeof body.evalBefore === 'string' ? body.evalBefore : undefined,
        deviceMetrics: body.deviceMetrics ?? undefined,
        forceImgOpacity: body.forceImgOpacity !== false,
        backgroundColor: body.backgroundColor,
        scale: typeof body.scale === 'number' ? body.scale : undefined,
      })
    case 'eval':
      return evalInPage(body.expression, body.timeoutMs, typeof body.tabId === 'number' ? body.tabId : undefined)
    case 'click':
      if (!body.selector) throw new Error('Missing selector')
      return clickInPage(body.selector, body.index, body.timeoutMs, typeof body.tabId === 'number' ? body.tabId : undefined)
    case 'input':
      if (!body.selector) throw new Error('Missing selector')
      return inputInPage(body.selector, body.value ?? '', body.timeoutMs, typeof body.tabId === 'number' ? body.tabId : undefined)
    case 'getElements':
      return getElementsInPage(body.selector ?? '*', body.timeoutMs, typeof body.tabId === 'number' ? body.tabId : undefined)
    case 'reloadExtension': {
      const result = await requestCommand('reloadExtension', undefined, body.timeoutMs ?? 5000)
      return { ok: true, via: 'extension-command-queue', commandId: result.id, scheduled: true }
    }
    default:
      throw new BadRequestError(`Unsupported action: ${String(action)}`)
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
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof BadRequestError ? error.status : 500
      return json({ ok: false, error: message }, status)
    }
  },
})

console.log(`browser-gui-bridge listening on http://127.0.0.1:${server.port}`)
