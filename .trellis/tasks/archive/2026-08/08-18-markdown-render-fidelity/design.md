# 技术设计 — Markdown 公式与 HTML 渲染保真修复

## 设计原则

**双泳道 provenance 隔离不动。** 本次全部改动落在"每条泳道各自的白名单与过滤精度"上，
不改变泳道划分本身：

- 普通 Markdown 泳道：仍然 0 `style`、0 SVG、0 MathML、0 `input`、0 `img`、0 事件属性。
  本次只新增**惰性、无 URL 载体、无脚本面**的结构标签（`sub` `sup` `span` `details` `summary`）。
- KaTeX 泳道：仍然只接收"当前渲染上下文 nonce 匹配过的 `trust:false` KaTeX 输出"。
  本次只把样式过滤从"整条属性连坐"改为"逐条声明"，并按 KaTeX 实际输出补齐白名单。

`quality-guidelines.md` §Security Gate 的"绝不为让公式渲染而放宽普通 Markdown 的
style / SVG / URL 权限"因此严格成立：普通泳道**没有**获得任何 style / SVG / MathML / URL 能力。

## 变更 1：样式过滤从"整条丢弃"改为"逐条重写"

### 1.1 泳道感知

`uponSanitizeAttribute` 钩子注册在 DOMPurify 单例上，两条泳道都会命中。现状靠"严格泳道
的 `ALLOWED_ATTR` 里没有 `style`"被动兜底。改为**显式泳道标记**：

```ts
type SanitizerLane = "strict" | "katex";
let activeLane: SanitizerLane = "strict";

function sanitizeIn(lane: SanitizerLane, html: string, config: object): string {
  activeLane = lane;
  try { return DOMPurify.sanitize(html, config); }
  finally { activeLane = "strict"; }   // 失败也回到最严格的默认
}
```

钩子逻辑：

```ts
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "style") return;
  if (activeLane !== "katex") { data.keepAttr = false; return; }
  const kept = filterKatexStyle(data.attrValue);
  if (kept === "") { data.keepAttr = false; return; }
  data.attrValue = kept;              // DOMPurify 在钩子后读取 attrValue
});
```

`finally` 里复位成 `"strict"` 而非"上一个值"：这是 fail-closed —— 任何异常路径都退回
最严格状态，而不是把 KaTeX 权限泄漏给下一次严格泳道调用。`renderMarkdown` 本身已有
不可重入断言，不存在嵌套。

### 1.2 `filterKatexStyle`

按 `;` 切分 → 逐条 `property: value` 校验 → 合法项以 `prop:value` 重新拼接（用 `;` 连接）。
返回空串表示无一条合法。

### 1.3 值校验：先做"载荷否决"，再做"类别匹配"

**第一道（对所有属性生效）**：声明的原始文本命中以下任一即整条拒绝。

```
( )  \  /*  */  <  >  @  "  '  &  !important（含空白变体）  U+0000-U+001F  非 ASCII
```

这一道单独封死 `url()` `var()` `expression()` `image-set()` `attr()` `element()`
`-moz-binding` `behavior:url(#…)`、CSS 转义序列（`\72 ed`）、HTML 注释注入与 `!important`
提权。**不依赖枚举危险函数名**——任何函数式语法都不可能通过，因为括号被禁。

**第二道**：属性必须在白名单内，且值符合该属性的类别文法。

| 类别 | 属性 | 值文法 |
|---|---|---|
| 长度 | `height` `width` `min-width` `left` `top` `bottom` `vertical-align` `margin` `margin-left` `margin-right` `margin-top` `margin-bottom` `padding-left` `border-width` `border-top-width` `border-right-width` `border-bottom-width` `border-left-width` | 1–4 个空格分隔的长度记号 |
| 线型 | `border-style` `border-top-style` `border-right-style` `border-bottom-style` `border-left-style` | 1–4 个线型关键字 |
| 颜色 | `color` `background-color` `border-color` `border-top-color` `border-right-color` `border-bottom-color` `border-left-color` | 1–4 个颜色记号 |
| 简写 | `border` | 1–3 个记号，每个是 长度 \| 线型 \| 颜色 |
| 阴影 | `text-shadow` | 1–8 个记号，每个是 长度 \| 颜色（`none` 亦可） |
| 枚举 | `position` | 只允许 `relative` |

记号文法：

- 长度：`/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|rem|pt|px|%)?$/`
- 线型：`none hidden solid dashed dotted double groove ridge inset outset`
- 颜色：`/^#[0-9a-f]{3}$|^#[0-9a-f]{4}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/` 或 `/^[a-z]+$/`
  （纯字母关键字，天然覆盖 `transparent` / `currentcolor` / CSS 具名色；无括号、无 URL）

`position` 保持只允许 `relative`：`absolute` / `fixed` 会让公式片段脱离消息容器覆盖到
页面其它区域（点击劫持面），而 KaTeX 的绝对定位一律来自自托管 `katex.css` 的类规则，
不走内联样式，因此不需要放行。

### 1.4 为什么"逐条保留"比"整条丢弃"更安全，而不是更危险

逐条过滤后，每一条存活声明都单独通过了完整校验；整条丢弃的旧行为并没有更强的安全性，
只是**误伤了同一属性里已经合法的声明**（`\boxed` 的 `height` 就是这样丢的）。攻击面由
"允许哪些属性 / 值文法"决定，与"整条还是逐条"无关。

## 变更 2：KaTeX 泳道 MathML 白名单补齐

- `KATEX_ALLOWED_TAGS` 增补：`mpadded` `mphantom`。
  （依据：`grep -oE '"m[a-z]+"' node_modules/katex/dist/katex.mjs` 的完整元素集与现有清单求差）
- `KATEX_ALLOWED_ATTR` 增补：`columnlines` `rowlines` `lspace` `rspace` `minsize`
  `maxsize` `separator` `largeop` `linebreak` `mathsize` `mathcolor` `mathbackground`
  `depth` `voffset` `valign`。
- **明确排除并加注释**：`href`（`\href`）、`src`/`alt`（`mglyph` / `\includegraphics`）、
  `xlink:href`。这三者是 KaTeX 属性集中**仅有的 URL 载体**，且都只在 `trust: true` 下可达；
  白名单永不收录，并由测试锁定。
- `mathcolor` / `mathbackground` 只接受颜色，无函数式语法，DOMPurify 不会对其做 URL 解析，
  与 `style` 的颜色类别同级风险。

不可修复项（写进注释）：`<mo><mover>…</mover></mo>` 形态在 HTML MathML 文本整合点规则下
被 DOMPurify 剔除，只影响隐藏无障碍层，`<annotation>` 中的 TeX 源码不受影响。

## 变更 3：普通泳道新增标签

`STRICT_ALLOWED_TAGS` 增补 `sub` `sup` `span` `details` `summary`；
`STRICT_ALLOWED_ATTR` 增补 `open`。

风险评估：五者均无 URL 属性、无事件语义、不可执行脚本、不能加载远程资源。
`span` + 已有的 `class` 允许助手文本伪造装饰性类名（例如 `class="copy-button"`），
影响**纯视觉**、无权限提升；且 `class` 在本次改动前就已对 `a` / `code` / `p` / `li` 等
开放，不构成新增风险类别。`stripSourceKatexIdentity` 继续负责剥掉源文本里的 `katex*`
类名，公式伪造路径不变。

## 变更 4：任务列表复选框（不引入 `input`）

覆写 marked 渲染器（`marked@18` 的 `renderer.listitem` / `renderer.checkbox` 均可覆写，
返回 `false` 则回落到默认实现）：

```ts
parser.use({
  renderer: {
    listitem(token) {
      if (!token.task) return false;                 // 非任务项走默认
      const state = token.checked ? " task-item-checked" : "";
      return `<li class="task-item${state}">${this.parser.parse(token.tokens)}</li>\n`;
    },
    checkbox({ checked }) {
      return `<span class="task-marker${checked ? " task-marker-checked" : ""}"></span> `;
    }
  }
});
```

`li` 上带类，因此 CSS 不需要 `:has()`（Safari 兼容面更宽）。复选框视觉由
`MarkdownContent.svelte` 的 `:global(.task-marker)` 用现有 token（`--border-strong`
`--accent` `--surface`）绘制方框与对勾，`list-style: none` 由 `.task-item` 承担。
选中态不能只靠颜色区分（对比度 / 色觉），对勾用 `::after` 的几何形状表达。

## 变更 5：图片降级为安全链接（不引入 `img`）

覆写 `renderer.image`：

```ts
image({ href, text, tokens }) {
  const label = tokens?.length ? this.parser.parseInline(tokens, this.parser.textRenderer)
                               : text;
  const shown = escapeHtml(label.trim() === "" ? href : label);
  return `<a href="${escapeHtml(href)}">${shown}</a>`;
}
```

`href` 随后仍受 `STRICT_PURIFY_CONFIG.ALLOWED_URI_REGEXP` 的 scheme 白名单约束
（`javascript:` / 危险 `data:` 会被剥掉 `href`），并由 `afterSanitizeAttributes` 统一
补 `target="_blank"` + `rel="noopener noreferrer nofollow"`。**页面不会因助手消息自动
向第三方发起任何请求**——这正是不放行 `img` 的理由（远程图片 = 无需用户交互的 IP /
访问时间泄露，且可用作已读回执）。

## 变更 6：脚注（不产出 `<a href>`）

两个扩展，与既有 `latexKatex` / `escapedKatex` 扩展并列注册：

- 行内 `footnoteRef`：`start` = `src.indexOf("[^")`；tokenizer 匹配
  `/^\[\^([^\]\s][^\]]{0,63})\]/`；渲染 `<sup class="footnote-ref">[label]</sup>`。
- 块级 `footnoteDef`：tokenizer 匹配行首 `/^\[\^([^\]]{1,64})\]:[ \t]*([^\n]*)/`，
  `tokens: this.lexer.inlineTokens(content)`；渲染
  `<p class="footnote-def"><sup class="footnote-ref">[label]</sup> …parseInline…</p>`。

marked 的块级扩展 tokenizer 在 `Lexer.blockTokens` 中先于内置 `def` 尝试，因此定义行不再
被吞成链接引用定义。两个 tokenizer 都只匹配 `[^` 前缀，**普通链接引用定义 `[ref]: url`
与引用式链接 `[文字][ref]` 行为完全不变**（需回归测试锁定）。

label 经 `escapeHtml` 后输出；不生成任何 `href`，因此不存在 URL 面。

## 影响面与回归风险

| 风险 | 缓解 |
|---|---|
| 样式过滤重写导致既有公式回归 | 既有 58 个测试 + AC-1 新增保真断言；改动前后跑同一份 jsdom 探针语料对比 |
| 新扩展抢走普通 Markdown 语法 | AC-3 明确锁定 `[ref]: url` / `[文字][ref]` / 普通 `[x]` 文本不受影响 |
| 泳道标记泄漏 | `finally` 复位为 `"strict"`；新增测试：KaTeX 渲染抛错后紧接一次严格泳道渲染，`<span style>` 仍被剥离 |
| 新标签被用于视觉伪装 | 仅惰性标签；`class` 风险面在改动前已存在；文档化于 spec |

## 待更新的 spec（Phase 3.3）

`.trellis/spec/frontend/index.md` 的 Markdown 不变量段落，与
`quality-guidelines.md` §Security Gate 的测试清单，需要补上：逐条声明过滤、
KaTeX 泳道颜色/边框放行的边界、URL 载体永久排除清单、以及"任务列表/图片/脚注
不引入 `input` / `img` / `href`"这三条降级约定。
