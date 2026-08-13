# 添加 HTML 渲染功能

## Goal

参照 DEEIX-Chat 的两层方案，让助手消息既能在正文中显示少量、安全的静态 HTML 排版，也能把 HTML/CSS/JavaScript 代码作为 artifact 在隔离面板中预览，同时保持现有 Markdown、公式、流式输出和应用安全边界。

## Background / Confirmed Facts

- 前端使用 Svelte 5；助手消息通过 `frontend/src/lib/markdown/MarkdownContent.svelte` 展示。
- Markdown 管线位于 `frontend/src/lib/markdown/render.ts`，使用 `marked` 解析和 DOMPurify 显式白名单清洗。
- `MarkdownContent.svelte` 是项目唯一允许的 `{@html}` 插入点；当前普通 Markdown 禁止 `style`、`script`、`iframe`、图片、SVG、表单、事件属性和远程嵌入。
- KaTeX 使用独立来源通道和专属最小净化策略；任意模型 HTML 不能复用 KaTeX 特权通道。
- 现有安全测试覆盖脚本、事件属性、危险 URL、iframe、SVG、远程嵌入、畸形 HTML、表单和样式载体。
- HTML 代码围栏当前作为惰性转义文本显示并提供复制；流式助手内容按节流快照复用同一 Markdown 管线；用户消息不进入 Markdown/HTML 渲染管线。
- 开源调研显示：Open WebUI、LobeChat 和 DEEIX-Chat 使用 sandbox iframe 展示可交互 HTML；LibreChat 使用更重的 Sandpack；Chatbot UI 不执行 raw HTML。
- DEEIX-Chat 同时提供受限正文 HTML 与 artifact 预览。其 artifact 使用 `srcdoc`、`sandbox="allow-scripts"`、离线 CSP、`no-referrer` 和严格 Permissions Policy；用户批准当前项目完整采用这类两层产品范围。

## Requirements

### R1. Inline static HTML

- 仅助手消息正文支持受限静态 HTML；用户消息继续按纯文本转义。
- 新增允许的正文容器标签跟随 DEEIX：`div`、`section`、`article`、`aside`、`main`、`span`、`details`、`summary`，并保留现有 Markdown 安全标签。
- 正文禁止 `script`、iframe、表单、图片/SVG、事件属性和其他可执行载体。
- 正文 `style` 跟随 DEEIX 的 `SAFE_HTML_STYLE_PROPERTIES` 与值检查：允许其 flex/grid、尺寸、间距、position、transform、z-index 等属性集合；拒绝 `url()`、`expression()`、`javascript:`、`@import`、HTML/CSS 结构字符、超过 120 字符的单值和非批准 CSS 变量引用。
- 外层消息容器必须裁剪/约束正文 HTML，使高 z-index、fixed/absolute、transform、超大尺寸或 overflow 不能覆盖应用其他区域或制造页面级横向滚动。
- 现有 Markdown、代码围栏、公式和用户消息不得出现非预期回归。

### R2. Artifact detection and source behavior

- Artifact 识别完全跟随 DEEIX：
  - 识别 `html/htm/xhtml`、`css/scss/sass/less`、`js/javascript/mjs/cjs` fenced code block；
  - 无语言或 `markdown` 代码块若以 `<!doctype html>`、`<html/head/body/article/canvas/div/main/section/style/script/svg>` 等 HTML-like 内容开头，识别为 HTML；
  - 若消息中没有可识别 fenced block，但整条助手消息是 HTML-like 内容，则创建一个 HTML artifact。
- 代码块继续显示源码、语言和复制操作，并为可预览内容增加“打开预览”操作。
- 第一版不在流式未闭合代码块中自动执行或自动打开；闭合代码块或终态消息才可由用户显式打开。
- 历史助手消息无需数据迁移，重新展示时按同一规则获得 artifact 能力。

### R3. Artifact workspace

- 面板提供预览/源码切换、复制原始源码、下载组装后的可运行 HTML、关闭和同一对话内多个 artifact 切换。
- 桌面端显示右侧分栏，默认比例根据可用宽度选择约 1/3～1/2；用户可在 1/3～1/2 范围拖拽调整，并可双击分隔条恢复默认。
- 移动端 artifact 覆盖聊天工作区；关闭后恢复聊天视图和合理焦点。
- HTML 直接组成预览文档；CSS 注入固定示例页面；JavaScript 注入带 `#root` 与轻量 console 的固定页面。
- 注入当前主题的受控 CSS 变量快照、基础 reset 和预览内错误捕获；脚本错误与未处理 Promise rejection 只在 iframe 内显示。
- 下载使用组装后的预览 HTML，复制使用模型原始源码。

### R4. Artifact security boundary

- 模型输出始终视为不可信输入。
- Artifact 使用独立 `<iframe srcdoc>`，sandbox 仅包含 `allow-scripts`，不得包含 `allow-same-origin`。
- iframe 使用 `referrerPolicy="no-referrer"`，Permissions Policy 显式禁止摄像头、麦克风、定位、剪贴板、支付、全屏、MIDI、串口、USB、蓝牙等无关能力。
- 注入离线 CSP：`default-src 'none'`，拒绝网络连接、外部 frame、worker、object、manifest、prefetch、表单提交和导航；仅允许 inline script/style，以及预览所需的 `data:`/`blob:` 图片/媒体与 `data:` 字体。
- 预览不得访问父应用 DOM、cookie/localStorage、认证信息或应用状态，也不得通过 `postMessage` 接收敏感数据。
- 不得通过放宽正文 DOMPurify 白名单来执行任意交互式 HTML。

### R5. Delivery quality

- 增加正文标签/style 白名单、容器隔离、artifact 提取、预览文档、CSP/sandbox、交互、流式未闭合输入、历史消息、移动布局和现有 Markdown 回归测试。
- 记录新增依赖与生产构建体积影响；优先使用浏览器原生 iframe，不引入 Sandpack 或代码编辑器依赖。

## Acceptance Criteria

- [ ] `AC-01` 约定的静态 HTML 标签可在助手正文中显示；未允许标签、属性和 style 值被移除。
- [ ] `AC-02` DEEIX 同等 style 范围不能覆盖消息区域之外的页面、制造不可恢复遮罩或页面级横向滚动。
- [ ] `AC-03` HTML/CSS/JavaScript fenced code block 及批准的 HTML-like 回退规则能稳定识别 artifact，普通代码块不误触发。
- [ ] `AC-04` 代码块保留源码与复制，并可通过显式操作打开 artifact workspace；流式未闭合内容不执行、不自动打开、不抢焦点。
- [ ] `AC-05` 面板支持预览/源码、复制、下载、关闭和多个 artifact 切换；桌面分栏可在 1/3～1/2 拖拽并双击复位，移动端覆盖聊天工作区。
- [ ] `AC-06` HTML、CSS 和 JavaScript artifact 正确运行；主题快照可用，运行错误仅显示在预览中且不破坏聊天页面。
- [ ] `AC-07` iframe sandbox 仅为 `allow-scripts` 且不含 `allow-same-origin`；预览不能访问父 DOM、cookie/localStorage、会话凭据或未批准能力。
- [ ] `AC-08` 外网、referrer、导航、表单、frame、worker 和高权限 API 被 CSP、sandbox、referrer policy 与 Permissions Policy 阻断。
- [ ] `AC-09` 历史消息无需迁移即可预览；切换对话会关闭/重置不属于新对话的 active artifact。
- [ ] `AC-10` 现有 Markdown、KaTeX、代码复制、流式节流及 XSS 测试无回归。
- [ ] `AC-11` 前端 `check`、`lint`、`test` 和生产构建通过，并记录资源增量。

## Out of Scope

- 服务端托管、公开发布或分享用户生成网页。
- 多文件 Web IDE、npm 包安装、React/Vue 编译、Sandpack 或后端运行环境。
- 外部 CDN、图片 URL、fetch/WebSocket/API 请求等网络访问。
- 在流式未闭合代码块中自动打开或执行预览。
- 保存用户对 artifact 源码的编辑；第一版源码视图只读。
- 绕过浏览器沙箱执行系统命令。
