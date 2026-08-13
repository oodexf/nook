# HTML 渲染技术设计

## Architecture and boundaries

采用 DEEIX 风格的两条来源分离管线：

```text
assistant source
  ├─ Markdown lane
  │    marked -> strict DOMPurify + approved inline-HTML tags/styles
  │    -> existing MarkdownContent {@html} boundary
  │
  └─ Artifact lane
       extract previewable fenced blocks / HTML-like fallback
       -> typed ChatArtifact records
       -> user opens workspace
       -> build standalone preview document
       -> opaque-origin sandbox iframe srcdoc
```

用户消息仍按 Svelte 文本转义。服务端、数据库和 API 继续保存原始消息字符串，无数据迁移。

## Inline HTML lane

### Tags and attributes

在现有严格标签集上增加 `div`、`section`、`article`、`aside`、`main`、`span`、`details`、`summary`。`details` 只增加 `open`；现有链接仍只接受受控 `href/title/class`。不增加 script、style 标签、图片、SVG、表单、iframe、事件属性、data/aria 任意属性。

### Style sanitizer

普通 Markdown 的 DOMPurify 配置可允许 `style` 属性，但必须通过独立 hook 做两级过滤：

1. 属性名转换/规范化后必须位于 DEEIX `SAFE_HTML_STYLE_PROPERTIES` 同等集合；
2. 值必须有限长度且拒绝 `url(`、`expression(`、`javascript:`、`@import`、`<>{}`，CSS `var()` 只能引用项目批准的主题变量。

KaTeX 仍保留原有独立 style 策略；不能合并两个 sanitizer 的权限或来源。实现应为普通 HTML 与 KaTeX 分别选择验证函数，避免全局 DOMPurify hook 把某条 lane 的权限泄漏给另一条。

### Containment

允许 DEEIX 同等 style 属性意味着源码可使用 position/transform/z-index。安全不能只靠属性白名单，消息渲染根需要建立布局 containment：`position: relative`、`isolation: isolate`、`contain`（在 Safari 支持范围内选择）、`overflow: clip/hidden` 与最大宽度约束。测试必须验证 fixed/absolute、极端 z-index、100vw、负位移和超大宽高不会覆盖 header/composer/sidebar 或产生页面横向滚动。

## Artifact model and extraction

建议新增纯 TypeScript 模块定义：

```ts
type ArtifactKind = "html" | "css" | "javascript";
type ChatArtifact = {
  id: string;
  messageId: string;
  blockIndex: number;
  kind: ArtifactKind;
  language: string;
  code: string;
  complete: boolean;
};
```

提取器按行扫描 fenced code，支持反引号与波浪线、至少三个且闭合符长度不短于开启符。语言与 HTML-like fallback 规则跟随 PRD。artifact ID 由消息 ID 与同消息 block index 构成；流式 overlay 可使用稳定的临时 message key，但第一版未闭合块不暴露可执行入口。

提取不应依赖渲染后 DOM 文本，避免代码复制格式、HTML entity 和流式快照影响原始源码。持久化消息从 `message.content` 提取；流式终态从最终字符串提取。

## Code-block integration

现有 `MarkdownContent` 在净化后扫描 `pre` 并注入复制按钮。扩展同一后处理阶段：

- 从渲染前提取器得到 artifact block index/kind/code；
- 对应的 fenced `pre` 获得真实 DOM “打开预览”按钮；
- 按钮通过 typed callback 把 artifact 意图传给上层，不在 HTML 字符串中写事件或未净化数据；
- 流式 `suppressCodeCopy` 路径同样抑制预览按钮，确保 transient content 不执行。

需要给 `MarkdownContent` 增加可选 artifact callback/context，而不是创建新的 `{@html}`。

## Workspace state and layout

`ChatPane` 拥有当前对话的 artifact UI 状态：全部可用 artifacts、active artifact ID、比例和关闭/切换操作。消息组件只上报打开意图。

桌面：把当前 chat area 与 artifact panel 组成可调整双列区域。比例限制 1/3～1/2；pointer capture 驱动拖拽，双击恢复基于 viewport 的默认比例。分隔条键盘可操作，支持方向键调整并暴露 slider/separator 语义。

移动：artifact panel 在 chat pane 内绝对覆盖；打开时聚焦标题/关闭按钮，关闭后恢复触发按钮。切换对话时清空 active artifact，防止旧对话源码留在新对话旁。

## Preview document builders

使用纯函数：

- `buildHtmlPreviewDocument(code, theme)`：保留用户 head/body，但在最前注入安全 meta/CSP、主题、reset、错误 runtime；避免用户 CSP 抢先，确保平台 CSP 是文档中的第一个 CSP。
- `buildCssPreviewDocument(code, theme)`：CSS 放入 `<style>`，正文使用固定示例卡片/按钮/网格。
- `buildJavaScriptPreviewDocument(code, theme)`：提供 `#root`、轻量 console 捕获和用户 script；转义 `</script` 防止提前闭合包装脚本。

主题快照只枚举批准的 CSS 自定义属性；拒绝结构字符、超长值和未批准变量。预览内部错误处理监听 `error` 和 `unhandledrejection`，通过 `textContent` 写入错误节点。

## iframe security contract

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  allow="accelerometer 'none'; ..."
  srcdoc="..."
/>
```

CSP 基线跟随 DEEIX：

```text
default-src 'none';
base-uri 'none';
form-action 'none';
object-src 'none';
frame-src 'none';
child-src 'none';
worker-src 'none';
connect-src 'none';
manifest-src 'none';
prefetch-src 'none';
navigate-to 'none';
img-src data: blob:;
media-src data: blob:;
font-src data:;
style-src 'unsafe-inline';
script-src 'unsafe-inline'
```

关键不变量：永不加入 `allow-same-origin`，不向 frame 发送 auth/app state，不接受 frame 发起的特权请求。opaque origin + CSP 共同承担隔离；单独任一层都不视为充分。

## Streaming behavior

流式正文继续走现有节流 Markdown。未闭合 code fence 保持代码显示但不注入预览操作；闭合 fence 后可以显示入口，但不自动打开。终态立即收敛。若 active artifact 所属消息随后被服务端持久化替换，按稳定消息/块位置重新解析并更新引用；第一版可更简单地仅允许持久化消息打开，若现有 overlay 生命周期使映射复杂则采用该安全降级。

## Download and lifecycle

复制使用原始 `artifact.code`。下载使用组装后的 preview document，经 Blob URL 触发后立即 revoke。iframe 切换 artifact 时以 artifact ID 为 key 重建，确保脚本和文档状态不串到另一 artifact。

## Compatibility and performance

- 不新增运行时依赖；复用 marked、DOMPurify 和原生 iframe/Blob API。
- 需要检查 Safari/iOS Safari 对 `srcdoc`、sandbox、CSP meta、`overflow: clip` 和 CSS containment 的行为；不兼容时用 `overflow: hidden` 等保守回退。
- 提取器应为 O(n)；避免在每个 delta 扫描全部历史消息。
- 测量生产 bundle；预期主要增量为应用代码和样式。

## Rollback

移除 artifact 提取/面板、iframe builder 和正文 HTML/style 扩展即可。消息保存格式未改变，回滚后源码仍按原 Markdown/代码文本显示。