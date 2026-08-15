# Implement: 沉浸式鉴权页面执行计划

## 前置：已完成

- [x] Trellis 任务 `08-14-auth-page-redesign` 已创建
- [x] PRD / design.md / implement.md 已就绪
- [x] Lucide 图标组件已创建（`LoaderCircleIcon`、`ArrowRightIcon`、`KeyRoundIcon`、`EyeIcon`、`EyeOffIcon`、`CircleAlertIcon`、`RefreshCwIcon`、`SparklesIcon`、`ShieldCheckIcon`）

## 执行清单

### 1. 新增 Lucide 图标组件（已完成）
- `LoaderCircleIcon.svelte`、`ArrowRightIcon.svelte`、`KeyRoundIcon.svelte`、`EyeIcon.svelte`、`EyeOffIcon.svelte`、`CircleAlertIcon.svelte`、`RefreshCwIcon.svelte`、`SparklesIcon.svelte`、`ShieldCheckIcon.svelte`

### 2. global.css 沉浸式 token
- 在 light / dark `:root` 各新增沉浸式所需 token（如 `--auth-canvas-particle`、`--auth-glass`、`--auth-glass-border`、`--auth-mega-weight` 等），保持不硬编码 hex 的规范。
- 扩展 `.auth-main` 规则为全出血舞台容器（`position: relative`、`overflow: hidden`、`min-height: 100dvh`）。

### 3. AuthCanvas.svelte（Canvas 物理动效）
- 全视口 `<canvas>`，`position: absolute; inset: 0`。
- rAF 循环：粒子/文字残影随鼠标弹簧牵引；dpr 适配；ResizeObserver 重算尺寸。
- 颜色读 CSS 变量；`document.hidden` 与 `prefers-reduced-motion` 暂停。
- 指针位置用模块级普通变量，不触发响应式。

### 4. 重构 AuthPage.svelte
- 三状态统一沉浸式语言（同一画布与版式系统连续过渡）。
- `checking`：保留 `[role=status]`、无 `<form>`；Lucide loader 动效校验态。
- `form`：保留 `<form>` + `input[type=password]`（带 Eye/EyeOff 显示切换）+ 默认未选中 `input[type=checkbox]` + `button[type=submit]`（空 token disabled）；密码字段 key 图标；提交按钮 ArrowRight 图标；`errorMessage` 走 `[role=alert]`；`isSubmitting` 全 disabled。
- 提交语义不变：成功清空字段、失败/抛错保留字段。
- 实验性排版：巨型标题、负字距、kinetic 字带、鼠标视差。

### 5. AuthScene.svelte（舞台壳）
- 组合 Canvas 层 + 排版层（kinetic 字带、巨型视差字）+ 内容层（AuthPage）。
- 纯布局与动效协调，不持有业务状态。

### 6. App.svelte 接线
- `auth-main` 包裹 `AuthScene`，将 checking / form 两种 `AuthPage` variant 与 unavailable 状态统一纳入沉浸式框架。
- 保持 body 不锁定（AppShell 拥有 lock）。

### 7. 验证（Quality Gate）
- `npm run check`（svelte-check / 类型）
- `npm run lint`（eslint，warning 即失败）
- `npm test`（vitest，`AuthPage.test.ts` 8 用例必须全过）
- `npm run build`（生产构建）

## 风险点 / 回滚

- **测试契约破坏**：重构若误改 DOM 结构会导致 `AuthPage.test.ts` 失败 → 回滚 AuthPage 的表单语义部分，保留 DOM 契约。
- **性能 gate**：Canvas 动画过重 → 限制粒子数、dpr、暂停条件。
- **主题对比度**：沉浸式背景降低表单可读性 → 表单卡片用玻璃 + 实色底，保证 ≥4.5:1。
- 回滚点：每个组件独立，可单独还原；`global.css` 改动可按 token 块还原。
