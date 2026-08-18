# 设计:对话侧边栏 UI 升级

## 1. 边界

改动范围限定在四个文件:

| 文件 | 改什么 |
|---|---|
| `frontend/src/lib/conversations/Sidebar.svelte` | 结构重排 + 全部样式重做(主体工作) |
| `frontend/src/lib/conversations/conversation-store.svelte.ts` | `groupConversations` → `buildSidebarSections` 时间分档纯函数 |
| `frontend/src/styles/global.css` | 新增 `--accent-soft` token(两套调色板) |
| `frontend/src/lib/conversations/AppShell.test.ts` / `conversation-store.test.ts` | 跟随结构变化更新断言 |

`AppShell.svelte` 不改:栅格宽度(300px)、抽屉宽度(`min(84vw, 320px)`)、收起动画、焦点管理全部保持。侧边栏在两种形态下仍是同一个组件实例。

## 2. 版面结构

```
┌─ .sidebar ────────────────────────────┐
│ .sidebar-top   品牌            [收起] │  ← 只剩两件东西
├───────────────────────────────────────┤
│ .nav-entries   ✎ 新建对话             │
│                🔍 搜索      (disabled) │  ← 搜索从顶部下沉到这里
│                📁 项目      (disabled) │
├───────────────────────────────────────┤
│ .list-region   置顶                   │  ← 唯一的滚动区
│                ● 对话 A               │
│                今天                    │
│                ● 对话 B      [📌][···] │  ← 动作 hover/聚焦才现
│                过去 7 天              │
│                ● 对话 C               │
├───────────────────────────────────────┤
│ .sidebar-footer  [⚙]  [⇥]            │  ← 设置从顶部下沉到这里
└───────────────────────────────────────┘
```

## 3. 时间分档(R5)

### 契约

`conversation-store.svelte.ts` 用一个纯函数替换现有 `groupConversations` / `ConversationGroups`:

```ts
export type ConversationSection = {
  /** 稳定的 keyed-each 键,与 label 解耦 */
  key: "pinned" | "today" | "yesterday" | "week" | "month" | "older";
  label: string;
  items: ConversationSummary[];
};

export function buildSidebarSections(
  conversations: ConversationSummary[],
  now: number
): ConversationSection[];
```

- `now` 显式注入(不在函数内调 `Date.now()`),这是分档能被单元测试确定性覆盖的前提。调用方 `Sidebar.svelte` 传 `Date.now()`。
- 置顶项先被 `pinned` 吸走,不参与时间分档(与现状一致)。
- 其余项按 `updatedAt` 落档,**保持服务端传入的相对顺序**(服务端已按 `updated_at DESC` 排序,所以档内天然有序,不重新排序)。
- 空档不出现在返回数组里,渲染层不必再判空。

### 边界规则(本地日历日)

以本地午夜为基准,用 `new Date(y, m, d - n)` 构造边界(而不是减 `n * 86400000` 毫秒),这样跨夏令时不会错位:

| 档位 | 区间 |
|---|---|
| `today` | `>= 今天 00:00` |
| `yesterday` | `[昨天 00:00, 今天 00:00)` |
| `week` | `[今天-6d 00:00, 昨天 00:00)` |
| `month` | `[今天-29d 00:00, 今天-6d 00:00)` |
| `older` | `< 今天-29d 00:00` |

标签:`置顶 / 今天 / 昨天 / 过去 7 天 / 过去 30 天 / 更早`。

时钟偏移导致 `updatedAt > now` 时归入 `today`(上界开放),不产生"未来"档。

### 为什么替换而不是新增

新增函数会让 `groupConversations` 变成无人调用的导出(check 阶段会判定为死代码)。直接替换,并同步改 `conversation-store.test.ts:398` 的那条用例。

## 4. 行内动作的显隐(R3, AC3/AC4)

这是本次唯一有技术风险的部分,需求是"默认隐藏、四种情况显现、不产生布局跳动、不与长标题重叠",三者互相冲突:

- 若动作参与 flex 流并常驻占位 → 无跳动、无重叠,但每行永久损失 ~64px 标题宽度(300px 列里代价明显)。
- 若动作 `display: none` ↔ 显示 → 无损失,但显隐瞬间标题宽度突变,违反 AC4。

**采用方案:动作绝对定位 + 标题尾部遮罩。**

- `.item-row` 保持 `position: relative`(现状已是),动作容器 `position: absolute; right: var(--space-1)`,脱离流,因此标题按钮始终是整行宽,idle 态没有任何空间损失。
- 动作默认 `opacity: 0; pointer-events: none`,在 `.item-row:hover`、`.item-row:focus-within`、`.item-row-active`、`.item-row[data-menu]` 四种情况下变为 `opacity: 1; pointer-events: auto`。`opacity` 不影响布局 ⇒ 零跳动。
- 重叠问题交给遮罩:同样这四种情况下给 `.item-title` 加
  `mask-image: linear-gradient(to right, #000 calc(100% - 72px), transparent)`(带 `-webkit-` 前缀),标题尾部渐隐,不会撞上按钮。遮罩不是布局属性,同样零跳动。
- `opacity: 0` 的元素仍在无障碍树里且可聚焦 —— 这正是 `focus-within` 方案生效的前提(Tab 进入 → 行获得 `focus-within` → 按钮现形)。因此**不能**用 `visibility: hidden`,那会让按钮无法被 Tab 到。
- 粗指针环境没有 hover:`@media (any-pointer: coarse)` 下动作无条件 `opacity: 1`,遮罩也无条件生效(等价于现状的常驻表现)。
- 过渡走 `--motion-fast`,在 `prefers-reduced-motion` 下由 `global.css` 的全局降级规则接管。

## 5. 视觉语言(R6)

### 新 token

`global.css` 新增一个,两套调色板都要定义:

```css
:root                   { --accent-soft: rgb(29 78 216 / 0.08); }
:root[data-theme="dark"]{ --accent-soft: rgb(96 165 250 / 0.16); }
```

深色下比例更高,因为浅蓝在深底上的可见度低于深蓝在浅底上的可见度。侧边栏内其余颜色全部复用既有 token,不再新增。

### 各区规格

| 区域 | 规格 |
|---|---|
| `.sidebar-top` | `min-height: 60px`(不变,与 `ChatPane` 头部对齐);`padding: 0 var(--space-2) 0 var(--space-4)` |
| 品牌 | logo 26px + `栖语` 0.95rem/750 + `NooK` 0.85rem/650 `--muted`(不变) |
| `.nav-entries` | 三行;`gap: 2px`;行 `min-height: var(--touch-target)`,`border-radius: var(--radius-sm)`,icon 20px,`gap: var(--space-3)`,0.875rem/600 |
| 禁用导航行 | `color: var(--muted)`,无 hover 反馈,`cursor: default`,保留 `title` / `aria-label` 的"(即将上线)" |
| `.section-label` | 0.72rem/600 `--muted`;`margin: var(--space-4) var(--space-3) var(--space-1)`;首个分区上边距收敛为 `var(--space-2)` |
| `.item-row` | `min-height: var(--touch-target)`;`border-radius: var(--radius-sm)`;仅背景色过渡 |
| `.item` | 单行标题,0.875rem/500,`--text`;`padding: var(--space-2) var(--space-3)` |
| hover | `background: var(--surface-muted)` |
| 选中 `.item-row-active` | `background: var(--accent-soft)`;标题 `--text-strong`/600;**移除** `inset 2px 0 0 var(--accent)` |
| 行内动作 | `--compact-action-size` 28px,`border-radius: 8px`,hover/focus 时 `background: var(--surface)` + `border-color: var(--border-strong)`(沿用现状) |
| `.menu` | 保持现状(已符合语言);仅同步圆角与间距阶梯 |
| `.sidebar-footer` | `border-top: 1px solid var(--border)`;`padding: var(--space-2) var(--space-3)`;`display: flex; gap: var(--space-1)`;两个 `.icon-button` |
| 滚动条 | `.list-region` 加 `scrollbar-width: thin` + `scrollbar-color: var(--border-strong) transparent` |

### 为什么去掉左侧色条

`inset 2px 0 0 var(--accent)` 是画在 10px 圆角矩形左边的一根直角硬边,在圆角处会被裁出一段突兀的直线。改用整块 accent 淡色底 + 文本加重,选中感更强且形状自洽 —— 这与鉴权页"用柔和面而非硬边表达状态"的方向一致。

## 6. 需要跟随修改的测试

结构变化会打破四处现有断言。它们都是**被本次改动有意作废的旧契约**,不是回归:

| 位置 | 现状断言 | 新断言 |
|---|---|---|
| `AppShell.test.ts:1179` `opens settings left of the collapse control` | 设置按钮在收起按钮**之前** | 设置按钮移入底部,改为断言它在收起按钮**之后**;用例名同步改为 `opens settings from the sidebar footer` |
| `AppShell.test.ts:1326` | `.section-label` 文本为 `最近` | 改为 `今天`,并让 `summary()` fixture 的 `updated_at` 用 `Date.now()` 而非固定的 `1786000001000`(该固定值会随真实时间推移落进"更早"档,导致用例随时间腐坏) |
| `AppShell.test.ts:1226` | `.sidebar-static button[aria-label='搜索(即将上线)']` 且 `disabled` | **保持不变**:搜索行虽然从顶部图标变成导航行,但仍是 `<button>` 且沿用同一 `aria-label`,断言天然成立 |
| `conversation-store.test.ts:398` | `groupConversations` 返回 `{pinned, recents}` | 改为 `buildSidebarSections`,并补齐五档边界 + 空档不返回 + 档内顺序保持的用例 |

其余被锁定的契约(`.item-row` / `.item-row-active` / `[data-row-menu-trigger]` / `[role='menu']` / `.edit-form` / `#sidebar-rename-input` / `.nav-entry` / `button.sign-out[aria-label='退出登录']` / `.section-label` 类名本身 / `收起侧边栏` / `关闭导航`)**全部原样保留**。

## 7. 风险与回退

| 风险 | 处理 |
|---|---|
| `opacity: 0` 的动作按钮在 jsdom 里仍可被 `querySelector` 找到并 `.click()`,现有用例不会察觉"隐藏" | 这是好事:现有交互用例不受影响;AC3 的显隐是 CSS 行为,靠浏览器实测验收,不写成脆弱的 jsdom 断言 |
| `mask-image` 在旧 Safari 需前缀 | 同时写 `-webkit-mask-image`;即便完全不生效,退化结果只是长标题被按钮盖住一角,不影响功能 |
| 时间分档使函数依赖当前时间 | `now` 作为参数注入,测试确定性;fixture 时间戳改用 `Date.now()` 派生,避免用例随时间腐坏 |
| 底部同时出现设置与退出,误触退出 | 退出登录已有 `ConfirmDialog` 之外的忙碌态保护;两按钮之间保持 `--space-1` 间隔与各自 44px 触摸目标 |

回退点:本任务的改动集中在 `Sidebar.svelte` 一个文件的 `<style>` 与模板,`git checkout -- frontend/src/lib/conversations/Sidebar.svelte` 即可回到改前状态;`buildSidebarSections` 与 `--accent-soft` 是独立的两次提交,可单独回滚。

## 8. 实现期偏差(实测后回填)

三处与上文设计不同,均为浏览器实测暴露的问题:

**8.1 `.list > li` 需要 `min-width: 0`(设计遗漏的真实缺陷)**

`.list` 是 grid,`li` 作为 grid item 默认 `min-width: auto`,其自动最小尺寸取内容的 min-content。行内 `min-width: 0` 的链条在 `li` 这一层被截断,于是一条长标题把 283px 的行撑到 484px,标题既不省略号也不渐隐,直接被 `.sidebar-static` 的 `overflow: hidden` 从右侧切掉。加 `.list > li { min-width: 0 }` 后行宽回到 283px,省略号与遮罩同时恢复。

这个缺陷在改动前就潜伏着(旧结构同样是 grid item 套 flex 行),只是旧版每行右侧常驻两个按钮、标题可用宽度更小,不容易撞上。

**8.2 遮罩改为两段式,并抽成 `--title-fade-mask`**

设计里的单停靠点 `linear-gradient(to right, #000 calc(100% - 72px), transparent)` 实测下渐变太缓:按钮起点处标题仍有约 70% 不透明度,文字与图标叠在一起。改为在按钮起点前就已完全透明的两段式:

```css
--title-fade-mask: linear-gradient(
  to right,
  currentColor calc(100% - 92px),
  transparent calc(100% - 48px)
);
```

同时抽成 `.sidebar` 上的自定义属性,供 hover/focus 规则与 coarse-pointer 规则共用;渐变色用 `currentColor` 而非 `#000`,以免在样式里留下颜色字面量(AC8)。

**8.3 多一处测试选择器调整(§6 未预见)**

`AppShell.test.ts:786` 的 `treats the sidebar item row as one card with two independent controls` 用 `:scope > button[...]` 断言两个动作按钮是 `.item-row` 的直接子元素。新增的 `.row-actions` 定位包装层打破了这一点,选择器改为 `:scope > .row-actions > button[...]`,并补了一条 `expect(item?.querySelector("button")).toBeNull()`——用例真正要守的是"没有嵌套的交互元素",这条断言比"必须是直接子元素"更贴近本意,也更不易被无关的结构调整误伤。
