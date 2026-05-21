# Chat Overleaf Extended

本项目是 [anuin-cat/chat-overleaf](https://github.com/anuin-cat/chat-overleaf) 的 extended fork，在原项目基础上增加了新的模型调用方式：Codex provider、ChatGPT/DeepSeek Web provider; 优化了上下文管理规则以减少Token消耗。

## 原项目简介

原项目 Chat Overleaf 是一个基于 Plasmo 构建的浏览器扩展，用于在 Overleaf 页面中提供基于大语言模型的问答和写作助手。

原项目主要功能包括：

- 在 Overleaf 页面中打开侧边栏和LLM对话
- 支持选中编辑器文本后提问、润色
- 支持读取当前项目文件和文件树作为上下文
- 支持多模型供应商配置
- 支持图片输入
- 支持对话历史
- 支持根据LLM的输出的替换、插入、新建文件指令修改 LaTeX 文件

原项目地址：

https://github.com/anuin-cat/chat-overleaf

## 本版本新增功能

本版本在原项目基础上新增和调整了以下能力：

- 新增 Codex provider，可通过本地 Codex Bridge 使用已登录的 Codex / ChatGPT Plus / Pro 能力
- 新增 ChatGPT/DeepSeek Web provider，通过已登录的 ChatGPT/DeepSeek 网页进行 WebSync 桥接，可以让 Overleaf 插件中的提问和 ChatGPT/DeepSeek 网页版、和手机版对话同步。
- 为新的providers提供新的记忆管理和上下文模式，针对原项目基于 API 调用时每轮都需要重复传入系统角色规则、历史对话和上下文信息，导致 token 消耗较高的问题，本版本在 Codex 及 ChatGPT / DeepSeek Web 等具备会话记忆能力的 provider 中，尽量复用模型侧已有记忆，减少重复上下文传输：
   - 新增 Codex 记忆自检与复用机制：支持在同一 Overleaf 项目、同一聊天会话中复用同一条 Codex thread 记忆，并可通过自检确认记忆复用是否生效。
   - 新增 WebSync 首次和后续提问的记忆功能，支持同一对话切换 provider 时的上下文补发逻辑
- 新增长回答折叠 / 展开 UI

## 本版本使用方法

待补充。

## 新增功能说明

### Codex Provider

Codex provider 不使用服务商 API key，而是通过本地 Codex Bridge 调用用户本机已经登录的 Codex 环境，通过Codex Bridge 安全配对 token，避免任意本机网页直接调用 bridge，确保连接安全。

**基本流程：**

1. 用户在本机安装并登录 Codex。
2. 插件设置中选择 `Codex` provider。
3. 用户点击设置页中的“连接到本地 Codex”。
4. 扩展通过 `overleafgpt-codex://` 本地协议启动 Codex Bridge。
5. Codex Bridge 在本机调用 `codex app-server`。
6. Chat Overleaf Extended 将当前问题、上下文和必要的历史信息发送到本地 bridge。
7. bridge 将 Codex 的流式回答转换为 OpenAI Chat Completions 风格的响应返回给扩展。

**本地 Bridge 安全设计：**

Codex Bridge 默认只监听：
```text
127.0.0.1:17381
```
`/health` 端点保持公开，仅用于判断 bridge 是否正在运行，不返回 token、账号信息或登录凭据。

以下接口需要本地 bridge token：
- `/v1/models`
- `/v1/chat`
- `/v1/chat/stream`
- `/v1/codex/session/reset`
- `/v1/codex/memory-check`
- `/v1/codex/sessions`

1. 用户点击“连接到本地 Codex”。
2. 扩展生成一次性 `nonce`。
3. 扩展打开 `overleafgpt-codex://start?nonce=...`。
4. 本地启动脚本把 nonce 传给 bridge。
5. 扩展调用 `/v1/bridge/pair`。
6. bridge 校验 nonce。
7. 校验通过后返回本地 bridge token。
8. 扩展保存 token。
9. 后续 Codex 请求都会自动带上 `X-OverleafGPT-Bridge-Token`。

### ChatGPT Web / DeepSeek Web Provider

WebSync provider 独立于 API provider 和 Codex Bridge。

它不需要 API key，而是把 Chat Overleaf Extended 中的一次请求转发到已经登录的 ChatGPT 或 DeepSeek 网页标签页，再把网页生成的回答同步回 Chat Overleaf Extended。



### Codex/Web Providers 记忆方式及上下文管理

原项目主要基于 API 接口调用模型。为了让模型理解任务，每次请求通常都需要重新传入系统角色规则、选中文件内容和历史对话信息；当项目文件较多或对话较长时，这会造成明显的 token 消耗。

本版本优化了插件记忆管理和上下文传输逻辑。对于 Codex 和 ChatGPT / DeepSeek Web 这类具备会话记忆能力的 provider，插件会尽量利用模型侧已有的会话记忆，减少重复发送固定规则和历史上下文。

#### Codex 记忆方式及上下文管理
Codex Bridge 会按同一个 Overleaf 项目和同一个聊天会话复用同一条 Codex thread 记忆，并提供记忆自检能力，用于确认 thread 复用是否真的生效。

#### Web Providers 记忆方式及上下文管理
**首次**使用某个 Web provider 时，发送角色规则、历史对话、当前 Overleaf 上下文和当前用户请求。**后续**连续使用同一个 Web provider 时，只发送当前 Overleaf 上下文和当前用户请求。

#### 统一项目统一对话切换 providers 的记忆方式

- 切换 Codex 内的模型，例如从 `gpt-5.4` 切到 `gpt-5.5`，不会自动开启新的记忆；仍复用当前项目和当前聊天对应的 Codex thread。
- 从其他 provider 切回 Codex 提供两种上下文模式：
   - `Light Memory`：复用 Codex thread 后，不传入对话全部历史记录；
   - `Full Memory`：复用 Codex thread 的同时，每轮仍传入全部聊天历史；
- 从其他 provider 切回 Web provider 时，补发历史对话和当前上下文，避免网页侧忘记中间发生的对话。

**记忆管理流程图见：**

![Chat Overleaf Extended 提示词传入内容流程图](docs/prompt-flowchart.svg)


### 长回答折叠

当助手回答内容较长时，消息区域会显示“折叠回答 / 展开回答”按钮。默认仍展示完整回答，用户可手动折叠长回答以减少侧边栏占用空间。流式输出过程中不会显示折叠按钮，回答完成后才判断是否需要显示。




