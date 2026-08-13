# HTML 渲染实施计划

## Ordered checklist

1. **先写安全与提取测试**
   - 正文新增标签的正向用例与 script/iframe/form/img/SVG/event 属性拒绝矩阵；
   - DEEIX style 属性集合正向覆盖，以及 URL、表达式、未知变量、超长值和结构字符拒绝；
   - fixed/absolute、z-index、transform、100vw、负偏移、极端尺寸的容器隔离回归；
   - fenced block 扫描、语言别名、HTML-like fallback、整条消息 fallback、多个 block、未闭合 fence 和普通代码误识别；
   - HTML/CSS/JS preview document 的 CSP 顺序、转义和错误 runtime。

2. **实现 artifact 领域模块**
   - 新增 artifact 类型、语言解析、HTML-like 判断和 O(n) fenced scanner；
   - 新增三个 preview document builder、主题变量快照、下载 helper；
   - 保持模块为纯 TypeScript，便于单测和复用。

3. **扩展 Markdown 的受限正文 HTML**
   - 增加批准的静态标签与 `open/style` 属性；
   - 添加与 KaTeX 来源隔离的 DEEIX 同等 style sanitizer；
   - 给 Markdown root 增加 containment/overflow 防护；
   - 运行现有 XSS 与 KaTeX provenance 测试，确认普通 HTML 无法获得 KaTeX 专属 SVG/MathML 权限。

4. **给代码块增加预览操作**
   - 扩展 `MarkdownContent` props，接收 message identity、终态/流式状态和 `onOpenArtifact`；
   - 在现有净化后 DOM enhancement 阶段，把 artifact 与 fenced `pre` 对齐并注入真实 DOM 按钮；
   - 复用现有 copy control 视觉/无障碍约定；流式 transient 状态不注入预览按钮。

5. **接入持久化与流式消息层**
   - `MessageItem` 把 assistant message identity 和 open callback 向下传递；
   - `StreamingTurn` 仅在安全终态满足映射时暴露入口，否则由持久化消息接管；
   - 切换对话或删除消息时清理 active artifact。

6. **实现 ArtifactWorkspace**
   - 预览/源码 tabs、artifact selector、复制、下载、关闭；
   - iframe `sandbox="allow-scripts"`、`no-referrer`、严格 `allow` Permissions Policy；
   - artifact 变化时重建 iframe；错误只在 frame 内出现；
   - 桌面右侧分栏、1/3～1/2 pointer/keyboard resize 和双击复位；
   - 移动端覆盖聊天工作区、焦点进入与恢复、无页面横向滚动。

7. **集成验证与资源测量**
   - 完成组件交互、安全策略、历史消息、流式、对话切换和响应式测试；
   - 浏览器手工检查 Chromium、Safari/iOS Safari 的 sandbox/CSP、焦点、滚动与下载；
   - 运行全量质量门并记录构建体积。

## Validation commands

```text
npm --prefix frontend run check
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
make check-frontend
```

实施中先运行目标测试文件，再执行完整门禁。生产构建后记录压缩 JS/CSS 及相对当前基线的增量。

## Risky files / rollback points

- `frontend/src/lib/markdown/render.ts`：最高安全风险。普通 HTML style 与 KaTeX style hook 必须保持来源隔离；每次修改后先跑 Markdown 安全矩阵。
- `frontend/src/lib/markdown/MarkdownContent.svelte`：唯一 `{@html}` 边界与代码块 DOM enhancement；禁止新增第二个 raw HTML 插入点。
- `frontend/src/lib/conversations/ChatPane.svelte`：主布局、滚动和对话切换状态；分栏改造应保持 composer、回到底部与移动键盘行为。
- `frontend/src/lib/generation/StreamingTurn.svelte`：不得让未闭合/瞬时源码执行，不得引入每 delta 重扫历史。
- 新的 preview builder：用户 head/body 组合、`</script>` 转义和首个 CSP 顺序是关键回滚点。

## Follow-up checks before task start

- 运行 `trellis-before-dev`，读取 frontend package 的最新规范。
- 若采用子代理实施，给 `implement.jsonl` 和 `check.jsonl` 写入真实 spec/research context；若主会话 inline 实施则按 Trellis 规则可跳过 JSONL gate。
- 实施前记录当前 `frontend` build gzip 基线，便于准确比较。
- 再次确认 PRD 无 open questions，用户已在最终规划摘要之后明确批准实施。