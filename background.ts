type WebSyncTarget = "chatgpt" | "deepseek"

interface WebSyncStartMessage {
  type: "web_sync_start"
  requestId: string
  target: WebSyncTarget
  prompt: string
  primedKey?: string
  markPrimed?: boolean
  stream?: boolean
  model?: string
}

const requestPorts = new Map<string, chrome.runtime.Port>()
const requestTabs = new Map<string, number>()
const WEB_SYNC_PRIMED_STORAGE_KEY = "overleafgpt_web_sync_primed_keys"

const TARGET_URLS: Record<WebSyncTarget, string[]> = {
  chatgpt: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  deepseek: ["https://chat.deepseek.com/*"]
}

const TARGET_HOME: Record<WebSyncTarget, string> = {
  chatgpt: "https://chatgpt.com/",
  deepseek: "https://chat.deepseek.com/"
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "overleafgpt-web-sync") return

  port.onMessage.addListener(async (message: WebSyncStartMessage | { type: string; requestId: string }) => {
    if (!message?.requestId) return

    if (message.type === "web_sync_abort") {
      const tabId = requestTabs.get(message.requestId)
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "overleafgpt_web_sync_abort",
          requestId: message.requestId
        }).catch(() => undefined)
      }
      requestPorts.delete(message.requestId)
      requestTabs.delete(message.requestId)
      return
    }

    if (!isWebSyncStartMessage(message)) return

    requestPorts.set(message.requestId, port)

    try {
      const tab = await findWebSyncTab(message.target)
      if (!tab?.id) {
        throw new Error(
          `未检测到已打开的 ${getTargetLabel(message.target)} 网页。请先打开 ${TARGET_HOME[message.target]} 并登录，然后重试。`
        )
      }
      requestTabs.set(message.requestId, tab.id)

      await chrome.tabs.sendMessage(tab.id, {
        type: "overleafgpt_web_sync_run",
        requestId: message.requestId,
        target: message.target,
        prompt: message.prompt,
        model: message.model
      })

      if (message.markPrimed && message.primedKey) {
        await markWebSyncPrimed(message.primedKey)
      }
    } catch (error) {
      port.postMessage({
        type: "web_sync_error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : "WebSync bridge failed"
      })
      requestPorts.delete(message.requestId)
      requestTabs.delete(message.requestId)
    }
  })

  port.onDisconnect.addListener(() => {
    for (const [requestId, requestPort] of requestPorts.entries()) {
      if (requestPort === port) {
        const tabId = requestTabs.get(requestId)
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "overleafgpt_web_sync_abort",
            requestId
          }).catch(() => undefined)
        }
        requestPorts.delete(requestId)
        requestTabs.delete(requestId)
      }
    }
  })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "overleafgpt_web_sync_delta" || message?.type === "overleafgpt_web_sync_done" || message?.type === "overleafgpt_web_sync_error") {
    const port = requestPorts.get(message.requestId)
    if (port) {
      port.postMessage({
        type: message.type.replace("overleafgpt_", ""),
        requestId: message.requestId,
        delta: message.delta,
        error: message.error
      })
      if (message.type !== "overleafgpt_web_sync_delta") {
        requestPorts.delete(message.requestId)
        requestTabs.delete(message.requestId)
      }
    }
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "overleafgpt_web_sync_check") {
    findWebSyncTab(message.target)
      .then(tab => sendResponse({ ok: true, connected: !!tab?.id }))
      .catch(error => sendResponse({
        ok: false,
        connected: false,
        error: error instanceof Error ? error.message : "WebSync check failed"
      }))
    return true
  }

  if (message?.type === "overleafgpt_web_sync_open") {
    chrome.tabs.create({ url: TARGET_HOME[message.target as WebSyncTarget] })
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to open WebChat page"
      }))
    return true
  }

  if (message?.type === "overleafgpt_web_sync_is_primed") {
    isWebSyncPrimed(message.primedKey)
      .then(primed => sendResponse({ ok: true, primed }))
      .catch(error => sendResponse({
        ok: false,
        primed: false,
        error: error instanceof Error ? error.message : "Failed to read WebSync role state"
      }))
    return true
  }

  if (message?.type === "overleafgpt_web_sync_reset_role") {
    resetWebSyncPrimed(message.primedKey)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to reset WebSync role state"
      }))
    return true
  }

  return false
})

async function findWebSyncTab(target: WebSyncTarget): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: TARGET_URLS[target] })
  return tabs.find(tab => tab.active) || tabs[0]
}

function getTargetLabel(target: WebSyncTarget): string {
  return target === "deepseek" ? "DeepSeek" : "ChatGPT"
}

function isWebSyncStartMessage(message: WebSyncStartMessage | { type: string; requestId: string }): message is WebSyncStartMessage {
  return message.type === "web_sync_start" && (message as WebSyncStartMessage).target !== undefined
}

async function getWebSyncPrimedKeys(): Promise<string[]> {
  const data = await chrome.storage.local.get(WEB_SYNC_PRIMED_STORAGE_KEY)
  const keys = data[WEB_SYNC_PRIMED_STORAGE_KEY]
  return Array.isArray(keys) ? keys.filter(key => typeof key === "string") : []
}

async function setWebSyncPrimedKeys(keys: string[]) {
  await chrome.storage.local.set({
    [WEB_SYNC_PRIMED_STORAGE_KEY]: Array.from(new Set(keys))
  })
}

async function isWebSyncPrimed(primedKey: string): Promise<boolean> {
  if (!primedKey) return false
  const keys = await getWebSyncPrimedKeys()
  return keys.includes(primedKey)
}

async function markWebSyncPrimed(primedKey: string) {
  if (!primedKey) return
  const keys = await getWebSyncPrimedKeys()
  if (!keys.includes(primedKey)) {
    await setWebSyncPrimedKeys([...keys, primedKey])
  }
}

async function resetWebSyncPrimed(primedKey?: string) {
  if (!primedKey) {
    await setWebSyncPrimedKeys([])
    return
  }

  const keys = await getWebSyncPrimedKeys()
  await setWebSyncPrimedKeys(keys.filter(key => key !== primedKey))
}
