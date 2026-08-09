# 公式渲染技术设计

## Architecture and boundaries

公式渲染只扩展现有前端 Markdown 管线：

```text
assistant source text
  -> one configured Marked instance
     -> math tokens become unforgeable per-render placeholders
     -> all ordinary Markdown HTML is sanitized by the existing strict policy
        (style/SVG remain forbidden)
     -> each trust:false KaTeX fragment is sanitized independently by an exact
        KaTeX-only policy (including only required layout style/SVG)
     -> sanitized fragments replace their own placeholders
  -> MarkdownContent (the existing single {@html} boundary)
```

用户消息仍由 `MessageItem` 的文本路径转义，不接入公式解析。服务端、数据库消息格式与 API 无变化，仍保存原始文本。

## Dependency choice

采用 `katex` + `marked-katex-extension`：

- KaTeX 同步渲染，适合现有同步 `renderMarkdown` API，且默认输出视觉 HTML 与可访问 MathML。
- `marked-katex-extension` 使用 Marked 的正式扩展机制，可让代码围栏/行内代码继续优先遵循 Markdown token 边界。
- 默认（`nonStandard: false`）分隔符规则较保守，符合货币歧义要求；块公式要求起止 `$$` 独占行。
- MathJax 覆盖更多 TeX，但本项目需求是常见聊天公式，额外运行时和集成成本不符合轻量 MVP。
- 不使用 KaTeX auto-render：它需要在生成 DOM 后再次扫描，容易重复处理流式快照，也会绕开 Marked token 边界。

建议配置：

```ts
markedKatex({
  output: "htmlAndMathml",
  throwOnError: false,
  strict: "warn",
  trust: false,
  nonStandard: false
})
```

若扩展的 `throwOnError: false` 默认错误输出不能完整满足“带错误样式原文”验收，则在扩展边界增加小型 renderer/tokenizer 适配，而不是放宽 KaTeX 信任配置。

## Sanitization contract

KaTeX 0.17 的实际 HTML 输出对分数、根号和矩阵使用内联布局 `style`；根号和伸缩定界符还可能使用 `<svg><path>`。用户已批准来源隔离方案，避免把这些能力开放给原始 Markdown。

实现采用每次渲染唯一、不可由输入预测或伪造的公式占位符：Marked 的公式 renderer 生成占位符并在内存中保存对应 TeX/显示模式；普通 Markdown 结果先经过现有严格 DOMPurify 策略，仍禁止 `style`、SVG 和远程载体。净化后仅替换确实存活且与本次内存记录匹配的占位符；每个公式由 `trust: false` KaTeX 生成，再经过独立的 KaTeX 专属 DOMPurify 配置后回填。公开 API 仍是同步 `renderMarkdown`，唯一 DOM 插入点仍是 `MarkdownContent`。

KaTeX 专属策略必须从固定测试公式的实际输出枚举最小集合，不允许事件属性、URL 载体、foreignObject、script、任意 HTML 输入或协议能力。允许范围仅限：

- 视觉树：KaTeX 实际使用的 `span`、受限 class 与经过验证的布局 style 声明；
- MathML：`math`、`semantics`、`annotation`、`mrow`、`mi`、`mo`、`mn`、`msup`、`msub`、`mfrac`、`msqrt` 等实际覆盖测试所需节点；
- 伸缩视觉结构：仅 KaTeX 实际生成的 `svg` / `path` 及其必要几何属性；禁止链接、脚本、事件和外部引用；
- 最小属性：现有 `class`、MathML 实际属性、经验证的 KaTeX 布局/几何属性。

实现完成后必须验证：原始 Markdown 中仿造的 KaTeX class、`style`、SVG/path 或占位符无法获得 KaTeX 专属权限；视觉 `.katex` 和 `.katex-mathml` 均保留；恶意 TeX 命令、URL/HTML 载荷和既有 Markdown XSS 矩阵无法产生可执行载体。

## Styling and assets

- 在前端入口静态导入应用内的 KaTeX 样式；样式基于 `katex/dist/katex.min.css`，字体源保留现代浏览器使用的本地 WOFF2 变体，由 Vite 输出为自托管资源，不使用 CDN。
- 行内 `.katex` 继承正文语境并保持基线协调。
- 块公式由专用容器设置上下留白和 `overflow-x: auto; overflow-y: hidden; max-width: 100%`，避免页面级横向滚动。
- 错误 `.katex-error` 使用现有错误/弱化色 token，保留原始 TeX 文本的选择与复制能力。
- 避免覆盖 KaTeX 内部定位规则；项目 CSS 只控制外层布局、颜色和滚动。

## Streaming and failure behavior

现有流式节流快照继续调用相同 `renderMarkdown`。未闭合 `$`/`$$` 不匹配 token 时保持普通文本；闭合后在下一次节流渲染变为公式，终态渲染立即收敛。不得增加每 transport delta 的额外扫描。

KaTeX 错误不得向上传播。单个失败公式降级为带错误样式的原始 TeX，其余 Markdown 和公式照常渲染。

## Compatibility and performance

- 无数据迁移、API 迁移或服务端改动；历史助手消息会在重新展示时自动获得公式渲染。
- 当前生产基线（规划时测量）：JS 约 64.1 KB gzip，CSS 约 6.0 KB gzip，合计约 70.1 KB gzip，明显低于 250 KB 初始资源目标。
- 实现后记录同一 Vite build 的 gzip 数值：250 KB 初始传输门槛按浏览器首屏实际必需的 JS + CSS 计算；由 KaTeX CSS 按实际公式字形/字体请求的自托管字体不计入首屏门槛，但必须同时披露全部字体和全量公式资产体积。若 JS + CSS 超过 250 KB，则停止交付并评审按需加载或目标变更。
- 手工检查当前 Safari/iOS Safari 的 MathML 可访问输出与窄屏滚动。

## Rollback

回滚仅需删除 Marked 公式扩展配置、KaTeX CSS/依赖、公式白名单与样式；原始消息从未迁移，因此会无损恢复为普通 Markdown 文本。
