import type { ModelConfig } from './builtin-models'
import type { ChatMessage } from './llm-service'
import type { CodexReasoningEffort } from '~store/types'

interface ChatOptions {
  temperature?: number
  max_tokens?: number
  maxTokens?: number
  codexReasoningEffort?: CodexReasoningEffort
}

/**
 * 统一的API客户端
 * 根据不同模型的API格式发送请求
 */
export class ApiClient {
  private modelConfig: ModelConfig

  constructor(modelConfig: ModelConfig) {
    this.modelConfig = modelConfig
  }

  /**
   * 智能构建API URL，避免路径重复
   * 支持多种API格式和路径结构
   */
  private buildUrl(path: string): string {
    const baseUrl = this.modelConfig.base_url.replace(/\/+$/, '') // 移除末尾的斜杠
    const cleanPath = path.startsWith('/') ? path : `/${path}`

    // 特殊情况处理：如果baseUrl已经包含完整的API路径，直接拼接
    // 例如：https://generativelanguage.googleapis.com/v1beta/openai + /chat/completions
    if (this.isCompleteApiPath(baseUrl)) {
      return `${baseUrl}${cleanPath.replace('/v1', '')}`
    }

    // 通用路径重复检查：避免版本号重复
    const versionPatterns = ['/v1', '/v1beta', '/v2', '/v3', '/api/v1', '/api/v2']

    for (const version of versionPatterns) {
      if (cleanPath.startsWith(`${version}/`) && baseUrl.endsWith(version)) {
        return `${baseUrl}${cleanPath.substring(version.length)}`
      }
    }

    // 默认情况：直接拼接
    return `${baseUrl}${cleanPath}`
  }

  /**
   * 检查baseUrl是否已经包含完整的API路径
   * 这些URL通常不需要额外的版本前缀
   */
  private isCompleteApiPath(baseUrl: string): boolean {
    const completeApiPatterns = [
      '/openai',           // Gemini OpenAI兼容: /v1beta/openai
      '/compatible-mode',  // 阿里云兼容模式: /compatible-mode/v1
      '/api/paas',         // 智谱AI: /api/paas/v4
    ]

    return completeApiPatterns.some(pattern => baseUrl.includes(pattern))
  }

  /**
   * 发送聊天请求 - 统一使用OpenAI格式
   */
  async sendChatRequest(
    messages: ChatMessage[],
    stream: boolean = true,
    abortSignal?: AbortSignal,
    options?: ChatOptions
  ): Promise<Response> {
    if (this.modelConfig.transport === 'web_sync') {
      return this.sendWebSyncRequest(messages, stream, abortSignal)
    }

    if (this.modelConfig.transport === 'codex_bridge') {
      return this.sendCodexBridgeRequest(messages, stream, abortSignal, options)
    }

    // 所有模型都使用OpenAI兼容格式
    return this.sendOpenAIRequest(messages, stream, abortSignal, options)
  }

  /**
   * 发送到本地 Codex Bridge。Bridge 会启动/复用 `codex app-server`，
   * 并返回 OpenAI Chat Completions 风格的 SSE，复用当前流式解析逻辑。
   */
  private async sendCodexBridgeRequest(
    messages: ChatMessage[],
    stream: boolean,
    abortSignal?: AbortSignal,
    options?: ChatOptions
  ): Promise<Response> {
    const headers = new Headers()
    headers.append('Accept', stream ? 'text/event-stream' : 'application/json')
    headers.append('Content-Type', 'application/json')

    const convertedMessages = messages.map(msg => this.convertToOpenAIMessage(msg))
    const path = stream ? '/v1/chat/stream' : '/v1/chat'
    const fullUrl = this.buildCodexBridgeUrl(path)

    const body = JSON.stringify({
      model: this.modelConfig.model_name,
      messages: convertedMessages,
      stream,
      temperature: options?.temperature ?? 0.36,
      reasoning_effort: options?.codexReasoningEffort ?? 'medium',
      max_tokens: options?.max_tokens ?? options?.maxTokens ?? 16384
    })

    return fetch(fullUrl, {
      method: 'POST',
      headers,
      body,
      signal: abortSignal
    })
  }

  private async sendWebSyncRequest(
    messages: ChatMessage[],
    stream: boolean,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
      return new Response('WebSync is only available inside the browser extension.', { status: 503 })
    }

    const encoder = new TextEncoder()
    const requestId = `web-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const target = this.getWebSyncTarget()
    const promptPayload = await this.buildWebSyncPrompt(messages, target)

    let port: chrome.runtime.Port | null = null
    let closed = false

    const responseStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = () => {
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {
            // Already closed.
          }
        }

        const writeSse = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        }

        const writeDone = () => {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          close()
        }

        port = chrome.runtime.connect({ name: 'overleafgpt-web-sync' })
        port.onMessage.addListener((message) => {
          if (!message || message.requestId !== requestId) return

          if (message.type === 'web_sync_delta') {
            writeSse({
              id: requestId,
              object: 'chat.completion.chunk',
              choices: [{
                index: 0,
                delta: { content: message.delta || '' },
                finish_reason: null
              }]
            })
          } else if (message.type === 'web_sync_done') {
            writeDone()
          } else if (message.type === 'web_sync_error') {
            closed = true
            controller.error(new Error(message.error || 'WebSync request failed'))
          }
        })

        port.onDisconnect.addListener(() => {
          if (!closed) {
            controller.error(new Error(chrome.runtime.lastError?.message || 'WebSync bridge disconnected'))
          }
        })

        abortSignal?.addEventListener('abort', () => {
          port?.postMessage({ type: 'web_sync_abort', requestId })
          port?.disconnect()
          close()
        }, { once: true })

        port.postMessage({
          type: 'web_sync_start',
          requestId,
          target,
          prompt: promptPayload.prompt,
          primedKey: promptPayload.primedKey,
          markPrimed: promptPayload.markPrimed,
          stream,
          model: this.modelConfig.model_name
        })
      },
      cancel: () => {
        port?.postMessage({ type: 'web_sync_abort', requestId })
        port?.disconnect()
      }
    })

    return new Response(responseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    })
  }

  private getWebSyncTarget(): 'chatgpt' | 'deepseek' {
    const marker = `${this.modelConfig.provider} ${this.modelConfig.model_name} ${this.modelConfig.base_url}`.toLowerCase()
    return marker.includes('deepseek') ? 'deepseek' : 'chatgpt'
  }

  private async buildWebSyncPrompt(messages: ChatMessage[], target: 'chatgpt' | 'deepseek'): Promise<{
    prompt: string
    primedKey: string
    markPrimed: boolean
  }> {
    const primedKey = `${target}:${this.modelConfig.provider}`
    const includeRoleInstructions = !(await this.isWebSyncPrimed(primedKey))

    const firstSystemIndex = messages.findIndex(message => message.role === 'system')
    const lastUserIndex = findLastIndex(messages, message => message.role === 'user')
    const sections: string[] = []

    if (includeRoleInstructions && firstSystemIndex >= 0) {
      sections.push(`Role instructions, remember for this WebChat conversation:\n${this.messageContentToText(messages[firstSystemIndex].content)}`)
    }

    const contextSections = messages
      .map((message, index) => ({ message, index, text: this.messageContentToText(message.content).trim() }))
      .filter(item => item.text)
      .filter(item => {
        if (item.index === firstSystemIndex) return false
        if (item.index === lastUserIndex) return false
        if (item.message.role === 'assistant') return false
        if (item.message.role === 'system') return true
        return this.isWebSyncAutoContext(item.text)
      })

    if (contextSections.length > 0) {
      sections.push(`Current Overleaf context:\n${contextSections.map(item => item.text).join('\n\n---\n\n')}`)
    }

    const currentUserText = lastUserIndex >= 0
      ? this.messageContentToText(messages[lastUserIndex].content).trim()
      : ''

    if (currentUserText) {
      sections.push(`Current user request:\n${currentUserText}`)
    }

    return {
      prompt: sections.join('\n\n==========\n\n'),
      primedKey,
      markPrimed: includeRoleInstructions
    }
  }

  private async isWebSyncPrimed(primedKey: string): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return false
    }

    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'overleafgpt_web_sync_is_primed',
        primedKey
      }, response => {
        resolve(response?.primed === true)
      })
    })
  }

  private isWebSyncAutoContext(text: string): boolean {
    return text.includes('系统自动提供') ||
      text.includes('绯荤粺') ||
      text.includes('最新文件内容') ||
      text.includes('项目文件列表') ||
      text.includes('真实项目文件') ||
      text.includes('銆婃枃浠') ||
      text.includes('[Image omitted:')
  }

  private messageContentToText(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content

    return content.map((part) => {
      if (part.type === 'text') return part.text || ''
      if (part.type === 'image_url') return '[Image omitted: WebSync currently sends text only.]'
      return ''
    }).filter(Boolean).join('\n\n')
  }

  private buildCodexBridgeUrl(path: string): string {
    const baseUrl = this.modelConfig.base_url.replace(/\/+$/, '')
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return `${baseUrl}${cleanPath}`
  }

  /**
   * 发送OpenAI格式请求（GPT、Claude、Gemini等）
   */
  private async sendOpenAIRequest(
    messages: ChatMessage[],
    stream: boolean,
    abortSignal?: AbortSignal,
    options?: ChatOptions
  ): Promise<Response> {
    const headers = new Headers()
    headers.append('Accept', 'application/json')
    headers.append('Authorization', `Bearer ${this.modelConfig.api_key}`)
    headers.append('Content-Type', 'application/json')

    const convertedMessages = messages.map(msg => this.convertToOpenAIMessage(msg))

    // 输出最终发送给API的消息内容用于调试
    console.log('=== 最终发送给API的消息 ===')
    console.log('Model:', this.modelConfig.model_name)
    console.log(convertedMessages)
    console.log('=== API消息结束 ===')

    const body = JSON.stringify({
      model: this.modelConfig.model_name,
      messages: convertedMessages,
      stream,
      temperature: options?.temperature ?? 0.36,
      max_tokens: options?.max_tokens ?? options?.maxTokens ?? 16384   // 默认最大输出长度
    })

    const fullUrl = this.buildUrl('/v1/chat/completions')

    return fetch(fullUrl, {
      method: 'POST',
      headers,
      body,
      signal: abortSignal
    })
  }



  /**
   * 转换为OpenAI消息格式
   */
  private convertToOpenAIMessage(message: ChatMessage): any {
    if (typeof message.content === 'string') {
      return {
        role: message.role,
        content: message.content
      }
    }

    // 处理多模态消息
    const content: any[] = []
    
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          content.push({
            type: 'text',
            text: part.text
          })
        } else if (part.type === 'image_url' && part.image_url?.url) {
          content.push({
            type: 'image_url',
            image_url: {
              url: part.image_url.url,
              detail: part.image_url.detail || 'high'
            }
          })
        }
      }
    }

    return {
      role: message.role,
      content: content.length > 0 ? content : message.content
    }
  }



  /**
   * 处理流式响应 - 统一使用OpenAI格式
   */
  async *processStreamResponse(response: Response): AsyncGenerator<{
    content: string
    finished: boolean
    error?: string
    thinking?: string
    thinkingFinished?: boolean
  }, void, unknown> {
    // 所有模型都使用OpenAI格式的流式响应处理
    yield* this.processOpenAIStream(response)
  }

  /**
   * 处理OpenAI格式的流式响应
   * 支持解析 reasoning_content (OpenAI o1/o3 思考链) 和其他格式
   */
  private async *processOpenAIStream(response: Response): AsyncGenerator<{
    content: string
    finished: boolean
    error?: string
    thinking?: string
    thinkingFinished?: boolean
  }, void, unknown> {
    const reader = response.body?.getReader()
    if (!reader) {
      yield { content: '', finished: true, error: 'No response body' }
      return
    }

    const decoder = new TextDecoder()
    let fullContent = ''
    let fullThinking = ''
    let thinkingFinished = false
    // 用于处理跨 chunk 的不完整数据
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk
        
        // 按换行符分割，处理可能的 \r\n 或 \n
        const lines = buffer.split(/\r?\n/)
        // 保留最后一行（可能不完整）
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmedLine = line.trim()
          if (!trimmedLine) continue
          
          // 支持 "data: " 和 "data:" 两种格式
          let data = ''
          if (trimmedLine.startsWith('data: ')) {
            data = trimmedLine.slice(6)
          } else if (trimmedLine.startsWith('data:')) {
            data = trimmedLine.slice(5)
          } else {
            continue
          }

          if (data === '[DONE]') {
            yield { 
              content: fullContent, 
              finished: true, 
              thinking: fullThinking || undefined, 
              thinkingFinished: true 
            }
            return
          }

          try {
            const parsed = JSON.parse(data)
            const choice = parsed.choices?.[0]
            const delta = choice?.delta

            if (delta) {
              let hasUpdate = false
              
              // 解析思考内容 - 支持多种格式
              const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? null
              if (reasoningDelta) {
                fullThinking += reasoningDelta
                hasUpdate = true
              }

              // 解析正文内容
              const contentDelta = delta.content
              if (contentDelta) {
                // 当开始输出正文时，标记思考已完成
                if (fullThinking && !thinkingFinished) {
                  thinkingFinished = true
                }
                fullContent += contentDelta
                hasUpdate = true
              }
              
              // 只有当有更新时才 yield
              if (hasUpdate) {
                yield { 
                  content: fullContent, 
                  finished: false, 
                  thinking: fullThinking || undefined, 
                  thinkingFinished 
                }
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
      
      // 处理缓冲区中可能剩余的数据
      const remainingLine = buffer.trim()
      if (remainingLine) {
        let data = ''
        if (remainingLine.startsWith('data: ')) {
          data = remainingLine.slice(6)
        } else if (remainingLine.startsWith('data:')) {
          data = remainingLine.slice(5)
        }
        
        if (data && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) {
              fullContent += delta.content
            }
            if (delta?.reasoning_content ?? delta?.reasoning) {
              fullThinking += delta.reasoning_content ?? delta.reasoning
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
      
      // 流结束
      yield { 
        content: fullContent, 
        finished: true, 
        thinking: fullThinking || undefined, 
        thinkingFinished: true 
      }
    } catch (error) {
      yield {
        content: fullContent,
        finished: true,
        error: error instanceof Error ? error.message : 'Stream processing error',
        thinking: fullThinking || undefined,
        thinkingFinished: true
      }
    }
  }

  /**
   * 获取模型列表
   */
  async fetchModels(): Promise<{ id: string; name: string }[]> {
    try {
      const headers = new Headers()
      if (this.modelConfig.api_key) {
        headers.append('Authorization', `Bearer ${this.modelConfig.api_key}`)
      }
      headers.append('Accept', 'application/json')

      const fullUrl = this.modelConfig.transport === 'codex_bridge'
        ? this.buildCodexBridgeUrl('/v1/models')
        : this.buildUrl('/v1/models')
      
      const response = await fetch(fullUrl, {
        method: 'GET',
        headers
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`)
      }

      const data = await response.json()
      
      // 处理不同API返回格式
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((model: any) => ({
          id: model.id || model.model,
          name: model.display_name || model.name || model.id || model.model
        }))
      } else if (Array.isArray(data)) {
        return data.map((model: any) => ({
          id: model.id || model.model,
          name: model.display_name || model.name || model.id || model.model
        }))
      }
      
      return []
    } catch (error) {
      console.error('Error fetching models:', error)
      return []
    }
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index
  }
  return -1
}

/**
 * 静态方法：获取指定提供商的模型列表
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  transport: ModelConfig['transport'] = 'openai_chat'
): Promise<{ id: string; name: string }[]> {
  try {
    const tempConfig: ModelConfig = {
      model_name: 'temp',
      display_name: 'temp',
      provider: 'temp',
      base_url: baseUrl,
      api_key: apiKey,
      multimodal: false,
      transport
    }
    
    const client = new ApiClient(tempConfig)
    return await client.fetchModels()
  } catch (error) {
    console.error('Error in fetchProviderModels:', error)
    return []
  }
}
