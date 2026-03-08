const BRIDGE_BASE = 'http://127.0.0.1:4318'
const POLL_ALARM = 'zero-poll-command'

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.05 })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.05 })
})

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

async function extractPage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      url: location.href,
      selectionText: window.getSelection()?.toString() ?? '',
      bodyText: document.body?.innerText ?? '',
      html: document.documentElement?.outerHTML ?? '',
      scrollY: window.scrollY,
    }),
  })
  return result?.result
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
      }
    }

    case 'getPageText': {
      const tab = await getActiveTab()
      const page = await extractPage(tab.id)
      await postPageContext(page)
      return {
        id: command.id,
        ok: true,
        type: command.type,
        url: page.url,
        title: page.title,
        bodyText: page.bodyText,
        html: page.html,
        scrollY: page.scrollY,
      }
    }

    case 'scrollBy': {
      const tab = await getActiveTab()
      const offsetY = Number(command.payload?.y ?? 0)
      const page = await scrollByOnPage(tab.id, offsetY)
      return {
        id: command.id,
        ok: true,
        type: command.type,
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
