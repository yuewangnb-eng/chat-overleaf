<p align="center">
  <img src="./assets/icon.png" alt="Chat Overleaf Logo" width="96" />
</p>

<h1 align="center">Chat Overleaf ✨</h1>

<p align="center"><b>Overleaf AI 助手 | 基于 Plasmo 的 Overleaf AI 对话助手</b></p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/chat-overleaf/anofakjncihlgcmndcdipflonpgcgdmk">
    <img src="https://img.shields.io/badge/Chrome-商店安装-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Web Store" />
  </a>
</p>

---

## 📥 安装方式

### 方式一：Chrome 商店安装（推荐）

直接从 Chrome 网上应用店安装：

👉 [**点击安装 Chat Overleaf**](https://chromewebstore.google.com/detail/chat-overleaf/anofakjncihlgcmndcdipflonpgcgdmk)

### 方式二：手动加载 zip（暂停更新）

1. 下载 GitHub Releases 中的 zip 文件并解压

2. 在 Chrome 浏览器中加载插件
   - 打开 Chrome 扩展管理页面（`chrome://extensions/`）
   - 开启右上角的「开发者模式」
   - 点击「加载已解压的扩展程序」
   - 选择解压目录下的 `chrome-mv3-prod` 文件夹

3. 完成加载后，访问 Overleaf 网站点击右下角图标即可（注意先添加模型秘钥）

---

## 🚀 基本功能

### 💬 智能对话系统
- 👥 <b>无缝集成</b>：完美融入 Overleaf 界面，不影响正常编辑体验
- 📝 <b>选中文本提问</b>：选中编辑器内容即可直接提问，自动作为上下文
- 📍 <b>自动附带选区来源路径</b>：选中提问时自动附带文件路径/目录信息，方便 AI 精准定位与引用
- ⌨️ <b>Ctrl + L 快捷唤起</b>：支持全局快捷键与选区浮层按钮，一键打开侧边栏并聚焦输入（可携带当前选中文本/路径）
- 🖼️ <b>多模态支持</b>：支持图片上传、粘贴和拖拽，实现图文混合对话
- 📱 <b>响应式设计</b>：支持侧边栏宽度调整，适配不同屏幕尺寸
- 💭 <b>思考过程展示</b>：支持显示 AI 的思考过程

### 📁 文件内容管理
- 📄 <b>智能提取</b>：自动获取当前文件或手动点击即可提取整个项目内容作为 AI 上下文
- 🌲 <b>文件树视图</b>：以树形结构展示项目文件，支持文件夹展开/折叠
- 🔄 <b>实时同步</b>：编辑器内容变化时自动更新已提取的文件
- 📋 <b>文件选择</b>：灵活选择需要包含在对话中的文件
- 🧾 <b>自动附带文件列表提示</b>：每次提问自动携带最新文件/文件夹列表与 Token 信息，帮助模型理解项目结构（可配合 @ 快捷引用）
- 💾 <b>文件缓存</b>：按项目 ID 缓存文件列表，避免重复获取
- 📊 <b>Token 预估</b>：显示选中文件的预估 Token 数量
- ✅ <b>批量操作</b>：支持全选/清空文件选择

### 💾 对话历史管理
- 📚 <b>历史记录</b>：自动实时保存对话历史，支持加载和管理多个会话（防止刷新/异常导致丢失）
- 🌿 <b>分支对话</b>：支持从历史消息创建新的对话分支
- 🗑️ <b>批量管理</b>：支持删除单个或清空所有历史记录

### 🧠 模型管理
- 🔧 <b>内置模型</b>：预配置多个主流 AI 模型（DeepSeek、Kimi、Qwen、Gemini 等）
- ⚙️ <b>自定义模型</b>：支持添加自定义 AI 服务商和模型
- 📌 <b>模型置顶</b>：常用模型可置顶显示，快速切换
- 🔍 <b>自动获取模型列表</b>：输入模型 ID 后自动获取对应服务商的模型列表

### 🎯 便捷交互
- ⌨️ <b>@ 快捷引用</b>：使用 @ 符号快速引用文件
- 🎨 <b>优化的 UI</b>：更紧凑的界面设计，提升使用体验

### 📝 智能插入与差异审阅
- 🧩 <b>AI 生成替换块</b>：聊天气泡自动渲染搜索/替换 diff，支持正则或普通模式
- 🚀 <b>一键应用/拒绝</b>：直接将修改写回 Overleaf 编辑器或忽略
- 👀 <b>智能预览与高亮</b>：自动跳转并高亮待替换区域，支持悬浮浮层内联查看
- ↩️ <b>撤销应用/撤销拒绝</b>：已应用或已拒绝的修改可恢复为候选并重新高亮
- 🧷 <b>长文本替换更稳定</b>：提升替换匹配的字符串长度上限，增强大段落 diff 的应用成功率与鲁棒性

---

##  界面预览

![Chat Overleaf](./assets/img/example.png)
![Settings](./assets/img/setting.png)
![Several](./assets/img/several.png)


---

## 🛠️ 本地开发

### 环境要求
- Node.js 16+
- pnpm

### 开发步骤

1. 克隆项目

   ```bash
   git clone https://github.com/anuin-cat/chat-overleaf.git
   cd chat-overleaf
   ```

2. 安装依赖

   ```bash
   pnpm install
   ```

3. 启动开发服务器

   ```bash
   pnpm dev
   ```

4. 加载插件到浏览器
   - 打开 Chrome 扩展管理页面（`chrome://extensions/`）
   - 开启开发者模式
   - 点击「加载已解压的扩展程序」
   - 选择 `build/chrome-mv3-dev` 文件夹

5. 访问 Overleaf 网站测试功能

---

## 📦 构建生产版本

```bash
pnpm build
```

---

## ChatGPT Pro / Codex Bridge

本分支新增了 `Codex` 供应商。它不使用 OpenAI API Key，而是通过本地 Codex CLI 的 `codex app-server` 复用你的 ChatGPT Plus/Pro 登录态。

这套功能分为两部分：

- 浏览器插件：提供 Overleaf 侧 UI、模型选择和请求转发。
- OverleafGPT Local Connector：运行在用户电脑本地，负责启动 `codex app-server` bridge，并注册 `overleafgpt-codex://` 本地启动协议。

浏览器插件本身不能注册本地协议，也不能直接启动 `node` 进程。因此，只分发浏览器插件是不够的；普通用户还需要先安装 Local Connector。

### 普通用户

1. 安装 Codex CLI 并登录：

   ```bash
   npm install -g @openai/codex
   codex login
   ```

2. 安装 OverleafGPT Local Connector。

   Local Connector 需要完成两件事：安装本地 bridge 文件，并注册 `overleafgpt-codex://` 协议。

3. 加载浏览器插件，打开 Overleaf，进入设置 -> 模型服务 -> `Codex`。

4. 点击 `连接到本地 Codex`。

   如果连接失败，说明 Local Connector 没有安装或协议没有注册成功。插件会提示先安装 OverleafGPT Local Connector。

### 开发者从源码运行

1. 安装依赖：

   ```bash
   corepack pnpm install
   ```

2. 安装 Codex CLI 并登录：

   ```bash
   npm install -g @openai/codex
   codex login
   ```

3. 注册本地启动协议：

   ```powershell
   corepack pnpm register-bridge-protocol
   ```

   注册后，插件设置页的 `连接到本地 Codex` 按钮会按需启动本地 bridge。

4. 也可以手动启动本地 bridge：

   ```bash
   corepack pnpm bridge
   ```

5. 启动扩展开发服务：

   ```bash
   corepack pnpm dev
   ```

### 模型和参数

在扩展设置中选择 `Codex`，使用内置的 `GPT-5.4 (Codex)` 或 `GPT-5.5 (Codex)` 模型。也可以在该供应商下点击“添加模型”，模型列表会从本地 Codex 缓存自动读取。

在“对话参数”中设置 `Codex reasoning effort`，可选 `low`、`medium`、`high`、`xhigh`。该参数只会通过本地 bridge 传给 Codex，不影响普通 API 模型。

默认 bridge 地址为 `http://127.0.0.1:17381`。如需修改端口，可设置环境变量 `OVERLEAFGPT_CODEX_BRIDGE_PORT`。

---

### Codex Session Memory

Codex Bridge 会按同一个 Overleaf 项目和同一个 OverleafGPT 聊天会话复用同一条 Codex thread：

```text
overleaf:<projectId>:chat:<currentChatId>
```

Codex 模型名不参与这个 session key。因此在同一个聊天里从 `gpt-5.4` 切换到 `gpt-5.5`，仍会沿用原来的 Codex 记忆。

某个 session 第一次请求时，bridge 会把当前系统规则和可见的近期聊天上下文发给 Codex，用于初始化 thread。之后同一个 session 的请求会复用 Codex thread，只发送最新 Overleaf 上下文和当前用户问题，避免每轮重复传旧历史，同时仍然每轮刷新项目文件信息。

本地自检端点：

```bash
curl http://127.0.0.1:17381/v1/codex/sessions
curl -X POST http://127.0.0.1:17381/v1/codex/memory-check -H "Content-Type: application/json" -d "{\"model\":\"gpt-5.4\",\"reasoning_effort\":\"medium\"}"
curl -X POST http://127.0.0.1:17381/v1/codex/session/reset -H "Content-Type: application/json" -d "{}"
```

如果启动 bridge 时提示端口 `17381` 被占用，通常有两种情况：

- 已经有一个 OverleafGPT Codex Bridge 在运行：可以直接继续使用，不需要重复启动。
- 其他程序占用了端口：关闭占用端口的程序，或在 PowerShell 中释放端口后重新启动 bridge。

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17381 |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ }

corepack pnpm bridge
```

---

## WebChat / web_sync Provider

本分支新增独立的 `web_sync` provider：

- `ChatGPT Web`
- `DeepSeek Web`

它们不使用服务商 API Key，也不依赖 `Codex` / Codex Bridge。扩展会把 OverleafGPT 中的一次提问转发到已经打开并登录的 ChatGPT 或 DeepSeek 网页标签页，再把网页生成的回答流式返回到 OverleafGPT。

### 使用方式

1. 在同一个浏览器中打开并登录：
   - ChatGPT: `https://chatgpt.com/`
   - DeepSeek: `https://chat.deepseek.com/`
2. 回到 Overleaf，打开 OverleafGPT 设置。
3. 在“模型服务”中选择 `ChatGPT Web` 或 `DeepSeek Web`。
4. 点击“检测网页连接”，确认扩展能看到对应 WebChat 标签页。
5. 在模型列表中选择：
   - `ChatGPT Web`
   - `DeepSeek Web`
   当前具体模型在 ChatGPT / DeepSeek 网页版中选择。
6. 正常提问即可。

### 设计边界

- `web_sync` 是单独 transport，不会影响普通 API provider，也不会影响 `Codex`。
- 第一版使用网页当前选中的模型，不自动切换网页模型。
- 第一版只把本次 OverleafGPT 请求投递到 WebChat 页面，不读取历史记录。
- ChatGPT / DeepSeek 网页可能把这次对话保存在各自网页历史中，但这取决于网页账号设置、临时聊天设置和服务商策略。
- 该方案依赖网页 DOM，ChatGPT / DeepSeek 页面结构变化时可能需要更新 content script。

### 权限说明

为了实现网页桥接，扩展需要增加以下页面权限：

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://chat.deepseek.com/*`

这些权限仅用于用户选择 `ChatGPT Web` / `DeepSeek Web` provider 时向对应网页发送问题并读取本次回复。

---

## 📋 TODO

- [x] ✍️ 支持添加编辑器选中内容对话
- [x] 💾 添加对话历史持久化
- [x] 🔄 支持当前编辑器内容自动更新
- [x] 🧩 优化上下文选中逻辑
- [ ] 📝 支持自定义 prompt 模板
- [x] 🛠️ 支持自定义添加模型
- [x] 🖼️ 支持图文问答
- [x] 🌲 文件树视图展示
- [x] 💾 文件列表缓存机制
- [x] 📊 Token 数量预估
- [x] ⌨️ @ 快捷引用功能
- [x] 💭 思考过程展示
- [x] 🔍 自动获取模型列表

---

### ⚡️ 基于 [Plasmo](https://github.com/PlasmoHQ/plasmo) 构建

