#!/usr/bin/env node

import { createServer, request } from "node:http"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

const PORT = Number(process.env.OVERLEAFGPT_CODEX_BRIDGE_PORT || 17381)
const HOST = process.env.OVERLEAFGPT_CODEX_BRIDGE_HOST || "127.0.0.1"
const REQUEST_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = 300_000
const IMAGE_DIR = join(tmpdir(), "overleafgpt-codex-bridge-images")
const CODEX_MODELS_CACHE = join(homedir(), ".codex", "models_cache.json")
const CODEX_REASONING_LEVELS = new Set(["low", "medium", "high", "xhigh"])
const CODEX_SESSION_TTL_MS = 12 * 60 * 60 * 1000

class CodexAppServer {
  constructor() {
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    this.stderrTail = ""
    this.startPromise = null
  }

  async start() {
    if (this.proc) return
    if (this.startPromise) return this.startPromise

    this.startPromise = (async () => {
      const launch = resolveCodexLaunch()
      try {
        this.proc = spawn(launch.command, launch.args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: launch.shell,
          env: process.env,
        })
      } catch (error) {
        throw new Error(`${getCodexCliInstallHint()} ${error instanceof Error ? error.message : String(error)}`)
      }

      this.proc.on("error", (error) => {
        const wrapped = new Error(`${getCodexCliInstallHint()} ${error.message}`)
        for (const [, pending] of this.pending) {
          pending.reject(wrapped)
        }
        this.pending.clear()
        this.proc = null
        this.startPromise = null
      })

      this.proc.on("exit", (code, signal) => {
        const tail = this.stderrTail.trim()
        const reason = `codex app-server exited (${code ?? signal ?? "unknown"})${tail ? `: ${tail}` : ""}`
        for (const [, pending] of this.pending) {
          pending.reject(new Error(reason))
        }
        this.pending.clear()
        this.proc = null
        this.startPromise = null
      })

      createInterface({ input: this.proc.stdout }).on("line", (line) => {
        this.handleLine(line)
      })

      this.proc.stderr.on("data", (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4000)
      })

      await this.send("initialize", {
        clientInfo: {
          name: "overleafgpt-codex-bridge",
          title: "OverleafGPT Codex Bridge",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      })
      this.notify("initialized")
    })()

    return this.startPromise
  }

  handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return

    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      this.stderrTail = `${this.stderrTail}\n${trimmed}`.slice(-4000)
      return
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        pending.reject(new Error(String(message.error.message || message.error)))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id !== undefined && typeof message.method === "string") {
      this.proc?.stdin.write(JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: `No bridge handler registered for ${message.method}`,
        },
      }) + "\n")
      return
    }

    if (typeof message.method === "string") {
      const handlers = this.handlers.get(message.method)
      if (!handlers) return
      for (const handler of [...handlers]) {
        try {
          handler(message.params)
        } catch {
          // Notification consumers must not break the app-server read loop.
        }
      }
    }
  }

  send(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.proc) {
      return Promise.reject(new Error("codex app-server is not running"))
    }

    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params }) + "\n"

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for codex app-server response to ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timeout })
      this.proc.stdin.write(payload, (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method, params) {
    if (!this.proc) return
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n")
  }

  on(method, handler) {
    let handlers = this.handlers.get(method)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(method, handlers)
    }
    handlers.add(handler)
    return () => handlers.delete(handler)
  }
}

const codex = new CodexAppServer()
const codexThreadSessions = new Map()

function resolveCodexLaunch() {
  const explicit = process.env.CODEX_PATH?.trim()
  if (explicit) {
    return { command: explicit, args: ["app-server"], shell: false }
  }

  if (process.platform !== "win32") {
    return { command: "codex", args: ["app-server"], shell: false }
  }

  const candidates = []
  const userProfile = process.env.USERPROFILE || ""
  const appData = process.env.APPDATA || (userProfile ? join(userProfile, "AppData", "Roaming") : "")
  const localAppData = process.env.LOCALAPPDATA || (userProfile ? join(userProfile, "AppData", "Local") : "")

  if (appData) {
    candidates.push(join(appData, "npm", "codex.cmd"))
    candidates.push(join(appData, "npm", "codex.exe"))
  }
  if (localAppData) {
    candidates.push(join(localAppData, "Programs", "Codex", "codex.exe"))
    candidates.push(join(localAppData, "Programs", "OpenAI Codex", "codex.exe"))
  }
  if (userProfile) {
    candidates.push(join(userProfile, ".cargo", "bin", "codex.exe"))
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return {
        command: candidate,
        args: ["app-server"],
        shell: /\.cmd$/i.test(candidate),
      }
    }
  }

  return { command: "codex", args: ["app-server"], shell: true }
}

function getCodexCliInstallHint() {
  return [
    "Codex CLI was not found on PATH or in common Windows install locations.",
    "Codex Desktop/ChatGPT Desktop login is not enough for `codex app-server`; the bridge needs the Codex CLI binary.",
    "Install it with `npm install -g @openai/codex`, then run `codex login`, or set CODEX_PATH to the full codex.exe path.",
  ].join(" ")
}

async function readCodexModels() {
  const raw = await readFile(CODEX_MODELS_CACHE, "utf8")
  const payload = JSON.parse(raw)
  const models = Array.isArray(payload.models) ? payload.models : []

  return models
    .filter((model) => model?.visibility === "list" && model?.supported_in_api === true)
    .sort((a, b) => {
      const left = Number.isFinite(a.priority) ? a.priority : 9999
      const right = Number.isFinite(b.priority) ? b.priority : 9999
      if (left !== right) return left - right
      return String(a.slug || "").localeCompare(String(b.slug || ""))
    })
    .map((model) => ({
      id: String(model.slug || ""),
      object: "model",
      name: String(model.display_name || model.slug || ""),
      display_name: String(model.display_name || model.slug || ""),
      description: typeof model.description === "string" ? model.description : "",
      default_reasoning_level:
        typeof model.default_reasoning_level === "string"
          ? model.default_reasoning_level
          : undefined,
      supported_reasoning_levels: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((entry) => entry?.effort)
            .filter((entry) => typeof entry === "string")
        : [],
    }))
    .filter((model) => model.id)
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept")
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += chunk.toString()
      if (raw.length > 20 * 1024 * 1024) {
        reject(new Error("Request body is too large"))
        req.destroy()
      }
    })
    req.on("end", () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function json(res, status, payload) {
  setCorsHeaders(res)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

function normalizeText(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(normalizeText).join("")
  if (!value || typeof value !== "object") return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.value === "string") return value.value
  if (Array.isArray(value.content)) return value.content.map(normalizeText).join("")
  return ""
}

function normalizeReasoningEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : ""
  return CODEX_REASONING_LEVELS.has(effort) ? effort : "medium"
}

function splitContent(content) {
  if (typeof content === "string") return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: normalizeText(content), images: [] }

  const text = []
  const images = []
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      text.push(part.text)
    } else if (part?.type === "image_url" && part.image_url?.url) {
      images.push(String(part.image_url.url))
    }
  }
  return { text: text.join("\n\n"), images }
}

function normalizeSessionId(value) {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, 500)
}

function pruneCodexThreadSessions() {
  const now = Date.now()
  for (const [sessionId, session] of codexThreadSessions) {
    if (now - session.lastUsedAt > CODEX_SESSION_TTL_MS) {
      codexThreadSessions.delete(sessionId)
    }
  }
}

function extractSystemInstructions(messages) {
  const systemMessage = messages.find((message) => message.role === "system")
  return systemMessage ? splitContent(systemMessage.content).text.trim() : ""
}

function formatVisibleMessages(messages) {
  const firstSystemIndex = messages.findIndex((message) => message.role === "system")
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role !== "system" || index !== firstSystemIndex)
    .map(({ message }) => {
      const { text, images } = splitContent(message.content)
      const imageNote = images.length ? `\n\n[${images.length} image(s) attached]` : ""
      const role = message.role === "system" ? "SYSTEM CONTEXT" : String(message.role || "user").toUpperCase()
      return `${role}:\n${text || "[Empty message]"}${imageNote}`
    })
    .join("\n\n---\n\n")
}

function messagesForCodexTurn(messages, reuseThread) {
  if (!reuseThread) return messages

  const lastAssistantIndex = messages.reduce(
    (lastIndex, message, index) => message.role === "assistant" ? index : lastIndex,
    -1
  )
  if (lastAssistantIndex < 0) return messages

  const firstSystemMessage = messages.find((message) => message.role === "system")
  const currentTurnMessages = messages.slice(lastAssistantIndex + 1)
  return firstSystemMessage ? [firstSystemMessage, ...currentTurnMessages] : currentTurnMessages
}

async function dataUrlToLocalImage(url) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url)
  if (!match) return null

  const mime = match[1].toLowerCase()
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  const hash = createHash("sha256").update(bytes).digest("hex")
  const ext =
    mime === "image/jpeg" ? ".jpg" :
    mime === "image/png" ? ".png" :
    mime === "image/webp" ? ".webp" :
    mime === "image/gif" ? ".gif" :
    ".img"
  const filePath = join(IMAGE_DIR, `${hash}${ext}`)
  if (!existsSync(filePath)) {
    await mkdir(IMAGE_DIR, { recursive: true })
    await writeFile(filePath, bytes)
  }
  return filePath
}

async function buildTurnInput(messages) {
  const visibleText = formatVisibleMessages(messages)
  const input = [{ type: "text", text: visibleText || "" }]

  for (const message of messages) {
    const { images } = splitContent(message.content)
    for (const image of images) {
      const localPath = image.startsWith("data:")
        ? await dataUrlToLocalImage(image)
        : null
      input.push(localPath ? { type: "localImage", path: localPath } : { type: "image", url: image })
    }
  }

  return input
}

async function startCodexThread({ model, instructions, ephemeral }) {
  try {
    return await codex.send("thread/start", {
      model,
      ephemeral,
      approvalPolicy: "never",
      developerInstructions: instructions,
      config: { features: { shell_tool: false } },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/developerInstructions|developer instructions|unknown field|invalid params/i.test(message)) {
      throw error
    }
    return await codex.send("thread/start", {
      model,
      ephemeral,
      approvalPolicy: "never",
      config: { features: { shell_tool: false } },
    })
  }
}

async function getCodexThread({ sessionId, model, instructions }) {
  pruneCodexThreadSessions()

  if (sessionId) {
    const session = codexThreadSessions.get(sessionId)
    if (session?.threadId) {
      session.lastUsedAt = Date.now()
      return { threadId: session.threadId, reused: true }
    }
  }

  const threadResult = await startCodexThread({
    model,
    instructions,
    ephemeral: !sessionId,
  })
  const threadId = extractId(threadResult, "thread")
  if (!threadId) throw new Error("codex app-server did not return a thread ID")

  if (sessionId) {
    codexThreadSessions.set(sessionId, {
      threadId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    })
  }

  return { threadId, reused: false }
}

function extractId(result, key) {
  if (!result || typeof result !== "object") return ""
  if (typeof result.id === "string") return result.id
  if (result[key] && typeof result[key].id === "string") return result[key].id
  return ""
}

function extractTurnId(params) {
  if (!params || typeof params !== "object") return ""
  if (typeof params.turnId === "string") return params.turnId
  if (params.turn && typeof params.turn.id === "string") return params.turn.id
  return ""
}

function extractMessageItemId(params) {
  if (!params || typeof params !== "object") return ""
  const source = params.item && typeof params.item === "object" ? params.item : params
  return String(source.itemId || source.messageId || source.outputItemId || source.id || source.message?.id || "")
}

function extractItem(params) {
  if (!params || typeof params !== "object") return null
  const source = params.item && typeof params.item === "object" ? params.item : params
  return {
    id: typeof source.id === "string" ? source.id : "",
    type: typeof source.type === "string" ? source.type.toLowerCase() : "",
    role: typeof source.role === "string" ? source.role.toLowerCase() : "",
    text: normalizeText(source.content) || normalizeText(source.text) || normalizeText(source.summary),
  }
}

function formatCodexError(error) {
  if (!error) return ""
  if (typeof error === "string") return error
  if (typeof error !== "object") return String(error)

  const parts = [
    error.message,
    error.codexErrorInfo,
    error.additionalDetails,
  ].filter((part) => typeof part === "string" && part.trim())

  return parts.join(" ")
}

function isAssistantMessageItem(item) {
  if (!item) return false
  const type = item.type.replace(/[-_\s]+/g, "")
  const role = item.role.replace(/[-_\s]+/g, "")
  return type === "agentmessage" || type === "assistantmessage" || (type === "message" && (role === "assistant" || role === "agent"))
}

function sendOpenAIChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function sendTextDelta(res, delta) {
  if (!delta) return
  sendOpenAIChunk(res, {
    choices: [{ delta: { content: delta } }],
  })
}

function sendReasoningDelta(res, delta) {
  if (!delta) return
  sendOpenAIChunk(res, {
    choices: [{ delta: { reasoning_content: delta } }],
  })
}

async function runCodexTurn(body, callbacks = {}) {
  await codex.start()

  const messages = Array.isArray(body.messages) ? body.messages : []
  const model = String(body.model || "gpt-5.4")
  const reasoningEffort = normalizeReasoningEffort(
    body.reasoning_effort || body.effort || body.reasoning?.effort
  )
  const sessionId = normalizeSessionId(body.session_id || body.codex_session_id)
  const instructions = extractSystemInstructions(messages) || "You are a helpful assistant."

  let { threadId, reused } = await getCodexThread({ sessionId, model, instructions })
  let input = await buildTurnInput(messagesForCodexTurn(messages, reused))
  let turnResult
  try {
    turnResult = await codex.send("turn/start", {
      threadId,
      input,
      model,
      effort: reasoningEffort,
      approvalPolicy: "never",
    })
  } catch (error) {
    if (!sessionId || !reused) throw error
    codexThreadSessions.delete(sessionId)
    ;({ threadId, reused } = await getCodexThread({ sessionId, model, instructions }))
    input = await buildTurnInput(messages)
    turnResult = await codex.send("turn/start", {
      threadId,
      input,
      model,
      effort: reasoningEffort,
      approvalPolicy: "never",
    })
  }
  const turnId = extractId(turnResult, "turn")
  if (!turnId) throw new Error("codex app-server did not return a turn ID")

  return await waitForTurn({ threadId, turnId, callbacks })
}

function waitForTurn({ threadId, turnId, callbacks }) {
  return new Promise((resolve, reject) => {
    let accumulated = ""
    let settled = false
    let lastMessageItemId = ""
    let lastError = ""
    const messageTextByItemId = new Map()

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for codex app-server turn completion"))
    }, TURN_TIMEOUT_MS)

    const cleanupFns = []
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      for (const fn of cleanupFns) fn()
    }

    const sameTurn = (params) => {
      const eventTurnId = extractTurnId(params)
      return !eventTurnId || eventTurnId === turnId
    }

    cleanupFns.push(codex.on("item/agentMessage/delta", (params) => {
      if (!sameTurn(params)) return
      const delta = normalizeText(params?.delta ?? params?.text)
      if (!delta) return
      accumulated += delta
      const itemId = extractMessageItemId(params)
      if (itemId) {
        lastMessageItemId = itemId
        messageTextByItemId.set(itemId, `${messageTextByItemId.get(itemId) || ""}${delta}`)
      }
      callbacks.onTextDelta?.(delta)
    }))

    cleanupFns.push(codex.on("item/reasoning/summaryTextDelta", (params) => {
      if (!sameTurn(params)) return
      callbacks.onReasoningDelta?.(normalizeText(params?.delta ?? params?.text))
    }))

    cleanupFns.push(codex.on("item/reasoning/textDelta", (params) => {
      if (!sameTurn(params)) return
      callbacks.onReasoningDelta?.(normalizeText(params?.delta ?? params?.text))
    }))

    cleanupFns.push(codex.on("item/completed", (params) => {
      if (!sameTurn(params)) return
      const item = extractItem(params)
      if (!isAssistantMessageItem(item) || !item.text) return
      if (item.id) {
        lastMessageItemId = item.id
        messageTextByItemId.set(item.id, item.text)
      }
      if (!accumulated) {
        accumulated = item.text
        callbacks.onTextDelta?.(item.text)
      }
    }))

    cleanupFns.push(codex.on("error", (params) => {
      if (!sameTurn(params)) return
      lastError = formatCodexError(params?.error) || lastError
    }))

    cleanupFns.push(codex.on("turn/completed", (params) => {
      const completedTurnId = extractTurnId(params)
      if (completedTurnId !== turnId) return
      const status = params?.turn?.status || params?.status
      if (status === "completed") {
        const finalText = lastMessageItemId
          ? messageTextByItemId.get(lastMessageItemId) || accumulated
          : accumulated
        cleanup()
        resolve(finalText)
      } else {
        const turnError = formatCodexError(params?.turn?.error || params?.error)
        const details = turnError || lastError
        cleanup()
        reject(new Error(`Codex turn ended with status: ${status || "unknown"}${details ? `: ${details}` : ""}`))
      }
    }))
  })
}

async function handleStream(req, res) {
  const body = await readJsonBody(req)
  setCorsHeaders(res)
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  })

  try {
    await runCodexTurn(body, {
      onTextDelta: (delta) => sendTextDelta(res, delta),
      onReasoningDelta: (delta) => sendReasoningDelta(res, delta),
    })
    res.write("data: [DONE]\n\n")
    res.end()
  } catch (error) {
    sendTextDelta(
      res,
      `Codex Bridge Error: ${error instanceof Error ? error.message : String(error)}`
    )
    sendOpenAIChunk(res, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      error: error instanceof Error ? error.message : String(error),
    })
    res.write("data: [DONE]\n\n")
    res.end()
  }
}

async function handleJsonChat(req, res) {
  const body = await readJsonBody(req)
  const text = await runCodexTurn(body)
  json(res, 200, {
    choices: [{ message: { role: "assistant", content: text } }],
  })
}

async function handleResetCodexSession(req, res) {
  const body = await readJsonBody(req)
  const sessionId = normalizeSessionId(body.session_id || body.codex_session_id)
  if (sessionId) {
    const removed = codexThreadSessions.delete(sessionId)
    json(res, 200, { ok: true, removed, session_id: sessionId })
    return
  }

  const removed = codexThreadSessions.size
  codexThreadSessions.clear()
  json(res, 200, { ok: true, removed })
}

async function handleCodexMemoryCheck(req, res) {
  const body = await readJsonBody(req)
  const model = String(body.model || "gpt-5.4")
  const reasoningEffort = normalizeReasoningEffort(
    body.reasoning_effort || body.effort || body.reasoning?.effort
  )
  const sessionId = `self-check:${Date.now()}:${randomBytes(4).toString("hex")}`
  const nonce = `overleafgpt-${randomBytes(8).toString("hex")}`
  const systemMessage = {
    role: "system",
    content: "You are running a local memory diagnostic. Follow the user instruction exactly.",
  }

  try {
    const firstResponse = await runCodexTurn({
      model,
      reasoning_effort: reasoningEffort,
      session_id: sessionId,
      messages: [
        systemMessage,
        {
          role: "user",
          content: `Remember this diagnostic nonce for the next turn: ${nonce}. Reply only: ACK`,
        },
      ],
    })

    const secondResponse = await runCodexTurn({
      model,
      reasoning_effort: reasoningEffort,
      session_id: sessionId,
      messages: [
        systemMessage,
        {
          role: "user",
          content: "What diagnostic nonce did I ask you to remember in the previous turn? Reply only the nonce.",
        },
      ],
    })

    const remembered = secondResponse.includes(nonce)
    json(res, 200, {
      ok: remembered,
      remembered,
      nonce,
      first_response: firstResponse,
      second_response: secondResponse,
    })
  } finally {
    codexThreadSessions.delete(sessionId)
  }
}

const server = createServer(async (req, res) => {
  try {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true, service: "overleafgpt-codex-bridge" })
      return
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      const models = await readCodexModels()
      json(res, 200, { object: "list", data: models })
      return
    }

    if (req.method === "GET" && req.url === "/v1/codex/sessions") {
      pruneCodexThreadSessions()
      json(res, 200, {
        object: "list",
        data: Array.from(codexThreadSessions.entries()).map(([sessionId, session]) => ({
          session_id: sessionId,
          thread_id: session.threadId,
          created_at: new Date(session.createdAt).toISOString(),
          last_used_at: new Date(session.lastUsedAt).toISOString(),
        })),
      })
      return
    }

    if (req.method === "POST" && req.url === "/v1/codex/session/reset") {
      await handleResetCodexSession(req, res)
      return
    }

    if (req.method === "POST" && req.url === "/v1/codex/memory-check") {
      await handleCodexMemoryCheck(req, res)
      return
    }

    if (req.method === "POST" && req.url === "/v1/chat/stream") {
      await handleStream(req, res)
      return
    }

    if (req.method === "POST" && req.url === "/v1/chat") {
      await handleJsonChat(req, res)
      return
    }

    json(res, 404, { error: "Not found" })
  } catch (error) {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

server.on("error", async (error) => {
  if (error?.code !== "EADDRINUSE") {
    console.error(error)
    process.exit(1)
  }

  const healthUrl = `http://${HOST}:${PORT}/health`
  const existingService = await fetchJson(healthUrl).catch(() => null)
  if (existingService?.service === "overleafgpt-codex-bridge") {
    console.error(`OverleafGPT Codex Bridge is already running at ${healthUrl}.`)
    console.error("You can keep using the existing bridge, or stop the old process before starting a new one.")
  } else {
    console.error(`Port ${PORT} on ${HOST} is already in use by another process.`)
    console.error("Close the application using this port, or free it from PowerShell:")
  }

  console.error(`Get-NetTCPConnection -LocalAddress ${HOST} -LocalPort ${PORT} | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ }`)
  console.error("Then run: corepack pnpm bridge")
  process.exit(1)
})

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: 2000 }, (res) => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        raw += chunk
      })
      res.on("end", () => {
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          resolve(null)
          return
        }
        try {
          resolve(raw.trim() ? JSON.parse(raw) : null)
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on("timeout", () => {
      req.destroy(new Error("Timed out checking existing bridge health"))
    })
    req.on("error", reject)
    req.end()
  })
}

server.listen(PORT, HOST, () => {
  console.log(`OverleafGPT Codex Bridge listening at http://${HOST}:${PORT}`)
  console.log("Run `codex login` before using Codex models.")
})
