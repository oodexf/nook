# 重构鉴权页面为简洁优雅的登录卡片

## Goal

把鉴权页面从 08-14 的"沉浸式艺术画布"方向完全掉头，重构为简洁、优雅、美观的登录卡片：与产品其余部分同一套设计语言，真正跟随 light/dark 主题，去掉所有与登录任务无关的视觉噪音。

用户价值：鉴权页的唯一任务是让用户尽快、无障碍地进入产品。08-14 的粒子画布、跑马灯巨型文字与指针视差把注意力从这个任务上引开，并且把页面永久钉死在深色舞台上，与 App 内部的浅色主题割裂。

## Background / Confirmed Facts

来自仓库代码与 spec 的已确认事实（重构前状态）：

- 鉴权页入口 `frontend/src/lib/auth/AuthPage.svelte`（631 行），外壳 `AuthScene.svelte` 组合 `AuthCanvas.svelte`（265 行 rAF 粒子场）与 `ThemeSwitch.svelte`（294 行弹出菜单）。`App.svelte` 的 `auth-main` 容器渲染三种 session 状态：`checking` / `unauthenticated` / `unavailable`。
- `global.css` 中有 10 个 `--auth-*` token（`--auth-stage-bg` / `--auth-canvas-*` / `--auth-ink*` / `--auth-mega-*` / `--auth-glass*` / `--auth-field-bg`）。它们在 light 与 dark 两套调色板里**都是近黑色**，因此浅色主题下的鉴权页其实是假的浅色。
- `AuthPage.test.ts` 锁定的 DOM 契约（重构必须保持）：
  - `variant="checking"`：存在 `[role='status']`，无 `<form>`
  - `variant="form"`：`input[type='checkbox']` 默认未选中
  - `button[type='submit']` 在令牌为空时 `disabled`
  - 提交成功后清空 `input[type='password']` 的 value；失败 / 抛错时保留
  - `errorMessage` 通过 `[role='alert']` 播报
  - `isSubmitting=true` 时 password input / checkbox / submit button 均 `disabled`
- 令牌契约（`session-store.svelte.ts`）：原始令牌只存在于 `onLogin(token, rememberMe)` 调用期间，永不进入 store / localStorage。`login()` 在每次尝试开始时把 `errorMessage` 置空。
- 样式规范（`.trellis/spec/frontend/component-guidelines.md`）：纯 CSS + 自定义属性，颜色一律来自 `global.css` token，不硬编码 hex；不引入 Tailwind / CSS-in-JS / 组件库；图标为内联 SVG，`aria-hidden="true"`，`stroke="currentColor"`；装饰性文字不得用标题元素（`aria-hidden` 加在 heading 上会触发 svelte-check a11y 警告，而 lint gate 视警告为失败）。
- 无障碍：键盘可达、可见焦点、44×44 触摸目标、4.5:1 文本对比度、尊重 `prefers-reduced-motion`。

## Requirements

### R1 去掉沉浸式外壳

移除粒子 canvas、跑马灯文字带、巨型视差标题、玻璃拟态深色舞台。鉴权页不得有每帧运行的 rAF 循环或指针跟踪。

### R2 与 App 同一套设计语言

页面主体复用通用 token（`--surface` / `--text` / `--text-strong` / `--muted` / `--border` / `--accent` / `--shadow`）。浅色主题下必须是真正的浅色。允许保留的鉴权专属 token 仅限背景氛围所需，且在两套调色板中都要定义。

### R3 三种状态共用一张卡片

`checking` / `form` / `unavailable` 使用同一形状、同一位置的卡片。居中与背景由 `AuthScene` 统一拥有，各状态只负责自己的内容。

### R4 保留 DOM 契约与提交语义

不得破坏 `AuthPage.test.ts` 锁定的 DOM 结构与提交语义（见 Background）。

### R5 错误提示表现在令牌输入框上

登录失败不再用独立的错误面板，而由令牌输入框本身表达：

- 颜色：边框与图标转为 `--danger`，输入框底色叠一层危险色，聚焦环同步变红
- 动画：一次短促收敛的横向摇动
- 文案：`[role='alert']` 消息作为输入框正下方的说明文字，并通过 `aria-invalid` / `aria-describedby` 与输入框关联
- 恢复：用户一开始修改令牌，颜色、动画、文案同时清除
- 只有"本次提交被拒绝"才染红输入框；没有伴随提交的消息（如会话过期）只显示文案，不把空输入框刷成红色

### R6 主题切换器简化

用一个三段式单选胶囊（跟随系统 / 浅色 / 深色）替换弹出菜单，去掉开合状态、外点关闭与焦点陷阱。分组与方向键漫游交给原生 radio。焦点环只在键盘操作时出现。

### R7 无障碍与动效降级

键盘可完成全部流程，焦点可见，触摸目标 ≥ 44px。所有动效（入场、氛围漂移、摇动、错误文案淡入、loader 旋转）在 `prefers-reduced-motion: reduce` 下关闭；关闭动效后失败仍能仅凭颜色被识别。

## Acceptance Criteria

- [x] `AuthCanvas.svelte` 已删除，代码库中不再有 rAF 粒子循环或指针视差
- [x] `global.css` 中 `--auth-*` token 从 10 个减到 2 个（`--auth-glow-1/2`），两套调色板均有定义；其余颜色来自通用 token
- [x] 浅色主题下鉴权页为浅色，深色主题下为深色，两者视觉完整
- [x] `checking` / `form` / `unavailable` 使用同一张卡片样式（`checking` 收成同款横向小胶囊）
- [x] `AuthPage.test.ts` 全部断言通过，DOM 契约未变
- [x] 登录失败时输入框边框/底色/图标转为危险色并摇动一次，`[role='alert']` 文案位于输入框下方，输入框带 `aria-invalid` / `aria-describedby`
- [x] 修改令牌后 `invalid` 类、alert 元素、`aria-invalid` / `aria-describedby` 同步清除（浏览器实测）
- [x] 会话过期类消息只显示文案，不触发输入框染红
- [x] 主题切换器为三段式 radio 胶囊，鼠标点击不残留焦点环
- [x] `npm run check` 0 errors 0 warnings；`npm run lint` 通过；`npm test` 386 tests 全绿；`npm run build` 通过
- [x] 明/暗主题、桌面与移动视口下的表单态、填写态、提交中、错误态、验证中均已在浏览器实测

## Notes

- **流程偏差（诚实记录）**：本任务的实现先于任务记录完成。执行会话读了 `AGENTS.md`，但只顺着它取了 `.trellis/spec/frontend/component-guidelines.md`，漏读了 `.trellis/workflow.md`，因此跳过了 Phase 1 的建任务与许可确认，直接进入实现。本 PRD 与 `design.md` 是事后补录，验收项按实际验证结果勾选。
- 客观因素：Trellis 未接入 Claude Code —— `.claude/` 在本次会话前为空，钩子与技能只装在 `.codex/` / `.pi/` / `.agents/`，因此本会话没有 SessionStart 注入，也没有每轮 `[workflow-state:...]` 面包屑。是否补装由后续决定。
- 本任务取代 `08-14-auth-page-redesign`（方向相反：沉浸式 → 简洁）。该任务已归档。
- 未写 `implement.md`：实现已完成，事后补一份执行计划没有价值。技术决策记录在 `design.md`。
