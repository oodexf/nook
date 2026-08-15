# 重构鉴权页面为沉浸式交互体验

## Goal

将鉴权页面从当前居中卡片式登录表单，完全重构为一个把浏览器视作交互式艺术画布的沉浸式数字体验。目标对标 Awwwards / FWA / CSS Design Awards 每日最佳网站的水准：先锋视觉风格、实验性排版、流畅物理动效、极具冲击力的文字版式，做出突破常规 UI 认知、令人惊艳的统一完整页面。

用户价值：鉴权是用户进入产品的第一个触点，一次令人惊艳的入场体验能建立品牌记忆与情感连接，区别于千篇一律的登录卡片。

## Background / Confirmed Facts

来自仓库代码与 spec 的已确认事实：

- 鉴权页面入口：`frontend/src/lib/auth/AuthPage.svelte`，由 `frontend/src/App.svelte` 的 `auth-main` 容器渲染，覆盖三种 session 状态：
  - `checking`（会话校验中）→ 显示 `role="status"` 区域，无表单
  - `unauthenticated`（未登录）→ 登录表单
  - `unavailable`（连接失败）→ 重试入口（由 `App.svelte` 渲染，非 `AuthPage` 内部）
- 登录提交契约（`session-store.svelte.ts`）：原始令牌只在 `onLogin(token, rememberMe)` 调用内存中存在，成功后清空字段，失败时保留字段供用户修正。令牌永不进入 store / localStorage。
- 现有测试契约（`AuthPage.test.ts`）锁定的 DOM 契约，重构必须保持：
  - `variant="checking"`：存在 `[role='status']`，无 `<form>`
  - `variant="form"`：`input[type='checkbox']` 默认未选中
  - `button[type='submit']` 在令牌为空时 `disabled`
  - 提交成功后清空 `input[type='password']` 的 value
  - 失败 / 抛错时保留 `input[type='password']` 的 value
  - `errorMessage` 通过 `[role='alert']` 播报
  - `isSubmitting=true` 时 password input / checkbox / submit button 均 `disabled`
- 图标规范（`.trellis/spec/frontend/component-guidelines.md`）：内联 SVG，`size` prop，`aria-hidden="true"`，`stroke="currentColor"`。项目无 lucide 依赖，沿用内联 SVG 路径（路径数据来自 Lucide）即可视为"统一使用 Lucide 图标"。
- 样式规范：纯 CSS + CSS 自定义属性，颜色来自 `global.css` token，不硬编码 hex（需新增 token 时同时在 light/dark 两套调色板新增）。不引入 Tailwind / CSS-in-JS / 组件库。
- 主题：`App` 持有 `themeStore`，通过 `data-theme` 切换 light/dark。鉴权页需在两套主题下都成立。
- 无障碍：键盘可达、可见焦点、44×44 触摸目标、4.5:1 文本对比度、尊重 `prefers-reduced-motion`。
- 性能 gate：生产环境压缩后初始资源目标 < 250KB。Canvas 动画需 rAF 批处理、受限粒子数、隐藏时暂停。
- body 锁定：`AppShell` 拥有 `app-shell-lock`；鉴权页保持正常文档流（允许滚动）。

## Requirements

### R1 沉浸式画布背景
全视口交互式 `<canvas>` 背景，呈现物理动效（粒子流场 / 引力交互）。鼠标移动产生可感知的物理响应。不使用第三方库，纯 Canvas 2D 渲染。隐藏标签页 / `prefers-reduced-motion` 时停止动画。

### R2 实验性排版与冲击力文字版式
突破传统居中卡片布局：大尺度文字版式、动态字重 / 字距变化、kinetic 排版元素（如滚动文字带）。文字内容使用产品已有的语义文案（"栖语"、"欢迎回来"、"访问令牌"、"记住我"、"继续"、"正在验证…"）。

### R3 统一 Lucide 图标，全程无表情符号
所有图标使用 Lucide 内联 SVG 组件。页面任何位置不得出现 emoji。提交按钮带方向性箭头图标，密码字段带可切换的显示 / 隐藏图标，校验态用 Lucide loader。

### R4 保留 DOM 契约与提交语义
重构不得破坏 `AuthPage.test.ts` 锁定的 DOM 结构与提交语义（见 Background）。表单仍以 `<form>` + `<button type="submit">` 提交，token 行为不变（成功清空 / 失败保留）。

### R5 主题适配与无障碍
light / dark 双主题下视觉完整、对比度达标。键盘可完成全部流程，焦点可见，触摸目标 ≥ 44px。动效在 `prefers-reduced-motion` 下降级。

### R6 三个状态视觉统一
checking / form 两个状态在 `AuthPage` 内以统一沉浸式语言呈现（同一画布与版式系统连续过渡，而非切换到完全不同的页面）。`App.svelte` 渲染的 unavailable 状态也应纳入同一沉浸式框架。

### R7 性能与可维护性
无新增运行时依赖。Canvas 渲染 rAF 批处理、粒子数受限、dpr 适配、ResizeObserver 处理缩放、`visibilitychange` 暂停。代码遵循 spec 的组件职责与样式规范。

## Acceptance Criteria

- [ ] `AuthPage.svelte` 在 `variant="checking"` 时渲染 `[role='status']` 且无 `<form>`；视觉为沉浸式校验态（带 Lucide loader 动效）
- [ ] `AuthPage.svelte` 在 `variant="form"` 时渲染 `input[type='password']`（带显示/隐藏切换）、默认未选中的 `input[type='checkbox']`、`button[type='submit']`（空 token 时 disabled）
- [ ] 提交成功后 `input[type='password']` value 清空；失败 / 抛错时保留 value
- [ ] `errorMessage` 通过 `[role='alert']` 播报
- [ ] `isSubmitting=true` 时 password / checkbox / submit 均 disabled
- [ ] 全页面无 emoji；所有图标为 Lucide 内联 SVG 组件
- [ ] 存在全视口交互式 Canvas 背景，响应鼠标移动，`prefers-reduced-motion` 与隐藏标签页时停止
- [ ] light / dark 两套主题下视觉完整、文本对比度 ≥ 4.5:1
- [ ] 全流程键盘可达、焦点可见、触摸目标 ≥ 44px
- [ ] `App.svelte` 的 unavailable 状态纳入统一沉浸式框架
- [ ] 无新增运行时依赖
- [ ] `npm run check` / `npm run lint` / `npm test` / `npm run build` 全绿
- [ ] `AuthPage.test.ts` 8 个用例全部通过（DOM 契约未破坏）

## Out of Scope

- 新增第三方运行时依赖（lucide-svelte / 动画库 / WebGL 框架）
- 修改 session-store 的状态机或登录令牌处理逻辑
- 修改 AppShell 或其他已认证界面
- 新增鉴权方式（OAuth / SSO 等）
- 国际化框架（沿用现有中文硬编码文案风格）

## Technical Notes

- 新增 Lucide 图标组件：`LoaderCircleIcon`、`ArrowRightIcon`、`KeyRoundIcon`、`EyeIcon`、`EyeOffIcon`（已开始创建），复用现有 `CheckIcon`、`NookLogo`、`PrimaryButton` 视情况。
- Canvas 背景逻辑独立为 `AuthCanvas.svelte` 组件（feature 内部，按 directory-structure spec 归属 auth 目录），不污染全局。
- `App.svelte` 的 `auth-main` 容器需支持全出血沉浸式布局；`.auth-main` 的 global.css 规则需调整以承载 canvas + 面板堆叠。
- 颜色按 spec 要求全部走 CSS 自定义属性，新增的沉浸式视觉所需 token 在 `global.css` 的 light / dark 各加一套。

## Design Direction (已确认)

用户选择 **排版实验主义（Typographic Experimentalism）**：

- 文字本身即视觉主体与画布。全屏大尺度排版 + kinetic 滚动文字带（NOOK 重复字带横向滚动）。
- 鼠标移动让巨型字产生视差位移与轻微物理位移（弹簧物理）。
- 极简、纯净背景；版式即主视觉，大尺度字重/字距对比制造冲击力。
- 配合 Canvas 物理动效层（轻量粒子 / 文字残影随鼠标牵引），但文字版式占据视觉主导。

## Open Questions

无。所有决策已通过仓库证据与用户审美选择解决。
