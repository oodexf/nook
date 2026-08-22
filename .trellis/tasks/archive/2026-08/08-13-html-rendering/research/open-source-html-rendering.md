# 开源 AI 聊天项目的 HTML 渲染实现调研

调研日期：2026-08-13。以下结论以官方 GitHub 仓库当前源码为依据。

## 结论摘要

主流实现通常把两类内容分开：

1. **普通消息正文**继续使用 Markdown 组件和严格安全边界，不把任意模型 HTML 当作应用 DOM 执行。
2. **可交互 HTML**进入独立 artifact/preview，由 sandbox iframe 或专门的在线代码沙箱运行。

这与当前项目的约束高度一致：不应放宽 `renderMarkdown` 的普通 DOMPurify 白名单来支持脚本和样式；应新增一个有明确来源、权限和生命周期的隔离预览组件。

## Open WebUI

源码：

- [`Artifacts.svelte`](https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/Artifacts.svelte)
- [`FullHeightIframe.svelte`](https://github.com/open-webui/open-webui/blob/main/src/lib/components/common/FullHeightIframe.svelte)
- [`csp.ts`](https://github.com/open-webui/open-webui/blob/main/src/lib/utils/csp.ts)

确认事实：

- Artifact 在独立面板中展示，不直接并入普通消息正文 DOM。
- HTML 使用 `<iframe srcdoc={...}>`。
- artifact 默认 sandbox 包含 `allow-scripts allow-downloads`；`allow-forms` 与 `allow-same-origin` 由设置项决定。
- 通用 iframe 组件默认 `allowScripts=true`、`allowDownloads=true`，但 `allowForms=false`、`allowSameOrigin=false`、`allowPopups=false`。
- 可向 `srcdoc` 注入管理员配置的 CSP；首个 CSP meta 生效，用于约束预览资源。
- Artifact 面板提供复制、下载、全屏和版本切换。
- Artifact 代码会拦截链接点击；同源路径在 frame 内处理，外部导航被阻止。

风险观察：

- `allow-same-origin` 是可配置开关，而不是安全默认值。若和 `allow-scripts` 同时启用，隔离显著减弱；当前项目不应向普通用户开放该组合。
- CSP 为空时外部资源仍可能加载，因此产品必须明确网络策略。

## LibreChat

源码：

- [`ArtifactPreview.tsx`](https://github.com/danny-avila/LibreChat/blob/main/client/src/components/Artifacts/ArtifactPreview.tsx)
- [`artifacts.ts`](https://github.com/danny-avila/LibreChat/blob/main/client/src/utils/artifacts.ts)
- [`MarkdownBlocks.tsx`](https://github.com/danny-avila/LibreChat/blob/main/client/src/components/Chat/Messages/Content/MarkdownBlocks.tsx)

确认事实：

- 使用 CodeSandbox 的 `@codesandbox/sandpack-react`：`SandpackProvider` + `SandpackPreview`，而不是把 artifact HTML 插入消息 DOM。
- `text/html` 使用 Sandpack `static` template；React artifact 使用 `react-ts` template。
- Artifact 有专门文件映射、模板和依赖配置；HTML 映射为 `index.html`。
- 当前共享配置包含外部 Tailwind CDN，说明其 artifact 预览明确允许网络依赖，而非离线安全默认。
- 消息通过专用 artifact directive 识别，例如 `:::artifact{identifier="..." type="text/markdown" title="..."}`，不是自动执行所有 HTML 代码块。
- 流式 Markdown 被拆为顶层块并 memoize，只有最后增长中的块重新解析；artifact 使用独立 provider 和索引。

权衡：

- Sandpack 适合 React/多文件/依赖安装和运行时错误界面，但依赖、体积和复杂度明显高于单文件 HTML iframe。
- 对当前项目的第一版单文件 HTML 预览属于过度设计。

## LobeChat / Lobe UI

源码：

- [`InlinePreview.tsx`](https://github.com/lobehub/lobe-chat/blob/main/src/components/HtmlPreview/InlinePreview.tsx)
- [`LobeArtifact rehypePlugin.ts`](https://github.com/lobehub/lobe-chat/blob/main/src/features/Conversation/Markdown/plugins/LobeArtifact/rehypePlugin.ts)
- [`LobeArtifact Render`](https://github.com/lobehub/lobe-chat/blob/main/src/features/Conversation/Markdown/plugins/LobeArtifact/Render/index.tsx)
- [`Lobe UI HtmlPreview Iframe.tsx`](https://github.com/lobehub/lobe-ui/blob/master/src/HtmlPreview/Iframe.tsx)
- [`Lobe UI sandbox constants`](https://github.com/lobehub/lobe-ui/blob/master/src/HtmlPreview/const.ts)

确认事实：

- 消息中的 `<lobeArtifact ...>` 被 rehype 插件识别为专用节点，正文显示可点击 artifact 卡片；真正内容在 Portal/HtmlPreview 中展示。
- HTML 预览最终使用 iframe `srcDoc`，默认 sandbox 为 `allow-scripts allow-forms allow-modals`。
- 默认明确不包含 `allow-same-origin`、`allow-popups`、`allow-top-navigation`。源码注释指出前者可能读取父域 cookie/localStorage，后两者增加钓鱼面。
- 静态终态直接构建 `srcdoc`；流式态使用一个持久 shell iframe，通过 `postMessage` 增量更新 DOM，避免每 token 重载脚本和白屏。
- 脚本存在时，自动流式策略会等待内容稳定，避免反复执行；完整 HTML 以 `</html>` 作为稳定信号之一。
- 预览内容超过 5 MiB 时退回源码视图。
- 实现允许 HTML 内脚本、样式及外部脚本/资源运行，但依赖 opaque-origin sandbox 隔离应用。

权衡：

- 流式 shell、DOM morph、脚本重建和自动高度通信成熟但复杂；第一版可只在代码块闭合或消息终态后挂载预览，避免复制整套流式运行时。

## Chatbot UI

源码：

- [`message-markdown.tsx`](https://github.com/mckaywrigley/chatbot-ui/blob/main/components/messages/message-markdown.tsx)
- [`message-markdown-memoized.tsx`](https://github.com/mckaywrigley/chatbot-ui/blob/main/components/messages/message-markdown-memoized.tsx)

确认事实：

- 普通消息使用 `react-markdown`，只注册 GFM 和数学 remark 插件，没有 `rehype-raw`。
- HTML 代码走 code-block 组件；从已检查源码中未发现交互式 HTML artifact 预览。
- 这代表更保守的模式：消息不执行 raw HTML，只显示/复制代码。

## DEEIX-Chat（用户指定参考）

源码：

- [`chat-artifact.tsx`](https://github.com/DEEIX-AI/DEEIX-Chat/blob/dev/frontend/features/chat/components/sections/chat-artifact.tsx)
- [`chat-artifacts.ts`](https://github.com/DEEIX-AI/DEEIX-Chat/blob/dev/frontend/features/chat/model/chat-artifacts.ts)
- [`use-chat-artifacts.ts`](https://github.com/DEEIX-AI/DEEIX-Chat/blob/dev/frontend/features/chat/hooks/use-chat-artifacts.ts)
- [`artifact-preview.ts`](https://github.com/DEEIX-AI/DEEIX-Chat/blob/dev/frontend/shared/lib/artifact-preview.ts)
- [`streamdown-render.tsx`](https://github.com/DEEIX-AI/DEEIX-Chat/blob/dev/frontend/shared/components/markdown/streamdown-render.tsx)
- [`streamdown-html.tsx`](https://github.com/DEEIX-AI/DEEIX-Chat/blob/dev/frontend/shared/components/markdown/streamdown-html.tsx)

DEEIX 实际采用“两层 HTML 能力”，不是简单开启 raw HTML：

### 1. 消息正文中的受限静态 HTML

- Streamdown 的 raw rehype 插件之后仍经过 sanitize schema。
- 仅额外允许 `a/article/aside/details/div/main/p/section/span/summary` 等少量标签，以及受控的 `style`、`href`、`title`、`open` 属性。
- 每个允许标签映射到显式 React 组件；style 再经过 `sanitizeHTMLStyle`，并非把原始字符串直接交给 DOM。
- `script`、iframe、表单等交互载体没有进入这条正文白名单。

这解决的是“模型在正文中做有限视觉排版”，不是运行完整网页。

### 2. HTML/CSS/JavaScript artifact 预览

- 自动识别 `html/htm/xhtml`、`css/scss/sass/less`、`js/javascript/mjs/cjs` fenced code block；无语言标签但内容以常见 HTML 根元素开头也可识别。
- fenced block 仍以源码形式出现在消息中，并增加“打开预览”按钮；预览在桌面右侧可调整宽度的 workspace 展示，移动端占满聊天工作区。
- 面板提供“预览 / 源码”标签、复制、下载、多个 artifact 切换和关闭。
- 预览采用原生 `<iframe srcDoc>`，不是 Sandpack；sandbox **仅为 `allow-scripts`**。
- iframe 还设置 `referrerPolicy="no-referrer"`，并通过 Permissions Policy 显式禁止摄像头、麦克风、定位、支付、剪贴板、全屏、USB、蓝牙等能力。
- 注入的 CSP 是离线白名单：`default-src 'none'`、`connect-src 'none'`、`form-action 'none'`、`frame-src 'none'`、`worker-src 'none'`；只允许 inline style/script，以及 `data:`/`blob:` 图片和媒体、`data:` 字体。
- 没有 `allow-same-origin`，所以脚本在 opaque origin 中运行，不能读取聊天应用 cookie/localStorage 或父 DOM。
- HTML preview 会重建文档，把受控 CSP、主题 CSS 变量、reset CSS 和错误捕获脚本放入 head，再放入用户 head/body。
- CSS artifact 被套入固定示例页面；JavaScript artifact 被套入带 `#root` 和轻量 console 面板的固定文档。
- 运行错误与未处理 Promise rejection 会显示在 iframe 内，不影响聊天应用。
- 下载的是组装后的可运行 HTML，而复制的是原始源码。
- 流式期间也提取尚未闭合的 fenced block，并在桌面自动打开/持续替换同一 artifact；关闭后通过逻辑 identity 避免同一流式 artifact 再次强制弹开。

### 对当前项目的直接启示

DEEIX 的 artifact 安全策略比 Open WebUI/LobeChat 默认值更收敛，也与当前项目的严格安全规范更匹配。可直接借鉴其 MVP 核心：

1. `html/css/js` fenced code block 作为明确来源；
2. 消息代码块保留源码和复制，并新增显式预览按钮；
3. 侧边/移动全屏的“预览 + 源码”面板；
4. 原生 `srcdoc` iframe，sandbox 仅 `allow-scripts`；
5. 离线 CSP、`no-referrer`、Permissions Policy；
6. 注入主题快照、错误显示和下载能力。

不建议第一版照搬其“流式代码尚未闭合就自动打开并执行”的行为：当前项目以安全和简单为先，终态或闭合后由用户显式打开，可以避免流式脚本反复执行、预览抢焦点和额外 artifact identity 状态机。若用户明确重视边生成边预览，再单独采用其流式状态设计。

## 适用于当前项目的方案比较

### A. 放宽消息正文 DOMPurify 白名单

可支持静态排版标签，但不适合完整网页预览：

- `style` 会影响应用或制造遮罩/欺骗界面；
- `script`、事件属性不能安全地在同一 DOM 中开放；
- 表单、图片、SVG、iframe 和网络 URL 都需要新增庞大策略；
- 会破坏当前“单一严格 Markdown HTML 边界”和 KaTeX 来源隔离。

结论：只适合将来少量、明确标签的富文本扩展，不适合作为 HTML artifact MVP。

### B. 原生 sandbox iframe + `srcdoc`（推荐 MVP）

- 从闭合的 `html` fenced code block 或专用 artifact 语法提取源码。
- 消息正文仍显示代码/预览卡片；用户显式打开独立预览。
- sandbox 默认仅 `allow-scripts`（若第一版批准 JS），不包含 `allow-same-origin`、`allow-forms`、`allow-modals`、`allow-popups`、`allow-top-navigation`、`allow-downloads`。
- 使用 CSP 明确阻断或限制 `connect-src`、`img-src`、`media-src`、`font-src`、`frame-src` 和表单目标。
- 不给 iframe `src` 指向应用源，不把认证数据通过 `postMessage` 传入。
- 终态/闭合后再挂载，避免流式期间反复执行脚本。

优点：浏览器原生、无新增运行时依赖、适合单文件 HTML/CSS/JS、隔离边界清晰。

### C. Sandpack

适合多文件 React、npm 依赖、控制台和运行时错误体验，但包体、worker/bundler、网络和维护成本高。建议延后到真正需要多文件 artifact 时再评审。

## 推荐的第一原则方案

用户实际需要的是“看见模型写出的网页效果”，而不是“让模型控制聊天应用 DOM”。满足这一目标的最小机制是：

1. 保留 Markdown 的严格净化；
2. 把 HTML 识别为一个有边界的 artifact；
3. 仅在用户打开预览时，将完整源码交给 opaque-origin sandbox iframe；
4. 用最小 sandbox 与 CSP 决定它能做什么；
5. 源码/复制始终可用，预览失败可退回源码。

下一项必须由用户决定的是能力等级：纯 HTML/CSS，还是允许 JavaScript；这会直接决定 sandbox、CSP、流式生命周期和测试矩阵。
