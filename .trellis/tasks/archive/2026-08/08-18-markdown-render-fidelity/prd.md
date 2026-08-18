# Markdown 公式与 HTML 渲染保真修复

## Goal

在**不放宽 XSS / URL / 远程加载安全边界**的前提下，修复 `frontend/src/lib/markdown/render.ts`
渲染管线中一批"内容被静默丢弃或渲染错误"的保真问题。

用户价值：助手消息是产品的主要输出载体。当前管线对常规公式（`\frac` `\sqrt` `\sum`
矩阵 `aligned` 等）无损，但对另一批同样常见的构造会**静默产出错误画面**——`\phantom`
该隐藏的内容反而显示出来、`\boxed` 的方框塌成一条线、`array` 的竖线消失、颜色失效；
Markdown 侧任务列表复选框、`<sub>/<sup>`、图片、脚注被整体剥离。这些都不报错，用户只
看到"模型输出错了"，实际是渲染层丢的。

## Background / Confirmed Facts

以下事实均由本任务前置排查**实测确认**（jsdom 探针对比 KaTeX 原始输出 vs `renderMarkdown`
结果，并在 `vite dev` 中做了视觉确认），不是推断。

### 现有管线结构（`frontend/src/lib/markdown/render.ts`，687 行）

双泳道 provenance 隔离设计，必须保留：

1. `marked-katex-extension` 识别公式语法，但 renderer 只吐**每次渲染独立的随机 nonce
   占位符** `<code title="math-{nonce}-{i}">…</code>`（[render.ts:197](frontend/src/lib/markdown/render.ts:197)）。
2. Marked 产出的普通 HTML 走 `STRICT_PURIFY_CONFIG`（[render.ts:58](frontend/src/lib/markdown/render.ts:58)）——
   无 `style`、无 MathML、无 SVG。
3. 只有**当前渲染上下文里登记过**的公式才由 KaTeX（`trust: false`）渲染，再走
   `KATEX_PURIFY_CONFIG`（[render.ts:135](frontend/src/lib/markdown/render.ts:135)），并且只在自己那个存活的占位符处插入。
4. `MarkdownContent.svelte` 是全应用唯一的 `{@html}` 边界。

### 缺陷 1：KaTeX 内联样式"整条属性连坐丢弃"

[render.ts:161](frontend/src/lib/markdown/render.ts:161) `isAllowedKatexStyle` 用
`declarations.every(...)`：**只要有一条声明不在白名单，整个 `style` 属性被 DOMPurify 丢掉**
（[render.ts:586](frontend/src/lib/markdown/render.ts:586) 的 `uponSanitizeAttribute` 钩子设 `keepAttr = false`），
连同同一属性里合法的 `height` / `vertical-align` 一起消失。

当前属性白名单 [render.ts:142](frontend/src/lib/markdown/render.ts:142) 只有 11 项，值正则
[render.ts:159](frontend/src/lib/markdown/render.ts:159) 只接受无单位 / `em` / `%`。

**KaTeX 0.17 实际会输出的全部内联样式属性**（`grep -o 'style\.[a-zA-Z]*' node_modules/katex/dist/katex.mjs`）：

```
backgroundColor borderBottomWidth borderColor borderRightStyle borderRightWidth
borderStyle borderTopWidth borderWidth bottom color height left margin
marginLeft marginRight marginTop minWidth paddingLeft position textShadow top
verticalAlign width
```

即当前白名单缺 `background-color` `border` `border-color` `border-right-style`
`border-right-width` `border-style` `border-top-width` `border-width` `bottom`
`color` `margin` `margin-top` `text-shadow`。

实测被破坏的构造（视觉已确认）：

| 构造 | 现象 | 丢弃的声明 |
|---|---|---|
| `\phantom` / `\hphantom` / `\vphantom` | **本该隐藏的内容显示出来**：`a\phantom{XYZ}c` → `aXYZc` | `color:transparent` |
| `\boxed` / `\fbox` | 方框塌成一条下划线（`height` 被连坐） | `border-style` `border-width` `height` |
| `\begin{array}{c\|c}` | 竖线分隔符消失、列间距错位 | `border-right-*` `margin` `vertical-align` `height` |
| `\rule` | 完全不渲染 | `border-right-width` `border-top-width` `bottom` |
| `\textcolor` / `\color` | 颜色失效，显示正文黑 | `color` |
| `\colorbox` / `\fcolorbox` | 底色 / 边框失效 | `background-color` `border` `height` |

### 缺陷 2：KaTeX 泳道 MathML 元素 / 属性缺失

**KaTeX 实际输出的 MathML 元素**：`math semantics annotation mrow mi mo mn mtext
mspace mstyle msup msub msubsup mfrac msqrt mroot mover munder munderover mtable
mtr mtd menclose mpadded mphantom`，另加 SVG 的 `svg path line`。

当前 [render.ts:67](frontend/src/lib/markdown/render.ts:67) 缺 **`mpadded`、`mphantom`**。

**KaTeX 实际 setAttribute 的属性**：`accent accentunder alt aria-hidden columnalign
columnlines columnspacing d depth display displaystyle encoding fence height href
largeop linebreak linethickness lspace mathbackground mathcolor mathsize mathvariant
maxsize minsize notation rowlines rowspacing rspace scriptlevel separator src
stretchy style title valign voffset width xmlns`。

当前 [render.ts:98](frontend/src/lib/markdown/render.ts:98) 缺 `columnlines` `depth`
`largeop` `linebreak` `lspace` `mathbackground` `mathcolor` `mathsize` `maxsize`
`minsize` `rowlines` `rspace` `separator` `valign` `voffset`。

其中 **`href` 与 `src` 必须继续排除**（唯二的 URL 载体；`href` 来自 `\href`、`src` 来自
`mglyph`/`\includegraphics`，二者在 `trust: false` 下本就不可达，白名单里也绝不放行）。

另有一项**不可修复**且需记录：KaTeX 对 `\stackrel` / `\overset` / `\underset` 输出
`<mo><mover>…</mover></mo>`，而 HTML 规范规定 `mo/mi/mn/ms/mtext` 是 MathML 文本整合点，
DOMPurify 按规范剔除其中的 MathML 子元素。这只影响隐藏的 `.katex-mathml` 无障碍层，
**不影响视觉**，且 `<annotation>` 里的 TeX 源码仍完整保留。

### 缺陷 3：普通 Markdown 泳道的元素剥离

`STRICT_ALLOWED_TAGS`（[render.ts:23](frontend/src/lib/markdown/render.ts:23)）实测后果：

- `- [ ] 待办` → `<li> 待办</li>`，**复选框全部消失**（`input` 不在白名单），并残留前导空格。
- `H<sub>2</sub>O` → `H2O`，`x<sup>2</sup>` → `x2`，**化学式 / 单位语义失真**。
- `![alt](url)` → `<p></p>`，**图片连 alt 文本都不保留**，用户看到空白。
- `正文[^1]` + `[^1]: 注释` → `<a href="note">^1</a>`：marked 无脚注扩展，把定义行当成
  链接引用定义，**产出一个指向不存在相对路径的误导性链接**，注释正文丢失。
- `<details><summary>展开</summary>内容</details>` → `展开内容`（DOMPurify 默认
  `KEEP_CONTENT` 脱壳），语义错乱。

### 不变量（`.trellis/spec/frontend/index.md`、`quality-guidelines.md` §Security Gate）

- Markdown 在插入 DOM 前必须净化；`{@html}` 只允许出现在 `MarkdownContent.svelte`。
- **"绝不为了让公式渲染而放宽普通 Markdown 的 style / SVG / URL 权限。"** 本任务严格遵守：
  样式放宽**只发生在 KaTeX 泳道**，普通泳道继续 0 `style`、0 SVG、0 MathML。
- 安全矩阵测试已覆盖：script / 事件属性 / `javascript:` / 危险 `data:` / iframe /
  不安全 SVG / 畸形 HTML / 伪造占位符或 KaTeX 类名 / `trust:false` 下的 TeX URL 命令。

## Scope

### In Scope

- `frontend/src/lib/markdown/render.ts` 的三处白名单与样式过滤策略。
- `frontend/src/lib/markdown/MarkdownContent.svelte` 新增元素所需的样式。
- `frontend/src/lib/markdown/render.test.ts` 安全矩阵扩充 + 新增保真断言。
- 完成后按 3.3 更新 `.trellis/spec/frontend/` 相关不变量描述。

### Out of Scope

- 不引入语法高亮、不换 Markdown 解析器、不升级 KaTeX 版本。
- 不允许远程图片自动加载（隐私：会向任意主机泄露用户 IP / 时间）。
- 不追求 MathML 层 100% 保真（文本整合点限制属规范行为，见上）。
- 不改动流式渲染节流、复制按钮等既有行为。

## Requirements

### R1 — 逐条声明过滤，取代整条丢弃

`style` 属性按**单条声明**过滤：合法声明保留、非法声明剔除、剩余声明重新序列化写回；
只有全部声明都非法时才丢弃整个属性。

### R2 — KaTeX 样式白名单覆盖 KaTeX 实际输出

属性覆盖上文实测清单；值校验按属性类别分开：长度类、边框线型类、颜色类、`position`。

### R3 — 值校验必须封死函数式与转义载荷

无论属性类别，值中出现 `(` `)` `\` `/*` `*/` `<` `>` `;`（分隔后不应再有）、`@`、
`!important` 一律拒绝。这封死 `url()` `var()` `expression()` `image-set()` `attr()`
`element()` 以及 CSS 转义序列。颜色只接受 `#` + 3/4/6/8 位十六进制、纯字母关键字
（含 `transparent` / `currentcolor`）。

### R4 — MathML 白名单补齐，URL 载体永久排除

补 `mpadded` `mphantom` 与上文缺失属性；`href` / `src` / `xlink:href` 明确排除并加注释与测试。

### R5 — 任务列表复选框可见，且不引入 `input`

`- [ ]` / `- [x]` 渲染出可见、可辨别选中态的复选框，**不把 `input` 加入白名单**
（`input` 带 `formaction` / `type=image` 的 `src` 等 URL 载体）。

### R6 — `<sub>` / `<sup>` 保留

二者无属性、无 URL 载体、无脚本面，加入严格白名单。

### R7 — 图片降级为可见信息，且不发起远程请求

`![alt](url)` 不得渲染成空白。降级为走既有 URL scheme 白名单 + `rel="noopener
noreferrer nofollow"` + `target="_blank"` 的链接，文本取 alt（alt 为空时取 URL）。
**不加入 `img` 标签**，页面不得因助手消息自动向第三方发起请求。

### R8 — 脚注不再产出误导性链接

`[^label]` 与 `[^label]: 正文` 成对识别：引用渲染为可见角标，定义渲染为可见的注释行，
正文不丢失，且**不产生任何 `<a href>`**。普通链接引用定义（`[ref]: url`）行为不变。

### R9 — `<details>` / `<summary>` 保留结构

允许这两个惰性标签与 `open` 属性，避免脱壳后文字粘连。

### R10 — 安全边界零回归

普通 Markdown 泳道仍然：0 `style`、0 SVG、0 MathML、0 `input`、0 `img`、0 事件属性；
URL scheme 白名单不变；`{@html}` 边界不变；占位符 provenance 机制不变。

## Acceptance Criteria

### AC-1 保真（新增测试）

- `$a\phantom{XYZ}c$` 渲染结果中，承载 `XYZ` 的元素带 `color:transparent`。
- `$$\boxed{x=1}$$` 的 `.fbox` 元素同时保留 `height`、`border-style`、`border-width`。
- `$$\begin{array}{c|c}…$$` 的 `.vertical-separator` 保留 `border-right-*` 与 `height`。
- `$\textcolor{red}{x}$` 保留 `color:red`；`$\colorbox{yellow}{y}$` 保留 `background-color:yellow`。
- `$a\rule{2em}{1pt}b$` 的 `.rule` 保留 `border-right-width` / `border-top-width` / `bottom`。
- 既有 58 个 markdown 测试全绿（`\frac` `\sqrt` `\sum` 矩阵 `aligned` `\overline`
  `\cancel` `\left(\right)` 等零回归）。

### AC-2 安全（扩充安全矩阵）

对**每一个**新放行的样式属性，构造攻击载荷并断言被拒：

- `color:red;background:url(https://evil/x)` → `background` 被剔除、`color` 保留。
- `width:expression(alert(1))`、`width:var(--x)`、`background-color:image-set("x")`
  → 该声明被剔除。
- `color:\72 ed`（CSS 转义）、`color:red!important`、`border:1px solid red;behavior:url(#x)` → 拒绝。
- 原始 Markdown 里手写 `<span style="color:red">` / `<math>` / `<svg>` / `<input>` /
  `<img>` / `<mo href="javascript:…">` → 全部不出现在结果中。
- 伪造占位符 `` `math-xxx-0` ``、伪造 `class="katex"` → 不触发公式插入（既有断言不变）。
- 脚注与图片降级路径不产生 `javascript:` / `data:` 链接。

### AC-3 Markdown 保真（新增测试）

- `- [ ] a\n- [x] b` 产出两个复选框标记，选中态可区分，结果中**无 `<input>`**。
- `H<sub>2</sub>O`、`x<sup>2</sup>` 保留 `sub` / `sup`。
- `![图](https://example.com/a.png)` 产出文本为「图」的安全链接，结果中**无 `<img>`**。
- `正文[^1]\n\n[^1]: 注释` 中「正文」「1」「注释」全部可见，结果中**无 `<a href="note">`**。
- `[ref]: https://example.com` + `[文字][ref]` 仍产出正常链接（回归保护）。
- `<details><summary>展开</summary>内容</details>` 保留 `details` / `summary` 结构。

### AC-4 门禁

`npm run test`、`npm run lint`、`npm run check`、`npm run build` 全绿。
