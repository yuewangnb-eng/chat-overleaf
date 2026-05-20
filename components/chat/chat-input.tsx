import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScrollArea } from "../ui/scroll-area"
import { ContextTags } from "./context-tags"
import { FilePreviewModal } from "./file-preview-modal"
import { Send, Square, Eraser, Folder, FileText } from "lucide-react"
import { LLMService } from "~lib/llm-service"
import { SYSTEM_PROMPT } from "~lib/system-prompt"
import { type ImageInfo } from "~lib/image-utils"
import { useSelectedText } from "~hooks/useSelectedText"
import { useMessageHandler } from "~hooks/useMessageHandler"
import { useImageHandler } from "~hooks/useImageHandler"
import { useInputHandler } from "~hooks/useInputHandler"
import { generateId } from "~utils/helpers"
import { buildFileTree, getAllFilesInFolder, type TreeNode, estimateTokenWeight, buildEntityTreePrompt } from "./file/file-tree-utils"
import { getEntities } from "~contents/api"

interface Message {
  id: string
  content: string
  isUser: boolean
  timestamp: Date
  isStreaming?: boolean
  selectedText?: import("~hooks/useMessageHandler").SelectedSnippet // 添加选中文本字段
  images?: import("~lib/image-utils").ImageInfo[] // 添加图片信息字段
  isWaiting?: boolean // 是否在等待第一个token
  waitingStartTime?: Date // 等待开始时间
}

interface ExtractedFile {
  name: string
  content: string
  length: number
}

interface ChatInputProps {
  messages: Message[]
  onMessagesChange: React.Dispatch<React.SetStateAction<Message[]>>
  selectedFiles: Set<string>
  extractedFiles: ExtractedFile[]
  llmService: LLMService
  projectId?: string | null
  disabled?: boolean
  onFileSelectionChange?: (selectedFiles: Set<string>) => void
  onSaveChatHistory?: (messages: Message[]) => Promise<any>
  isOnlyInitialMessage?: (messages: Message[]) => boolean
  currentChatId?: string
  currentChatName?: string
  onChatNameChange?: (name: string) => void
  onChatIdChange?: (id: string) => void
  refreshCurrentFile?: () => Promise<ExtractedFile | null>
}

export interface ChatInputHandle {
  focusInput: () => void
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(({
  messages,
  onMessagesChange,
  selectedFiles,
  extractedFiles,
  llmService,
  projectId,
  disabled = false,
  onFileSelectionChange,
  onSaveChatHistory,
  isOnlyInitialMessage,
  currentChatId,
  currentChatName,
  onChatNameChange,
  onChatIdChange,
  refreshCurrentFile
}: ChatInputProps, ref) => {
  // 使用消息处理 hook
  const { isStreaming, handleSendMessage, handleStopStreaming } = useMessageHandler({
    messages,
    onMessagesChange,
    selectedFiles,
    extractedFiles,
    llmService,
    projectId,
    currentChatId,
    currentChatName,
    onChatNameChange,
    refreshCurrentFile
  })

  // 使用图片处理 hook
  const {
    uploadedImages,
    previewModal,
    handleImageClick,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleRemoveImage,
    handleClosePreview,
    clearImages
  } = useImageHandler()

  // 使用输入框处理 hook
  const {
    inputValue,
    textareaRef,
    handleInputChange,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
    clearInput,
    adjustTextareaHeight,
    setInputValue
  } = useInputHandler()

  // 使用选中文本 hook
  const { selectedText, clearSelectedText, hasSelection } = useSelectedText()

  // 暴露聚焦方法
  useImperativeHandle(ref, () => ({
    focusInput: () => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
  }), [textareaRef])

  // @ 文件选择提示状态
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [isMentionListOpen, setIsMentionListOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const mentionItemRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // 构建文件树用于提取文件夹
  const fileTree = useMemo(() => {
    return buildFileTree(extractedFiles)
  }, [extractedFiles])

  const [entityTreePromptTokenCount, setEntityTreePromptTokenCount] = useState(0)

  const refreshEntityTreePromptTokens = useCallback(async () => {
    try {
      const entityResult = await getEntities()
      if (entityResult.success && entityResult.data) {
        const prompt = buildEntityTreePrompt(
          entityResult.data.entities || [],
          entityResult.data.project_id
        )
        setEntityTreePromptTokenCount(prompt.tokenCount || 0)
      }
    } catch (error) {
      console.warn('[ChatOverleaf] Failed to fetch entity tree tokens:', error)
    }
  }, [])

  useEffect(() => {
    void refreshEntityTreePromptTokens()
  }, [refreshEntityTreePromptTokens])

  // 递归收集所有文件夹节点
  const allFolders = useMemo(() => {
    const folders: TreeNode[] = []
    const traverse = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.isFolder) {
          folders.push(node)
          traverse(node.children)
        }
      }
    }
    traverse(fileTree)
    return folders
  }, [fileTree])

  // @ 选项：文件夹在前，文件在后
  interface MentionOption {
    name: string
    path: string
    isFolder: boolean
    node?: TreeNode  // 如果是文件夹，保存节点引用
  }

  const mentionOptions = useMemo(() => {
    // 可选的文件夹（至少有一个子文件未被选中）
    const folderOptions: MentionOption[] = allFolders
      .filter(folder => {
        const allFiles = getAllFilesInFolder(folder)
        return allFiles.some(file => !selectedFiles.has(file))
      })
      .map(folder => ({
        name: `📁 ${folder.path}/`,
        path: folder.path,
        isFolder: true,
        node: folder
      }))

    // 可选的文件（未被选中的）
    const fileOptions: MentionOption[] = extractedFiles
      .filter(file => !selectedFiles.has(file.name))
      .map(file => ({
        name: file.name,
        path: file.name,
        isFolder: false
      }))

    const all = [...folderOptions, ...fileOptions]

    if (!mentionQuery) return all
    const lower = mentionQuery.toLowerCase()
    return all.filter(opt => opt.path.toLowerCase().includes(lower))
  }, [extractedFiles, mentionQuery, selectedFiles, allFolders])

  const estimatedFileTokens = useMemo(() => {
    if (selectedFiles.size === 0) return 0
    let weight = 0
    for (const file of extractedFiles) {
      if (!selectedFiles.has(file.name)) continue
      if (file.content) {
        weight += estimateTokenWeight(file.content)
      }
    }
    return weight > 0 ? Math.max(1, Math.ceil(weight)) : 0
  }, [selectedFiles, extractedFiles])

  // 计算历史消息的 token 数
  const estimatedHistoryTokens = useMemo(() => {
    const recentMessages = messages.slice(-10).filter(msg => !msg.isStreaming)
    let weight = 0
    for (const msg of recentMessages) {
      // 计算消息内容
      if (msg.content) {
        weight += estimateTokenWeight(msg.content)
      }
      // 计算选中文本
      if (msg.selectedText?.text) {
        weight += estimateTokenWeight(msg.selectedText.text)
      }
      // 简单估算图片 token（每张图片约 85 token）
      if (msg.images && msg.images.length > 0) {
        weight += msg.images.length * 85
      }
    }
    return weight > 0 ? Math.max(1, Math.ceil(weight)) : 0
  }, [messages])

  // 计算 system prompt 的 token 数
  const estimatedSystemPromptTokens = useMemo(() => {
    const base = Math.max(1, Math.ceil(estimateTokenWeight(SYSTEM_PROMPT)))
    const extra = entityTreePromptTokenCount || 0
    return base + extra
  }, [entityTreePromptTokenCount])

  // 计算总 token 数
  const totalTokens = estimatedFileTokens + estimatedHistoryTokens + estimatedSystemPromptTokens

  // 输入时更新 @ 状态
  const updateMentionState = (value: string, cursor: number) => {
    if (extractedFiles.length === 0) {
      setIsMentionListOpen(false)
      setMentionStart(null)
      setMentionQuery("")
      return
    }

    const textBeforeCursor = value.slice(0, cursor)
    const match = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor)

    if (match) {
      const query = match[1] || ""
      setMentionQuery(query)
      setMentionStart(cursor - query.length - 1) // 记录 @ 开始位置
      setIsMentionListOpen(true)
      setHighlightedIndex(0)
    } else {
      setIsMentionListOpen(false)
      setMentionStart(null)
      setMentionQuery("")
    }
  }

  // 处理输入变化并同步 @ 状态
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleInputChange(e)
    const cursor = e.target.selectionStart ?? e.target.value.length
    updateMentionState(e.target.value, cursor)
  }

  // 选择 @ 提示项
  const handleMentionSelect = (option: MentionOption) => {
    if (onFileSelectionChange) {
      const newSelectedFiles = new Set(selectedFiles)
      
      if (option.isFolder && option.node) {
        // 文件夹：选中其下所有文件
        const allFiles = getAllFilesInFolder(option.node)
        for (const file of allFiles) {
          newSelectedFiles.add(file)
        }
        onFileSelectionChange(newSelectedFiles)
      } else {
        // 单个文件
        newSelectedFiles.add(option.path)
        onFileSelectionChange(newSelectedFiles)
      }
    }

    // 将输入框中的 @ 查询文本删除
    if (mentionStart !== null) {
      const before = inputValue.slice(0, mentionStart)
      const after = inputValue.slice(mentionStart + mentionQuery.length + 1)
      const newValue = `${before}${after}`
      setInputValue(newValue)
      setTimeout(() => {
        if (textareaRef.current) {
          const newPos = before.length
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(newPos, newPos)
          adjustTextareaHeight()
        }
      }, 0)
    }

    setIsMentionListOpen(false)
    setMentionQuery("")
    setMentionStart(null)
    setHighlightedIndex(0)
  }

  // 键盘导航 @ 提示
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMentionListOpen) {
      if (e.key === "ArrowDown" && mentionOptions.length > 0) {
        e.preventDefault()
        setHighlightedIndex(prev => (prev + 1) % mentionOptions.length)
        return
      }
      if (e.key === "ArrowUp" && mentionOptions.length > 0) {
        e.preventDefault()
        setHighlightedIndex(prev => (prev - 1 + mentionOptions.length) % mentionOptions.length)
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && mentionOptions.length > 0) {
        e.preventDefault()
        const selected = mentionOptions[highlightedIndex] || mentionOptions[0]
        handleMentionSelect(selected)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setIsMentionListOpen(false)
        return
      }
    }

    handleKeyDown(e, onSendMessage, handleStopStreaming, isStreaming)
  }

  // 当候选为空时关闭列表
  useEffect(() => {
    if (isMentionListOpen && mentionOptions.length === 0) {
      setIsMentionListOpen(false)
    }
  }, [isMentionListOpen, mentionOptions.length])

  // 高亮项滚动到可视范围内
  useEffect(() => {
    if (!isMentionListOpen) return
    const targetOption = mentionOptions[highlightedIndex]
    if (!targetOption) return
    const target = mentionItemRefs.current[targetOption.path]
    if (target) {
      target.scrollIntoView({ block: "nearest" })
    }
  }, [highlightedIndex, mentionOptions, isMentionListOpen])


  // 清理所有对话内容
  const handleClearChat = async () => {
    // 如果当前对话不是只有初始消息，先保存当前对话
    if (onSaveChatHistory && !isOnlyInitialMessage(messages)) {
      await onSaveChatHistory(messages)
    }

    // 重置消息列表和图片
    onMessagesChange([
      {
        id: "1",
        content: "你好！我是你的 Overleaf 助手，有什么可以帮助你的吗？",
        isUser: false,
        timestamp: new Date()
      }
    ])
    clearImages() // 清空图片
    clearSelectedText() // 清空选中文本
    setIsMentionListOpen(false)
    setMentionQuery("")
    setMentionStart(null)
    setHighlightedIndex(0)

    // 重置聊天ID和名称，创建新的聊天会话
    if (onChatIdChange) {
      const newChatId = `chat_${generateId()}`
      onChatIdChange(newChatId)
    }
    if (onChatNameChange) {
      onChatNameChange("")
    }

    clearInput()
  }

  // 处理文件删除
  const handleRemoveFile = (fileName: string) => {
    if (onFileSelectionChange) {
      const newSelectedFiles = new Set(selectedFiles)
      newSelectedFiles.delete(fileName)
      onFileSelectionChange(newSelectedFiles)
    }
  }

  // 批量删除文件（用于删除文件夹时一次性删除所有子文件）
  const handleRemoveFiles = (fileNames: string[]) => {
    if (onFileSelectionChange) {
      const newSelectedFiles = new Set(selectedFiles)
      for (const fileName of fileNames) {
        newSelectedFiles.delete(fileName)
      }
      onFileSelectionChange(newSelectedFiles)
    }
  }

  // 清空所有文件
  const handleClearAllFiles = () => {
    if (onFileSelectionChange) {
      onFileSelectionChange(new Set())
    }
  }

  // 发送消息的包装函数
  const onSendMessage = () => {
    void refreshEntityTreePromptTokens()
    const messageSelectedText = hasSelection ? {
      text: selectedText.text,
      fileName: selectedText.fileName,
      folderPath: selectedText.folderPath
    } : undefined
    handleSendMessage(inputValue, messageSelectedText, uploadedImages)
    clearInput()
    clearImages()
    clearSelectedText()
    setIsMentionListOpen(false)
    setMentionQuery("")
    setMentionStart(null)
    setHighlightedIndex(0)
  }

  return (
    <div className="p-2 border-t border-gray-200">
      {/* 标签区域 */}
      <ContextTags
        selectedFiles={selectedFiles}
        extractedFiles={extractedFiles}
        fileTokenEstimate={estimatedFileTokens}
        historyTokenEstimate={estimatedHistoryTokens}
        systemPromptTokenEstimate={estimatedSystemPromptTokens}
        totalTokenEstimate={totalTokens}
        selectedText={selectedText}
        uploadedImages={uploadedImages}
        onRemoveFile={handleRemoveFile}
        onRemoveFiles={handleRemoveFiles}
        onRemoveSelectedText={clearSelectedText}
        onImageClick={handleImageClick}
        onRemoveImage={handleRemoveImage}
        onClearAllFiles={handleClearAllFiles}
        className="mb-1.5"
      />

      {/* 图片预览模态框 */}
      <FilePreviewModal
        isOpen={previewModal.isOpen}
        onClose={handleClosePreview}
        fileName={previewModal.fileName}
        imageUrls={previewModal.imageUrls}
        isLoading={previewModal.isLoading}
        error={previewModal.error}
      />
      
      <div className="flex items-end space-x-2">
        <div className="flex-1 relative">
          <Textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder="Shift + Enter 换行，支持粘贴图片，输入 @ 添加文件"
            className="min-h-[72px] max-h-[200px] overflow-y-auto text-sm resize-none"
            disabled={isStreaming || disabled}
            autoComplete="off"
            data-form-type="other"
            rows={1}
          />
          {isMentionListOpen && (
            <div className="absolute left-0 right-0 bottom-full z-50 mb-1 overflow-hidden rounded-md border bg-white shadow-lg">
              {mentionOptions.length > 0 ? (
                <ScrollArea className="max-h-60">
                  <div className="py-0.5">
                    {mentionOptions.map((option, index) => (
                      <button
                        key={option.path}
                        ref={el => { mentionItemRefs.current[option.path] = el }}
                        type="button"
                        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-gray-100 ${
                          index === highlightedIndex ? "bg-gray-100 text-blue-600" : ""
                        }`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          handleMentionSelect(option)
                        }}
                      >
                        {option.isFolder ? (
                          <Folder className="h-3 w-3 text-amber-500 flex-shrink-0" />
                        ) : (
                          <FileText className="h-3 w-3 text-blue-500 flex-shrink-0" />
                        )}
                        <span className="truncate flex-1">{option.isFolder ? option.path + '/' : option.name}</span>
                        <span className="ml-1 text-[10px] text-gray-400 flex-shrink-0">
                          {option.isFolder ? '选中文件夹' : '回车选择'}
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="px-2 py-1.5 text-xs text-gray-500">暂无可添加的文件</div>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col space-y-2">
          <Button
            onClick={handleClearChat}
            size="sm"
            variant="outline"
            title="清理对话"
            disabled={isStreaming || disabled}
          >
            <Eraser className="h-4 w-4" />
          </Button>
          <Button
            onClick={isStreaming ? handleStopStreaming : onSendMessage}
            size="sm"
            variant={isStreaming ? "destructive" : "default"}
            title="发送消息"
            disabled={disabled}
          >
            {isStreaming ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
})
