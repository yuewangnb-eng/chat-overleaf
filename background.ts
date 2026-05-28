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
const WEB_SYNC_DEBUG_STORAGE_KEY = "overleafgpt_web_sync_debug_log"

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
      await logWebSyncDebug(message.requestId, "background_abort_requested")
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

    if (message.type === "web_sync_ping") {
      port.postMessage({
        type: "web_sync_pong",
        requestId: message.requestId
      })
      return
    }

    if (!isWebSyncStartMessage(message)) return

    requestPorts.set(message.requestId, port)
    await logWebSyncDebug(message.requestId, "background_start", {
      target: message.target
    })

    try {
      const tab = await findWebSyncTab(message.target)
      if (!tab?.id) {
        throw new Error(
          `未检测到已打开的 ${getTargetLabel(message.target)} 网页。请先打开 ${TARGET_HOME[message.target]} 并登录，然后重试。`
        )
      }
      requestTabs.set(message.requestId, tab.id)
      await logWebSyncDebug(message.requestId, "background_tab_found", {
        tabId: tab.id,
        active: tab.active,
        url: tab.url
      })
      await injectWebSyncNetworkBridge(tab.id, message.requestId)

      await chrome.tabs.sendMessage(tab.id, {
        type: "overleafgpt_web_sync_run",
        requestId: message.requestId,
        target: message.target,
        prompt: message.prompt,
        model: message.model
      })
      await logWebSyncDebug(message.requestId, "background_sent_to_content")

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
  if (isWebSyncBridgeMessage(message)) {
    const port = requestPorts.get(message.requestId)
    logWebSyncDebug(message.requestId, "background_received_from_content", {
      type: message.type,
      deltaLength: typeof message.delta === "string" ? message.delta.length : 0,
      replace: message.replace === true,
      phase: message.phase
    })
    if (port) {
      port.postMessage({
        type: message.type.replace("overleafgpt_", ""),
        requestId: message.requestId,
        delta: message.delta,
        replace: message.replace,
        phase: message.phase,
        error: message.error
      })
      if (message.type !== "overleafgpt_web_sync_delta" && message.type !== "overleafgpt_web_sync_progress") {
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

async function injectWebSyncNetworkBridge(tabId: number, requestId: string) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: webSyncNetworkBridgeSource
    })
    await logWebSyncDebug(requestId, "background_network_bridge_injected")
  } catch (error) {
    await logWebSyncDebug(requestId, "background_network_bridge_inject_failed", {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function webSyncNetworkBridgeSource() {
  const marker = "__overleafgptWebSyncNetworkPatched"
  const patchVersion = 1
  if ((window as any)[marker] && (window as any)[marker] >= patchVersion) return
  ;(window as any)[marker] = patchVersion

  const originalFetch = window.fetch
  let activeStreamCount = 0

  const postPageEvent = (event: Record<string, unknown>) => {
    try {
      window.postMessage(event, "*")
    } catch {
      // Keep page execution isolated from bridge errors.
    }
  }

  const isConversationRequest = (url: string, method: string) => {
    if (method !== "POST") return false
    const host = window.location.hostname
    if (host === "chatgpt.com" || host === "chat.openai.com") {
      return /\/backend-api\/(?:f\/)?conversation\b/.test(url) ||
        /\/backend-anon\/conversation\b/.test(url)
    }
    if (host === "chat.deepseek.com") {
      return /\/api\/v0\/chat\/completion\b/.test(url)
    }
    return false
  }

  const safeJsonParse = (value: string) => {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  const hasMeaningfulText = (value: string) => {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
    if (!normalized) return false
    if (normalized === "thinking" || normalized === "thinking..." || normalized === "stopped thinking") return false
    if (normalized === "finished_successfully" || normalized === "finished successfully") return false
    if (normalized === "done" || normalized === "complete" || normalized === "completed") return false
    if (/^thought for .+$/.test(normalized)) return false
    if (/^reading\s+documents?\.?$/.test(normalized)) return false
    if (/^searching(\s+the\s+web)?\.?$/.test(normalized)) return false
    return true
  }

  const isNonAnswerText = (value: string) => {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
    return normalized === "finished_successfully" ||
      normalized === "finished successfully" ||
      normalized === "done" ||
      normalized === "complete" ||
      normalized === "completed"
  }

  const mergeStreamText = (previous: string, next: string) => {
    const prev = String(previous || "")
    const upcoming = String(next || "")
    if (!upcoming) return prev
    if (!prev) return upcoming
    if (upcoming.startsWith(prev)) return upcoming
    if (prev.startsWith(upcoming)) return prev

    const maxOverlap = Math.min(prev.length, upcoming.length)
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      if (prev.slice(-overlap) === upcoming.slice(0, overlap)) {
        return prev + upcoming.slice(overlap)
      }
    }
    return prev + upcoming
  }

  const parseChatGptPayload = (parsed: any, lastText: string, lastThinking: string) => {
    const compactPatch = parseChatGptCompactPatch(parsed, lastText)
    if (compactPatch) return compactPatch

    const message = parsed?.message
    if (!message || message.author?.role !== "assistant") return null

    const contentType = message.content?.content_type
    if (contentType === "system_error" || contentType === "title_generation" || contentType === "conversation_title") {
      return null
    }

    let text = lastText
    let thinking = lastThinking
    const parts = message.content?.parts
    if (Array.isArray(parts)) {
      const partText = parts.filter((part: unknown) => typeof part === "string").join("")
      if (hasMeaningfulText(partText) && partText !== lastText) {
        text = partText
      }
    }

    const thinkingText = message.metadata?.thinking_text ||
      message.metadata?.reasoning_text ||
      message.content?.thinking ||
      ""
    if (thinkingText && thinkingText !== lastThinking) {
      thinking = thinkingText
    }

    return text !== lastText || thinking !== lastThinking
      ? { text, thinking }
      : null
  }

  const parseChatGptCompactPatch = (parsed: any, lastText: string) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (!("v" in parsed)) return null

    const path = typeof parsed.p === "string" ? parsed.p.toLowerCase() : ""
    const op = typeof parsed.o === "string" ? parsed.o.toLowerCase() : ""
    const value = parsed.v

    if (!("p" in parsed) && !("o" in parsed) && typeof value === "string") {
      if (isNonAnswerText(value)) return null
      const text = mergeStreamText(lastText, value)
      return text !== lastText ? { text, thinking: "" } : null
    }

    const looksLikeAssistantTextPath =
      path.includes("message") ||
      path.includes("content") ||
      path.includes("part") ||
      path.includes("text")
    const looksLikeTextOperation =
      op.includes("append") ||
      op.includes("add") ||
      op.includes("replace") ||
      op.includes("patch") ||
      op.includes("set")

    if (!looksLikeAssistantTextPath && !looksLikeTextOperation) return null

    const extracted = extractTextFromCompactValue(value)
    if (!hasMeaningfulText(extracted)) return null

    const text = op.includes("append") || op.includes("add") || op.includes("patch")
      ? mergeStreamText(lastText, extracted)
      : extracted

    return text !== lastText ? { text, thinking: "" } : null
  }

  const extractTextFromCompactValue = (value: any, depth = 0): string => {
    if (depth > 4 || value == null) return ""
    if (typeof value === "string") return isNonAnswerText(value) ? "" : value
    if (typeof value === "number" || typeof value === "boolean") return ""
    if (Array.isArray(value)) {
      return value.map((item) => extractTextFromCompactValue(item, depth + 1)).filter(Boolean).join("")
    }
    if (typeof value !== "object") return ""

    const preferredKeys = ["text", "content", "parts", "message", "delta", "v", "value"]
    const chunks: string[] = []
    for (const key of preferredKeys) {
      if (key in value) {
        const next = extractTextFromCompactValue(value[key], depth + 1)
        if (next) chunks.push(next)
      }
    }
    return chunks.join("")
  }

  const parseDeepSeekPayload = (parsed: any, lastText: string, lastThinking: string) => {
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null
    const delta = choice?.delta || {}
    let text = lastText
    let thinking = lastThinking

    const contentDelta = typeof delta.content === "string"
      ? delta.content
      : typeof choice?.text === "string"
        ? choice.text
        : typeof choice?.message?.content === "string"
          ? choice.message.content
          : typeof parsed?.output_text === "string"
            ? parsed.output_text
            : ""
    if (contentDelta) {
      text = typeof delta.content === "string" ? lastText + contentDelta : contentDelta
    }

    const thinkingDelta = typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof choice?.reasoning_content === "string"
        ? choice.reasoning_content
        : typeof choice?.message?.reasoning_content === "string"
          ? choice.message.reasoning_content
          : ""
    if (thinkingDelta) {
      thinking = typeof delta.reasoning_content === "string" ? lastThinking + thinkingDelta : thinkingDelta
    }

    return text !== lastText || thinking !== lastThinking
      ? { text, thinking }
      : null
  }

  const parsePayload = (parsed: any, lastText: string, lastThinking: string) => {
    const host = window.location.hostname
    if (host === "chatgpt.com" || host === "chat.openai.com") {
      return parseChatGptPayload(parsed, lastText, lastThinking)
    }
    if (host === "chat.deepseek.com") {
      return parseDeepSeekPayload(parsed, lastText, lastThinking)
    }
    return null
  }

  const isStreamCompletePayload = (parsed: any) => {
    if (!parsed || typeof parsed !== "object") return false
    if (parsed.type === "message_stream_complete") return true
    return false
  }

  const summarizeSsePayload = (parsed: any, rawLength: number) => {
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 16)
      : []
    const message = parsed?.message
    const content = message?.content
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null
    const delta = choice?.delta || parsed?.delta || null
    return {
      rawLength,
      keys,
      type: typeof parsed?.type === "string" ? parsed.type : null,
      event: typeof parsed?.event === "string" ? parsed.event : null,
      messageRole: typeof message?.author?.role === "string" ? message.author.role : null,
      contentType: typeof content?.content_type === "string" ? content.content_type : null,
      partsCount: Array.isArray(content?.parts) ? content.parts.length : null,
      choicesCount: Array.isArray(parsed?.choices) ? parsed.choices.length : null,
      deltaKeys: delta && typeof delta === "object" ? Object.keys(delta).slice(0, 16) : [],
      compactPath: typeof parsed?.p === "string" ? parsed.p : null,
      compactOp: typeof parsed?.o === "string" ? parsed.o : null,
      compactValueType: Array.isArray(parsed?.v) ? "array" : typeof parsed?.v,
      hasTextField: typeof parsed?.text === "string",
      hasContentField: typeof parsed?.content === "string",
      hasOutputTextField: typeof parsed?.output_text === "string"
    }
  }

  const processSseResponse = async (response: Response) => {
    const body = response?.body
    if (!body) return

    activeStreamCount += 1
    postPageEvent({ type: "OVERLEAFGPT_WEB_SYNC_STREAM_START" })
    postPageEvent({ type: "OVERLEAFGPT_WEB_SYNC_STREAM_STATE", activeStreamCount })

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let lastText = ""
    let lastThinking = ""
    let debugPayloadCount = 0

    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break

        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(line.startsWith("data: ") ? 6 : 5).trim()
          if (!data) continue

          if (data === "[DONE]") {
            postPageEvent({
              type: "OVERLEAFGPT_WEB_SYNC_SSE",
              text: lastText,
              thinking: lastThinking || null,
              done: true,
              activeStreamCount
            })
            return
          }

          const parsed = safeJsonParse(data)
          if (parsed == null) continue

          if (isStreamCompletePayload(parsed)) {
            if (hasMeaningfulText(lastText)) {
              postPageEvent({
                type: "OVERLEAFGPT_WEB_SYNC_SSE",
                text: lastText,
                thinking: lastThinking || null,
                done: true,
                activeStreamCount
              })
            }
            continue
          }

          const result = parsePayload(parsed, lastText, lastThinking)
          if (!result) {
            if (debugPayloadCount < 12) {
              debugPayloadCount += 1
              postPageEvent({
                type: "OVERLEAFGPT_WEB_SYNC_SSE_DEBUG",
                summary: summarizeSsePayload(parsed, data.length)
              })
            }
            continue
          }

          lastText = mergeStreamText(lastText, result.text)
          lastThinking = mergeStreamText(lastThinking, result.thinking)
          postPageEvent({
            type: "OVERLEAFGPT_WEB_SYNC_SSE",
            text: lastText,
            thinking: lastThinking || null,
            done: false,
            activeStreamCount
          })
        }
      }

      if (hasMeaningfulText(lastText)) {
        postPageEvent({
          type: "OVERLEAFGPT_WEB_SYNC_SSE",
          text: lastText,
          thinking: lastThinking || null,
          done: true,
          activeStreamCount
        })
      }
    } finally {
      activeStreamCount = Math.max(0, activeStreamCount - 1)
      postPageEvent({ type: "OVERLEAFGPT_WEB_SYNC_STREAM_STATE", activeStreamCount })
      try {
        reader.releaseLock()
      } catch {
        // Already released.
      }
    }
  }

  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const response = await originalFetch.apply(this, args)

    try {
      const url = args[0] instanceof Request ? args[0].url : String(args[0] || "")
      const method = ((args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET").toUpperCase()
      if (isConversationRequest(url, method)) {
        processSseResponse(response.clone()).catch(() => undefined)
      }
    } catch {
      // Keep page fetch intact.
    }

    return response
  }
}

function getTargetLabel(target: WebSyncTarget): string {
  return target === "deepseek" ? "DeepSeek" : "ChatGPT"
}

function isWebSyncStartMessage(message: WebSyncStartMessage | { type: string; requestId: string }): message is WebSyncStartMessage {
  return message.type === "web_sync_start" && (message as WebSyncStartMessage).target !== undefined
}

function isWebSyncBridgeMessage(message: any): message is {
  type: "overleafgpt_web_sync_delta" | "overleafgpt_web_sync_done" | "overleafgpt_web_sync_error" | "overleafgpt_web_sync_progress"
  requestId: string
  delta?: string
  replace?: boolean
  phase?: string
  error?: string
} {
  return Boolean(message?.requestId) && (
    message.type === "overleafgpt_web_sync_delta" ||
    message.type === "overleafgpt_web_sync_done" ||
    message.type === "overleafgpt_web_sync_error" ||
    message.type === "overleafgpt_web_sync_progress"
  )
}

async function logWebSyncDebug(requestId: string, event: string, data: Record<string, unknown> = {}) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      source: "background",
      requestId,
      event,
      ...data
    }
    const stored = await chrome.storage.local.get(WEB_SYNC_DEBUG_STORAGE_KEY)
    const current = Array.isArray(stored[WEB_SYNC_DEBUG_STORAGE_KEY])
      ? stored[WEB_SYNC_DEBUG_STORAGE_KEY]
      : []
    await chrome.storage.local.set({
      [WEB_SYNC_DEBUG_STORAGE_KEY]: [...current.slice(-199), entry]
    })
  } catch {
    // Debug logging must never break WebSync.
  }
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
