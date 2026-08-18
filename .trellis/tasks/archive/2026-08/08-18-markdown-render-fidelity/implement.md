# 执行计划 — Markdown 公式与 HTML 渲染保真修复

按顺序执行。每一步做完立刻跑该步的验证命令，绿了再进下一步；不要攒到最后一起跑。

## 前置：建立回归基线

- [ ] 记录当前基线：`npm --prefix frontend run test -- src/lib/markdown`
      （应为 2 files / 58 tests 全绿）。任何一步之后这 58 条都不允许变红。

## 步骤 1 — 样式过滤：逐条重写（对应 R1 / R2 / R3）

改 `frontend/src/lib/markdown/render.ts`：

- [ ] 引入泳道标记 `activeLane: "strict" | "katex"` 与 `sanitizeIn(lane, html, config)`
      包装函数，`finally` 复位为 `"strict"`（fail-closed，见 design.md §1.1）。
- [ ] `renderMarkdown` 的严格净化改走 `sanitizeIn("strict", …)`；
      `renderKatex` 的净化改走 `sanitizeIn("katex", …)`。
- [ ] 用 `filterKatexStyle(style): string` 取代 `isAllowedKatexStyle(style): boolean`。
      逐条校验、合法项以 `;` 重新拼接、全非法返回 `""`。
- [ ] `uponSanitizeAttribute` 钩子：非 `style` 直接 return；`activeLane !== "katex"` 时
      `keepAttr = false`；否则写回 `data.attrValue = kept`，`kept === ""` 时 `keepAttr = false`。
- [ ] 实现"载荷否决"正则（design.md §1.3 第一道）：`( ) \ /* */ < > @ " ' &`、
      `!important`、控制字符、非 ASCII 一律拒绝。**这是核心安全断言，务必先写测试再写实现。**
- [ ] 实现四类记号文法与属性分类表（design.md §1.3 表格），替换旧的
      `KATEX_STYLE_PROPERTIES` / `KATEX_NUMERIC_STYLE_VALUE`。
- [ ] 保留 `position` 仅 `relative`（不要顺手放开 `absolute`，理由见 design.md §1.3 末段）。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 2 — KaTeX 泳道 MathML 白名单（对应 R4）

- [ ] `KATEX_ALLOWED_TAGS` 增补 `mpadded` `mphantom`。
- [ ] `KATEX_ALLOWED_ATTR` 增补：`columnlines` `rowlines` `lspace` `rspace` `minsize`
      `maxsize` `separator` `largeop` `linebreak` `mathsize` `mathcolor` `mathbackground`
      `depth` `voffset` `valign`。
- [ ] 在两个清单旁写明：`href` / `src` / `alt` / `xlink:href` 是 KaTeX 属性集中仅有的
      URL 载体，永不收录；并注明 `<mo><mover>` 被 DOMPurify 按 MathML 文本整合点规则
      剔除属规范行为，只影响隐藏无障碍层。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 3 — 普通泳道新增惰性标签（对应 R6 / R9）

- [ ] `STRICT_ALLOWED_TAGS` 增补 `sub` `sup` `span` `details` `summary`。
- [ ] `STRICT_ALLOWED_ATTR` 增补 `open`。
- [ ] 不要动 `ALLOWED_URI` / `ALLOW_DATA_ATTR` / `ALLOW_ARIA_ATTR`。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 4 — 任务列表复选框（对应 R5）

- [ ] `parser.use({ renderer: { listitem, checkbox } })`，实现见 design.md §变更 4。
      `listitem` 对非任务项返回 `false` 回落默认实现。
- [ ] `MarkdownContent.svelte` 增 `.task-item` / `.task-marker` 样式：
      `list-style: none`、方框用 `--border-strong`、选中态用 `--accent` + `::after` 对勾
      （几何形状而非仅颜色区分），尺寸随 `em` 走。
- [ ] 确认结果中不出现 `<input>`。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 5 — 图片降级为安全链接（对应 R7）

- [ ] 覆写 `renderer.image`，实现见 design.md §变更 5；alt 为空时回落显示 URL 文本。
- [ ] 确认 `javascript:` / 危险 `data:` 图片 URL 走完管线后不产生可点击的危险链接。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 6 — 脚注（对应 R8）

- [ ] 注册 `footnoteRef`（inline）与 `footnoteDef`（block）扩展，实现见 design.md §变更 6。
- [ ] 回归确认：`[ref]: https://example.com` + `[文字][ref]` 仍产出正常链接；
      纯文本 `[x]` 不被误吞。
- [ ] `MarkdownContent.svelte` 增 `.footnote-ref` / `.footnote-def` 样式（次要文本层级）。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 7 — 测试补全（对应 AC-1 / AC-2 / AC-3）

在 `frontend/src/lib/markdown/render.test.ts` 中补：

- [ ] **AC-1 保真**：`\phantom` 的 `color:transparent`、`\boxed` 的 `height`+`border-*`、
      `array` 竖线的 `border-right-*`+`height`、`\textcolor` 的 `color:red`、
      `\colorbox` 的 `background-color:yellow`、`\rule` 的三条声明。
- [ ] **AC-2 安全**（逐个新放行属性都要有攻击用例）：
      `background:url(...)`、`expression(...)`、`var(--x)`、`image-set(...)`、
      CSS 转义 `\72 ed`、`!important`、`behavior:url(#x)`、
      混合声明中"合法项保留 + 非法项剔除"的断言、
      原始 Markdown 手写 `<span style>` / `<math>` / `<svg>` / `<input>` / `<img>` /
      `<mo href="javascript:…">` 全部不出现、
      泳道泄漏用例（KaTeX 抛错后紧接严格渲染，`<span style>` 仍被剥）。
- [ ] **AC-3 Markdown 保真**：任务列表两态且无 `<input>`；`sub`/`sup` 保留；
      图片降级为链接且无 `<img>`；脚注三段文字可见且无 `href="note"`；
      链接引用定义回归；`details`/`summary` 保留。

验证：`npm --prefix frontend run test -- src/lib/markdown`

## 步骤 8 — 全量门禁（对应 AC-4）

- [ ] `npm --prefix frontend run test`
- [ ] `npm --prefix frontend run check`
- [ ] `npm --prefix frontend run lint`
- [ ] `npm --prefix frontend run build`

## 回滚点

每个步骤是独立可回滚单元。步骤 1 是唯一有回归风险的改动（触碰既有公式渲染）；
若步骤 1 后 58 条基线测试出现红色，先回退步骤 1 再逐条定位，不要在其上继续叠加步骤 2+。

## 禁止事项

- 不得为了让某个构造渲染而向 `STRICT_PURIFY_CONFIG` 添加 `style` / SVG / MathML / `img` / `input`。
- 不得放宽 `ALLOWED_URI`。
- 不得在值文法里放行任何带括号的 CSS 函数。
- 不得改动占位符 nonce 机制、`{@html}` 边界、流式节流与复制按钮逻辑。
- 不得升级 katex / marked / dompurify 版本。
- 不得 `git commit`（由主会话在 Phase 3.4 统一提交）。
