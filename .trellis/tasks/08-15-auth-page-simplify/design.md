# 设计：简洁优雅的鉴权页面

事后补录（实现已完成）。记录实际采用的技术决策与理由，供后续维护参考。

## 分层

```
App.svelte (.auth-main)          纯色底 + 全视口高度，不再是 canvas 基底
  AuthScene.svelte (.scene)      背景氛围 + 居中 + 主题切换器
    .ambience                    两道 CSS 径向渐变 (z 0)
    ThemeSwitch                  三段式 radio 胶囊 (z 2)
    {children}                   AuthPage 或 unavailable 卡片 (z 1)
```

居中与内边距上移到 `AuthScene`，三种状态各自只渲染一张卡片。好处：卡片位置在 `checking → form` 切换时不跳动，`unavailable` 也自动落进同一框架。

## Token 收敛

10 个 `--auth-*` 减到 2 个：

| 移除 | 替代 |
|------|------|
| `--auth-stage-bg` | `--bg` |
| `--auth-glass` / `--auth-glass-border` | `--surface` / `--border` |
| `--auth-ink` / `--auth-ink-muted` | `--text` / `--text-strong` / `--muted` |
| `--auth-field-bg` | `color-mix(in srgb, var(--text) 3%, transparent)` |
| `--auth-canvas-*` / `--auth-mega-*` | 随 canvas 与巨型标题一同删除 |
| 保留 | `--auth-glow-1` / `--auth-glow-2`（两套调色板各一组） |

关键决策：**用 `color-mix()` 叠通用 token 代替新增 token**。`color-mix(in srgb, var(--text) N%, transparent)` 在浅色下是浅灰、深色下是提亮的白色叠层，同一条声明在两套主题都成立，不需要成对维护。

氛围只剩两道径向渐变：顶部冷调 + 底部暖调，纵向对称。早期版本用的是"左上冷 + 右下暖"的斜向布局，视觉上读作一块脏污而非有意为之，改为对称后才像"上方来光"。

## 错误表达

状态机用两个本地标志，而不是一个：

```
submitRejected   本次提交被服务端拒绝     → 决定输入框是否染红
errorDismissed   用户已通过编辑令牌确认   → 决定文案是否显示
showError    = Boolean(errorMessage) && !errorDismissed
fieldInvalid = showError && submitRejected
```

拆成两个的原因：`expire()` 会在没有任何提交的情况下写入 `errorMessage`（"登录已过期，请重新登录。"）。若只按 `errorMessage` 是否存在来染红，用户一进页面就会看到一个红色的空输入框 —— 惩罚性且没有指向性。拆开后，这类消息只显示文案。

编辑令牌时两个标志一起复位，保证控件颜色与说明文字永远一致，不会出现"红框配中性文案"或反之。

## 动画重启

摇动用 CSS class 驱动，但重新触发不能靠简单的 off/on：同一批次内的两次赋值会被合并成"无变化"，动画不会重播。

第一版用 `requestAnimationFrame` 延后置位，**在浏览器里实测失败**：`document.hidden === true` 时 rAF 回调根本不执行，`shaking` 类始终没落到 DOM 上。

最终方案：

```js
shaking = false;
await tick();                    // 冲刷 class 移除
void fieldElement?.offsetWidth;  // 强制一次样式重算，让浏览器"看见"移除
shaking = true;
```

`animationend` 负责清除类。隐藏标签页不会触发 `animationend`，残留的类由下次输入时一并清掉（隐藏期间无动画，残留不产生视觉影响）。

## 主题切换器

`<label>` 包原生 `<input type="radio">`，外层 `role="radiogroup"` + `aria-label`。分组、选中态、方向键漫游全部由平台提供，组件不持有开合状态。滑块指示器按选中项索引做 `translateX(calc(var(--active) * 44px))`，段宽固定 44px，因此无需测量 DOM。

焦点环用 `:has(input:focus-visible)` 而非 `:focus-within` —— 后者会在鼠标点击后残留一个环。

## 主操作按钮

"继续"与"重试"都复用共享的 `PrimaryButton`，不自绘按钮。

中途曾把两者改成 `background: var(--accent)`，代价是：`PrimaryButton` 失去最后一个使用者变成死代码，且鉴权页的 CTA 与全局约定（`Composer` 发送按钮同样是 `var(--text)`）分叉。复用后按钮 chrome 归 `PrimaryButton`，组件内只保留标签 + 图标那一行的 flex 布局（`.submit-content` / `.retry-content`）。

副作用：悬停抬升与箭头位移随之取消 —— `PrimaryButton` 的悬停是 `background: var(--text-strong)`，父组件的作用域样式够不到它的 `<button>`。这是复用换来的一致性，可接受。

注意 snippet 内容在父组件作用域编译，所以 `.submit-content` / `.spinner` 这些父级作用域样式在传入 `PrimaryButton` 后依然生效。

## 保持不变

- 令牌提交语义、`AuthPage.test.ts` 锁定的全部 DOM 契约
- 图标仍为内联 Lucide SVG，页面无 emoji
- 装饰性文字不使用标题元素（巨型标题随重构一并删除，该约束不再有触发点）
