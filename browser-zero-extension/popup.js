const statusEl = document.getElementById('status')
const sendBtn = document.getElementById('send')

function setStatus(message) {
  if (statusEl) statusEl.textContent = message
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  return tab
}

async function extractPage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selectionText = window.getSelection()?.toString() ?? ''
      const bodyText = document.body?.innerText ?? ''
      const html = document.documentElement?.outerHTML ?? ''
      return {
        source: 'browser-extension',
        title: document.title,
        url: location.href,
        selectionText,
        bodyText,
        html,
        timestamp: new Date().toISOString(),
      }
    },
  })

  return result?.result
}

async function sendPageContext(payload) {
  const response = await fetch('http://127.0.0.1:4318/page-context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json()
}

sendBtn?.addEventListener('click', async () => {
  try {
    setStatus('Extracting page...')
    const tab = await getActiveTab()
    const payload = await extractPage(tab.id)

    setStatus('Sending to local Zero bridge...')
    const result = await sendPageContext(payload)

    setStatus(`Saved to:\n${result.savedTo}`)
  } catch (error) {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
  }
})
