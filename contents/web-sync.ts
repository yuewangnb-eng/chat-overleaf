import type { PlasmoCSConfig } from "plasmo"

type WebSyncTarget = "chatgpt" | "deepseek"

interface WebSyncRunMessage {
  type: "overleafgpt_web_sync_run"
  requestId: string
  target: WebSyncTarget
  prompt: string
  model?: string
}

interface WebSyncAbortMessage {
  type: "overleafgpt_web_sync_abort"
  requestId: string
}

export const config: PlasmoCSConfig = {
  matches: [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://chat.deepseek.com/*"
  ],
  run_at: "document_idle"
}

const activeRequests = new Map<string, AbortController>()

chrome.runtime.onMessage.addListener((message: WebSyncRunMessage | WebSyncAbortMessage, _sender, sendResponse) => {
  if (message?.type === "overleafgpt_web_sync_abort") {
    activeRequests.get(message.requestId)?.abort()
    findStopButton()?.click()
    sendResponse({ ok: true })
    return true
  }

  if (message?.type !== "overleafgpt_web_sync_run") return false

  const controller = new AbortController()
  activeRequests.set(message.requestId, controller)

  runWebSync(message, controller.signal)
    .catch(error => sendBridgeMessage("overleafgpt_web_sync_error", message.requestId, {
      error: error instanceof Error ? error.message : "WebSync request failed"
    }))
    .finally(() => activeRequests.delete(message.requestId))

  sendResponse({ ok: true })
  return true
})

async function runWebSync(message: WebSyncRunMessage, signal: AbortSignal) {
  await waitForDocumentReady(signal)

  const beforeCount = getAssistantNodes(message.target).length
  await fillComposer(message.prompt, signal)
  await clickSend(message.target, beforeCount, signal)
  await watchAssistantResponse(message.requestId, message.target, beforeCount, signal)
}

async function fillComposer(prompt: string, signal: AbortSignal) {
  const composer = await waitForElement<HTMLElement>(() => findComposer(), 15000, signal)
  composer.focus()

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set
    setter?.call(composer, prompt)
    composer.dispatchEvent(new Event("input", { bubbles: true }))
    composer.dispatchEvent(new Event("change", { bubbles: true }))
    return
  }

  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(composer)
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.execCommand("insertText", false, prompt)
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: prompt
  }))
}

async function clickSend(target: WebSyncTarget, beforeCount: number, signal: AbortSignal) {
  const button = await waitForElement<HTMLButtonElement>(() => findSendButton(target), 15000, signal)
  dispatchRealisticClick(button)

  const submitted = await waitForSubmission(target, beforeCount, 2500, signal)
  if (submitted) return

  const form = findComposer()?.closest("form") as HTMLFormElement | null
  if (form?.requestSubmit) {
    form.requestSubmit()
  } else if (form) {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))
  }

  if (await waitForSubmission(target, beforeCount, 2500, signal)) return

  throw new Error("WebSync filled the WebChat input, but could not trigger send. Please click the send button once in the WebChat tab, then retry.")
}

async function watchAssistantResponse(
  requestId: string,
  target: WebSyncTarget,
  beforeCount: number,
  signal: AbortSignal
) {
  let lastText = ""
  let latestNode: HTMLElement | undefined
  let stableTicks = 0
  const startedAt = Date.now()
  const minStableTicks = 4
  const timeoutMs = 180000

  while (!signal.aborted) {
    await sleep(500, signal)

    const nodes = getAssistantNodes(target)
    if (nodes.length <= beforeCount) {
      continue
    }

    const node = nodes[nodes.length - 1]
    latestNode = node
    const generating = isGenerating()
    const text = getAssistantText(node, target, {
      closeCodeFences: false
    })

    if (text && text !== lastText) {
      lastText = text
      stableTicks = 0
      continue
    }

    if (lastText) {
      stableTicks += 1
    }

    if (lastText && stableTicks >= minStableTicks && !generating) {
      const finalText = getAssistantText(latestNode, target, {
        closeCodeFences: true
      }) || lastText
      sendBridgeMessage("overleafgpt_web_sync_delta", requestId, { delta: finalText })
      sendBridgeMessage("overleafgpt_web_sync_done", requestId)
      return
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("WebSync request timed out while waiting for the web chat response.")
    }
  }

  throw new Error("WebSync request aborted.")
}

function findComposer(): HTMLElement | null {
  const selectors = [
    "#prompt-textarea",
    "textarea[data-testid='prompt-textarea']",
    "textarea[placeholder]",
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true']"
  ]

  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(element => isVisible(element) && !element.closest("[aria-hidden='true']"))
    const candidate = candidates[candidates.length - 1]
    if (candidate) return candidate
  }

  return null
}

function findSendButton(target: WebSyncTarget): HTMLButtonElement | null {
  const composer = findComposer()
  const scope = composer?.closest("form") || composer?.parentElement?.parentElement?.parentElement || document.body

  const exactSelectors = [
    "button[data-testid='send-button']",
    "button[aria-label*='Send']",
    "button[aria-label*='send']",
    "button[type='submit']"
  ]

  for (const selector of exactSelectors) {
    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>(selector))
      .find(isEnabledButton)
    if (button) return button
  }

  if (target === "chatgpt") {
    return null
  }

  const enabledButtons = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .filter(isEnabledButton)
    .filter(button => !isStopLikeButton(button) && !isAttachmentLikeButton(button))
    .filter(button => !isVoiceLikeButton(button))

  return enabledButtons[enabledButtons.length - 1] || null
}

function dispatchRealisticClick(button: HTMLButtonElement) {
  for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    button.dispatchEvent(new MouseEvent(eventName, {
      bubbles: true,
      cancelable: true,
      view: window
    }))
  }
}

async function waitForSubmission(
  target: WebSyncTarget,
  beforeCount: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<boolean> {
  const startedAt = Date.now()

  while (!signal.aborted && Date.now() - startedAt < timeoutMs) {
    if (isGenerating()) return true
    if (getAssistantNodes(target).length > beforeCount) return true
    if (!getComposerText()) return true
    await sleep(150, signal)
  }

  return false
}

function getComposerText(): string {
  const composer = findComposer()
  if (!composer) return ""
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return composer.value.trim()
  }
  return (composer.textContent || "").trim()
}

function isEnabledButton(button: HTMLButtonElement): boolean {
  return isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true"
}

function isStopLikeButton(button: HTMLButtonElement): boolean {
  const label = `${button.getAttribute("aria-label") || ""} ${button.dataset.testid || ""}`.toLowerCase()
  return label.includes("stop")
}

function isAttachmentLikeButton(button: HTMLButtonElement): boolean {
  const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""} ${button.dataset.testid || ""}`.toLowerCase()
  return label.includes("attach") || label.includes("upload") || label.includes("file") || label.includes("voice") || label.includes("mic")
}

function isVoiceLikeButton(button: HTMLButtonElement): boolean {
  const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""} ${button.dataset.testid || ""} ${button.className || ""}`.toLowerCase()
  return label.includes("voice") ||
    label.includes("mic") ||
    label.includes("microphone") ||
    label.includes("audio") ||
    label.includes("speech") ||
    label.includes("dictation") ||
    label.includes("record")
}

function findStopButton(): HTMLButtonElement | null {
  const selectors = [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']"
  ]

  for (const selector of selectors) {
    const button = document.querySelector<HTMLButtonElement>(selector)
    if (button && isVisible(button) && !button.disabled) return button
  }

  return null
}

function getAssistantNodes(target: WebSyncTarget): HTMLElement[] {
  const selectors = target === "chatgpt"
    ? [
        "[data-message-author-role='assistant']"
      ]
    : [
        "[data-role='assistant']",
        "[class*='assistant']",
        "[class*='ds-markdown']",
        "[class*='markdown']"
      ]

  const seen = new Set<HTMLElement>()
  const nodes: HTMLElement[] = []

  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (!seen.has(element) && isVisible(element) && cleanAssistantText(element.textContent || "")) {
        seen.add(element)
        nodes.push(element)
      }
    }
  }

  return nodes
}

function getAssistantText(
  node: HTMLElement | undefined,
  target: WebSyncTarget,
  options: { closeCodeFences: boolean }
): string {
  if (!node) return ""

  const contentSelectors = target === "chatgpt"
    ? [
        "[data-message-author-role='assistant'] .markdown",
        "[data-message-author-role='assistant'] .prose",
        ".markdown",
        ".prose"
      ]
    : [
        "[class*='ds-markdown']",
        "[class*='markdown']"
      ]

  for (const selector of contentSelectors) {
    const contentNode = node.matches(selector)
      ? node
      : node.querySelector<HTMLElement>(selector)
    const text = cleanAssistantText(readMarkdown(contentNode, options))
    if (text) return text
  }

  return cleanAssistantText(readMarkdown(node, options))
}

function readMarkdown(node: HTMLElement | null | undefined, options: { closeCodeFences: boolean }): string {
  if (!node) return ""

  const clone = node.cloneNode(true) as HTMLElement
  clone.querySelectorAll("button, svg, [aria-hidden='true'], [data-testid*='copy'], [class*='copy']").forEach(element => {
    element.remove()
  })

  return domToMarkdown(clone, options)
}

function domToMarkdown(node: Node, options: { closeCodeFences: boolean }): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || "").replace(/\u00a0/g, " ")
  }

  if (!(node instanceof HTMLElement)) {
    return Array.from(node.childNodes).map(child => domToMarkdown(child, options)).join("")
  }

  const tag = node.tagName.toLowerCase()
  const children = () => Array.from(node.childNodes).map(child => domToMarkdown(child, options)).join("")
  const inline = () => collapseInlineWhitespace(children())
  const block = (content: string) => content.trim() ? `${content.trim()}\n\n` : ""
  const mathTex = extractMathTex(node)

  if (mathTex) {
    return isDisplayMath(node)
      ? `$$\n${mathTex}\n$$\n\n`
      : `$${mathTex}$`
  }

  if (tag === "br") return "\n"

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1))
    return block(`${"#".repeat(level)} ${inline()}`)
  }

  if (tag === "p") return block(children())
  if (tag === "strong" || tag === "b") return inline() ? `**${inline()}**` : ""
  if (tag === "em" || tag === "i") return inline() ? `*${inline()}*` : ""
  if (tag === "del" || tag === "s") return inline() ? `~~${inline()}~~` : ""

  if (tag === "code") {
    if (node.closest("pre")) return node.textContent || ""
    const code = (node.textContent || "").replace(/`/g, "\\`")
    return code ? `\`${code}\`` : ""
  }

  if (tag === "pre") {
    const codeElement = node.querySelector("code")
    const code = (codeElement?.textContent || node.textContent || "").replace(/\n+$/, "")
    const language = getCodeLanguage(codeElement)
    const closingFence = options.closeCodeFences ? "\n```" : ""
    return code ? `\`\`\`${language}\n${code}${closingFence}\n\n` : ""
  }

  if (tag === "ul" || tag === "ol") {
    const items = Array.from(node.children).filter(child => child.tagName.toLowerCase() === "li")
    return `${items.map((item, index) => {
      const marker = tag === "ol" ? `${index + 1}. ` : "- "
      return formatListItem(domToMarkdown(item, options), marker)
    }).join("")}\n`
  }

  if (tag === "li") return children().trim()

  if (tag === "blockquote") {
    const quote = children().trim()
    return quote ? `${quote.split("\n").map(line => `> ${line}`).join("\n")}\n\n` : ""
  }

  if (tag === "table") return tableToMarkdown(node)

  if (isBlockElement(tag)) return block(children())

  return children()
}

function collapseInlineWhitespace(text: string): string {
  return text.replace(/[ \t\r\n]+/g, " ").trim()
}

function formatListItem(content: string, marker: string): string {
  const lines = content.trim().split("\n")
  if (lines.length === 0) return ""
  return `${marker}${lines[0]}${lines.slice(1).map(line => `\n  ${line}`).join("")}\n`
}

function getCodeLanguage(codeElement: Element | null): string {
  const className = codeElement?.getAttribute("class") || ""
  const match = className.match(/language-([A-Za-z0-9_-]+)/)
  return match?.[1] || ""
}

function extractMathTex(element: HTMLElement): string {
  const className = element.getAttribute("class") || ""
  const isMathNode = className.includes("katex") ||
    element.tagName.toLowerCase() === "mjx-container" ||
    element.matches("script[type^='math/tex']")

  if (!isMathNode) return ""

  if (element.matches("script[type^='math/tex']")) {
    return (element.textContent || "").trim()
  }

  const annotation = element.querySelector("annotation[encoding='application/x-tex']")
  const tex = (annotation?.textContent || "").trim()
  if (tex) return tex

  const annotationTex = element.querySelector("annotation")
  return (annotationTex?.textContent || "").trim()
}

function isDisplayMath(element: HTMLElement): boolean {
  const className = element.getAttribute("class") || ""
  const scriptType = element.getAttribute("type") || ""
  return className.includes("katex-display") ||
    element.closest(".katex-display") !== null ||
    element.getAttribute("display") === "true" ||
    scriptType.includes("mode=display")
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr")).map(row =>
    Array.from(row.querySelectorAll("th,td")).map(cell => collapseInlineWhitespace(cell.textContent || ""))
  ).filter(row => row.length > 0)

  if (rows.length === 0) return ""

  const header = rows[0]
  const separator = header.map(() => "---")
  const body = rows.slice(1)
  const renderRow = (row: string[]) => `| ${row.join(" | ")} |`

  return `${[renderRow(header), renderRow(separator), ...body.map(renderRow)].join("\n")}\n\n`
}

function isBlockElement(tag: string): boolean {
  return [
    "article",
    "aside",
    "div",
    "figure",
    "figcaption",
    "footer",
    "header",
    "main",
    "section"
  ].includes(tag)
}

function isGenerating(): boolean {
  const generatingSelectors = [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']",
    "[data-testid='composer-speech-button'][disabled]"
  ]

  return generatingSelectors.some(selector => {
    const element = document.querySelector<HTMLElement>(selector)
    return !!element && isVisible(element)
  })
}

function cleanAssistantText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/^(thinking|thinking\.\.\.|思考中|思考中\.\.\.)\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function sendBridgeMessage(type: string, requestId: string, payload: Record<string, unknown> = {}) {
  chrome.runtime.sendMessage({
    type,
    requestId,
    ...payload
  })
}

function waitForDocumentReady(signal: AbortSignal): Promise<void> {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      document.removeEventListener("DOMContentLoaded", ready)
      reject(new Error("WebSync request aborted."))
    }
    const ready = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }

    signal.addEventListener("abort", abort, { once: true })
    document.addEventListener("DOMContentLoaded", ready, { once: true })
  })
}

async function waitForElement<T extends HTMLElement>(
  find: () => T | null,
  timeoutMs: number,
  signal: AbortSignal
): Promise<T> {
  const startedAt = Date.now()

  while (!signal.aborted) {
    const element = find()
    if (element) return element

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("WebSync did not find the web chat input or send button. Please reload the WebChat tab and try again.")
    }

    await sleep(250, signal)
  }

  throw new Error("WebSync request aborted.")
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer)
      reject(new Error("WebSync request aborted."))
    }, { once: true })
  })
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
}
