# 公式渲染实施计划

## Ordered checklist

1. 在 `frontend` 添加锁定版本的 `katex` 与 `marked-katex-extension`，检查其类型声明与依赖树；静态导入 KaTeX CSS/字体。
2. 先扩展 `frontend/src/lib/markdown/render.test.ts`：
   - 标准行内 `$...$` 与独占行 `$$...$$`；
   - 代码围栏、行内代码、`价格是 $5`、未闭合分隔符；
   - 常用结构（上下标、分数、根号、求和/积分、矩阵）；
   - 无效命令降级为可复制 TeX 原文；
   - MathML 可访问树；
   - TeX/HTML/URL 恶意载荷与既有 XSS 矩阵；
   - 原始 Markdown 仿造 KaTeX class、style、SVG/path 和公式占位符时仍被严格剥离，无法进入 KaTeX 专属净化权限。
3. 在 `frontend/src/lib/markdown/render.ts` 注册公式扩展，以 `trust: false`、`nonStandard: false`、HTML + MathML 和非抛错行为渲染；公式 renderer 输出每次渲染唯一且不可由消息伪造的占位符并记录片段，保持同步单入口。
4. 保持原始 Markdown 的现有严格 DOMPurify 策略（继续禁止 `style`/SVG）；根据固定 KaTeX 输出样本建立独立最小净化策略，仅允许 KaTeX 必需的受限布局 style、MathML 和 SVG/path 几何结构。严格净化普通 Markdown 后，再以专属净化后的 KaTeX 片段替换本次存活占位符。KaTeX 片段中的 class 不采用手写语料白名单：片段只能来自当前渲染中与不可伪造占位符匹配的 `trust: false` KaTeX 输出，保留生成 class 才能避免合法命令和版本升级发生无声样式退化；原始 Markdown 中外层 `katex` / `katex-*` 身份仍会被剥离。
5. 在 `frontend/src/lib/markdown/MarkdownContent.svelte` 添加行内、块级、错误状态和窄屏局部滚动样式；不新增 `{@html}`。
6. 扩展流式组件测试：未闭合公式保持可读、闭合后在节流快照中显示、终态立即收敛、流式过程不新增交互控件或逐 token 播报。
7. 增加/调整组件布局测试，验证长块公式不引起消息页横向溢出；手工检查桌面与移动尺寸。
8. 运行质量门，并比较规划基线与实现后的 Vite gzip 输出。250 KB 门槛按浏览器首屏实际必需 JS + CSS 计算；另行记录全部按需自托管字体和全量公式资产。若 JS + CSS 超过 250 KB，停止并重新评审加载策略，不直接放宽目标。
9. 检查 lockfile、生产静态资源和容器构建，确认无 CDN 或运行时 Node 依赖；更新相关 Markdown 前端规范以记录公式边界和安全合同。

## Validation commands

```bash
npm --prefix frontend run check
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
make check-frontend
```

资源检查：

```bash
find frontend/dist/assets -maxdepth 1 -type f -print0 \
  | xargs -0 -n1 sh -c 'printf "%8d  %s\n" "$(gzip -c "$0" | wc -c)" "$0"' \
  | sort -nr
```

手工浏览器检查：

- 当前 Safari 与 iOS Safari：行内基线、MathML/辅助技术语义、长公式局部滚动；
- Chromium 移动与桌面视口：页面无横向滚动，流式未闭合/闭合公式稳定；
- 100 KB 混合 Markdown/公式消息仍可滚动和选择文本。

## Implementation and validation results

### Resource measurements

#### Pre-fix approved snapshot

The earlier approved comparison snapshot was measured before the final focused fixes in this pass. It is retained as historical evidence, not labeled as the final build:

- Planning baseline initial transfer: approximately **70.1 KB gzip**.
- Pre-fix initial JavaScript: **141,679 B gzip**.
- Pre-fix initial CSS: **13,705 B gzip**.
- Pre-fix initial JavaScript + CSS: **155,384 B gzip**, an increase of **85,284 B** from baseline and **94,616 B under** the 250 KB target.
- Pre-fix emitted asset-file gzip sum: **412,699 B**.

#### Current post-fix build

- Post-fix initial JavaScript: **141,439 B gzip**.
- Post-fix initial CSS: **13,705 B gzip**.
- Post-fix initial JavaScript + CSS: **155,144 B gzip**, **94,856 B under** the 250 KB target.
- Vite emitted **19 external self-hosted fonts totaling 257,315 B gzip**.
- Post-fix emitted asset-file gzip sum: **412,459 B**.
- The repository also contains the **3,624 B raw / 3,673 B gzip** KaTeX Size3 WOFF2 source, which Vite inlines into the emitted CSS instead of emitting as a separate asset. Using the same documented `gzip -c` measurement, a conservative all-font-source formula payload is **260,988 B gzip** (257,315 + 3,673), and a conservative all formula-capable app payload is **416,132 B gzip** (412,459 + 3,673). The latter intentionally double-counts Size3 because its inlined bytes are already represented in emitted CSS; it is disclosure, not a browser-transfer figure.
- The byte totals above use the approved post-fix review measurement. A repeat build during this final pass preserved the same asset shape and CSS/font totals; gzip container metadata can vary the direct `gzip -c` JS and aggregate readings by a few bytes, so those repeat readings are validation rather than a replacement measurement.

### Validation status and remaining manual gate

- Focused formula renderer/component regressions and the project frontend quality commands were run after the final fix pass; exact command results are recorded in the completion report.
- Docker validation was attempted but blocked because the local Docker daemon was unavailable. This is an environment limitation rather than an observed container-build failure.
- Manual real-browser validation remains required for current Safari/iOS Safari and Chromium desktop/mobile: confirm inline baseline, MathML/assistive semantics, formula-local horizontal scrolling with no page overflow, and the 100 KB mixed Markdown/formula interaction case. The jsdom component regression asserts the computed `overflow-x`, `overflow-y`, `max-width`, and inner formula `min-width` rules, but jsdom cannot validate real layout dimensions or scrolling behavior.

## Risky files and rollback points

- `frontend/src/lib/markdown/render.ts`：安全边界；普通 Markdown 与 KaTeX 片段必须保持来源隔离，任何 KaTeX 专属白名单项都必须由测试中的实际输出证明，且不得被输入伪造。
- `frontend/src/lib/markdown/MarkdownContent.svelte`：唯一 HTML 插入点；禁止创建第二入口。
- `frontend/package-lock.json` 与构建资源：KaTeX 字体和 JS 可能增加初始载荷。
- 每完成“解析器注册”“净化白名单”“样式/资源”三个步骤之一都应保持测试可单独运行；需要回滚时按相反顺序删除，不涉及数据迁移。

## Pre-start review gate

- PRD 中无阻塞问题；语法范围和错误降级已由用户决定。
- 用户需在看到最新规划摘要后的下一条消息中明确批准，才能运行 `task.py start` 并实施。
