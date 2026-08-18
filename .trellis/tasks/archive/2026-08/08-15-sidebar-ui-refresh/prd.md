# 对话侧边栏 UI 升级

## Goal

把对话侧边栏（`frontend/src/lib/conversations/Sidebar.svelte`）升级为优雅、简洁、与产品整体设计语言一致的导航面板：让"最近对话"成为唯一的视觉主线，其余入口退到次要层级。纯前端改动，不触碰后端契约。

用户价值：侧边栏是用户在会话之间穿梭的唯一入口，长期停留在视野里。当前实现是按参考截图逐条堆出来的功能行，缺少统一的留白节奏与层级：每行常驻两个图标按钮加一行 model 副标题，顶部挤着三个图标，底部孤零零一个退出图标，整体读起来是"一堆控件"而不是"一份对话清单"。

## Background / Confirmed Facts

### 当前结构（`Sidebar.svelte`，931 行）

- 顶部 `.sidebar-top`（`min-height: 60px`）：品牌 `NookLogo` + "栖语 NooK"；右侧依次为 搜索（`disabled` 占位）、设置（`onOpenSettings`）、收起（桌面 `onCollapse`）或关闭（移动端 `onClose`）。
- 导航区 `.nav-entries`：新建对话（真实 `onNew`）、项目（`disabled` 占位）。
- 列表区 `.list-region`：分区标题「置顶」「最近」→ `.item-row` 行卡片。每行 = 标题按钮（`.item-title` + `.item-model` 两行）+ 常驻 pin 按钮 + 常驻 `···` 菜单按钮。
- 行菜单 `.menu`：分享 / 重命名 / 置顶 / 归档 / 删除 / 移动到项目。其中分享、归档、移动到项目为占位（仅关闭菜单）；重命名（`store.rename`）、删除（`store.remove` + `ConfirmDialog`）为真实路径；置顶为 `store.togglePinPlaceholder` 的本地占位。
- 列表状态：加载中 / 加载失败（含重试）/ 空列表 / 加载更多（`store.hasMore`）。
- 底部 `.sidebar-footer`：仅一个退出登录 icon-button，上方 1px 分隔线。

### 外壳（`AppShell.svelte`）

- 桌面：`grid-template-columns: 300px minmax(0, 1fr)`，`.sidebar-static` 右侧 1px `--border` 分隔线；收起态列宽变 0 并延迟 `visibility: hidden`。
- 移动端（≤760px）：静态列隐藏，改用模态抽屉 `.drawer-panel`，宽 `min(84vw, 320px)`，带 `--shadow` 与焦点陷阱。
- 两种形态共用同一个 `Sidebar` 组件实例，仅 `onClose` / `onCollapse` 二选一。

### 设计语言（`frontend/src/styles/global.css`）

- token：`--bg / --surface / --surface-muted / --text / --text-strong / --muted / --border / --border-strong / --accent / --danger`；间距 `--space-1..7`；圆角 `--radius-sm: 10px` / `md: 16px` / `lg: 20px`；`--shadow`；`--motion-fast: 160ms ease`；`--touch-target: 44px`；`--compact-action-size: 28px`。
- light / dark 两套调色板由 `:root[data-theme="dark"]` 覆盖，组件只读 token。
- 08-15 鉴权页刚完成"去沉浸式、回归简洁卡片"的方向调整，是当前产品视觉基调的最新参照。

### 数据与身份

- `ConversationSummary` 含 `createdAt` / `updatedAt`（[conversations.ts:25](frontend/src/lib/api/conversations.ts:25)），服务端列表已按 `updated_at DESC, id DESC` 排序（[conversation_repository.rs:23](crates/storage/src/conversation_repository.rs:23)）。按时间分档只是对既有顺序做客户端切分，不需要重新排序。
- 会话所用模型在对话头部已有展示（[ChatPane.svelte:393](frontend/src/lib/conversations/ChatPane.svelte:393) `.locked-model`），列表行的 `.item-model` 副标题属于重复信息。
- 鉴权为实例访问令牌制，`SessionStore` 不持有任何用户身份（无用户名 / 邮箱 / 头像）。底部区域只能承载动作入口，做不了"头像 + 用户名"的账户行。
- 设置对话框（`SettingsDialog.svelte`）目前只有「主题」一组设置。

### 规范约束（`.trellis/spec/frontend/`）

- 纯 CSS + 自定义属性，颜色一律走 `global.css` token，不硬编码 hex；不引入 Tailwind / CSS-in-JS / 组件库。
- 图标为内联 SVG 组件（`frontend/src/lib/components/XxxIcon.svelte`），`stroke="currentColor"`，装饰性图标 `aria-hidden="true"`。
- icon-only 按钮必须有 `aria-label`；触摸目标 ≥ 44px（行内紧凑按钮沿用 `@media (any-pointer: coarse)` 的 `::after` 扩大方案）。
- 动效在 `prefers-reduced-motion: reduce` 下降级。
- lint gate 视 svelte-check 警告为失败。

### 测试锁定的 DOM 契约（`AppShell.test.ts`，必须保持）

- `.sidebar-static` 容器类名
- `.item-row` / `.item-row-active`（选中态）
- `[data-row-menu-trigger="<id>"]` 触发器，展开后 `[role='menu']`
- 重命名编辑器 `.edit-form` 与 `#sidebar-rename-input`
- 收起按钮 `button[aria-label='收起侧边栏']`
- `conversation-store.test.ts:398` 锁定 `groupConversations` 把置顶项拆到 `pinned`、其余保持服务端顺序留在 `recents`

## Requirements

### R1 顶部只承载身份与开合

顶部只保留 品牌区 + 收起（桌面）/ 关闭（移动端）一个控件。搜索与设置从顶部移出（去向见 R2、R4）。品牌区的排版重做，使其读作产品标识而非一行普通文字。

### R2 导航区三行入口

导航区呈现三个等价行项：**新建对话**（真实 `onNew`）、**搜索**（`disabled` 占位）、**项目**（`disabled` 占位）。占位行需要有明确但克制的"未启用"视觉表达，并保留 `title` / `aria-label` 中的"即将上线"说明，不使用户误以为是故障。

### R3 会话行降噪

- 行内容收敛为单行标题，移除 `.item-model` 副标题。
- pin 与 `···` 两个行内动作在 hover、`focus-within`、选中态、菜单展开时显现；粗指针（触屏）环境下保持常驻。
- 按钮显隐不得引起行内布局跳动或标题宽度抖动。
- 长标题在动作按钮显现时不得与按钮重叠。

### R4 底部动作行

底部收成一行，承载 **设置**（`onOpenSettings`）与 **退出登录**（`onSignOut`）两个动作入口。退出登录保持其忙碌态（`isSigningOut`）与禁用表现。

### R5 最近会话按时间分档

「最近」分组按 `updatedAt` 切分为 今天 / 昨天 / 过去 7 天 / 过去 30 天 / 更早，空档不渲染。「置顶」分组保持在最前，不参与时间分档。分档在 `conversation-store.svelte.ts` 内以纯函数实现并配单元测试，边界按本地日历日计算。

### R6 统一视觉语言

留白节奏、圆角、描边、hover / 选中 / 聚焦态在侧边栏内部统一，并与鉴权页确立的简洁卡片语言一致：

- 选中态用柔和的 accent 淡色底与加重的文本表达，取代当前生硬的 `inset 2px` 左侧色条。
- 分区标题、列表项、菜单项、底部行共用同一套间距与字号阶梯。
- 所有新颜色来自 `global.css` token（必要时新增 token 并在两套调色板中定义），不得硬编码。

### R7 双形态与双主题一致

桌面静态列与移动端抽屉、light 与 dark 两套调色板下，以上全部表现完整且一致。收起 / 展开动画与抽屉行为不回归。

### R8 无障碍与动效降级

- icon-only 按钮均有 `aria-label`，键盘可完成全部操作（选择、重命名、菜单、置顶、删除、设置、退出）。
- 焦点环可见；hover 才显现的动作在键盘 `focus-within` 下必须可见。
- 触摸目标 ≥ 44px。
- 所有过渡在 `prefers-reduced-motion: reduce` 下关闭。

## Acceptance Criteria

- [x] AC1 顶部只剩 品牌 + 一个开合控件；桌面为 `aria-label='收起侧边栏'`，移动端抽屉为 `aria-label='关闭导航'`（R1）
- [x] AC2 导航区依次为 新建对话 / 搜索 / 项目 三行；后两者 `disabled` 且带"即将上线"提示（R2）
- [x] AC3 列表行不再渲染 `.item-model`；非选中且未 hover / 未聚焦的行不显示 pin 与 `···` 按钮；hover、Tab 聚焦、选中、菜单展开四种情况下按钮可见；`(any-pointer: coarse)` 下常驻（R3）
- [x] AC4 hover 前后行高与标题起始位置不变（无布局跳动）（R3）—— 浏览器实测 hover 前后 `.item-row` 与 `.item-title` 的 `getBoundingClientRect()` 完全一致
- [x] AC5 底部一行同时含设置与退出登录，`isSigningOut` 时退出按钮禁用并更新 `aria-label`（R4）
- [x] AC6 `buildSidebarSections` 为时间分档提供纯函数（`now` 由参数注入），单元测试覆盖五档命中、边界两侧、空档不返回、档内顺序保持、时钟超前归入今天；置顶分组仍在最前且顺序不变（R5）
- [x] AC7 选中行不再使用 `inset 2px` 左侧色条，改为 accent 淡色底 + 文本加重；`.item-row-active` 类名保留（R6）
- [x] AC8 侧边栏样式中无硬编码颜色字面量（遮罩渐变用 `currentColor`）；`--accent-soft` 在 `:root` 与 `:root[data-theme="dark"]` 均有定义（R6）
- [x] AC9 light / dark、桌面 / 移动抽屉四种组合下浏览器实测视觉完整，收起与展开动画正常（R7）
- [x] AC10 `AppShell.test.ts` 锁定的 DOM 契约保持，测试通过；两处断言按 design.md §6 有意反转，另有一处 `:scope >` 选择器随 `.row-actions` 包装层调整（见 design.md §8）（Background）
- [x] AC11 `prefers-reduced-motion: reduce` 下无过渡动画残留（R8）—— 浏览器实测：把两条 `@media (prefers-reduced-motion: reduce)` 的条件临时改写为 `all`，读取计算样式确认 `.shell` / `.sidebar-static` / `.nav-entry` / `.row-actions` 的 `transition-duration` 全部塌缩为 `1e-05s`。发现并修复一处残留：`global.css` 的全局重置只归零 `transition-duration`，不归零 `transition-delay`，而 `AppShell.svelte` 的 `.sidebar-static` 用 `transition: visibility 0s linear 160ms` 靠**延迟**等待宽度动画播完；reduced-motion 下宽度动画不播，该列仍会在 tab order 中滞留 160ms。已在 `AppShell.svelte` 增补局部 `transition-delay: 0s` 覆盖，实测该规则关闭时延迟为 `0.16s`、开启时为 `0s`
- [x] AC12 `npm run lint`、`npm run check`（555 files / 0 errors / 0 warnings）、`npm run test`（474 passed，含 08-18 任务并入的 markdown 用例）、`npm run build` 全部通过（frontend 目录）

## Out of Scope

- 后端契约与 `crates/` 改动。
- 把现有占位功能（搜索、项目、分享、归档、移动到项目）实现为真实功能。
- 置顶的服务端持久化（仍是本地占位，刷新即失）。
- 收起后保留图标 rail 等新形态（Q1 选项 C，本次不做）。
- `ChatPane`、`Composer`、`SettingsDialog` 的视觉改动。

## Key Decisions

- **D1（Q1）** 幅度定为"视觉 + 信息架构轻调整"：允许改动行的信息密度与控件显隐，不新增功能形态。
- **D2（Q2）** 保留搜索与项目占位入口，重新排布：搜索从顶部图标下沉到导航区，设置从顶部下沉到底部动作行。理由是二者是真实产品路线，删除后上线时需重新设计位置；代价是界面上长期存在两个灰态行。
- **D3** 移除列表行的 model 副标题，因为对话头部已展示锁定模型，列表中属重复信息。
- **D4** 底部不做账户行——令牌鉴权下不存在可展示的用户身份。
