# Design: 沉浸式鉴权页面（排版实验主义方向）

## Architecture & Boundaries

```text
App.svelte (auth-main 容器)
└─ AuthScene.svelte          [新增] 沉浸式舞台壳：Canvas 层 + 排版层 + 内容层
    ├─ AuthCanvas.svelte     [新增] Canvas 2D 物理动效（鼠标牵引文字残影 / 粒子）
    └─ AuthPage.svelte       [重构] 三状态内容（checking / form），保留 DOM 契约
```

- `AuthScene` 负责"浏览器即画布"的舞台骨架与全出血布局，归 auth 目录（feature 内部，符合 directory-structure spec）。
- `AuthCanvas` 是纯渲染副作用组件，不持有业务状态，仅读 `pointer` 位置；rAF 批处理、dpr 适配、ResizeObserver、`visibilitychange` / `prefers-reduced-motion` 暂停。
- `AuthPage` 保持单一职责：渲染状态内容 + 表单提交语义。排版层（巨型字、滚动字带）由 AuthScene/AuthPage 协作，DOM 契约不破坏。
- `App.svelte` 的 unavailable 状态也纳入 AuthScene 框架，统一沉浸式语言。

## Canvas 数据流与契约

- `AuthCanvas` 内部维护粒子/残影数组，每帧 rAF 更新 + 一次性绘制，无 React/Svelte 状态抖动。
- 指针位置通过组件内 `pointermove` 监听写入模块级普通变量（非 `$state`），避免每帧触发响应式更新。
- 颜色全部从 `getComputedStyle(document.documentElement)` 读取 CSS 自定义属性（主题切换自动生效），不硬编码。
- 暂停条件：`document.hidden`、`matchMedia('(prefers-reduced-motion: reduce)')`。resize 时重算画布尺寸与 dpr。

## 排版层设计

- 顶部/底部 kinetic 文字带：`NOOK` 重复字 + 语义文案，横向 CSS 动画 marquee（`prefers-reduced-motion` 降级为静止）。
- 巨型标题"栖""语""欢迎回来"：超大 `clamp()` 字号、负字距、混合字重；鼠标视差通过 `transform: translate3d` 弹簧跟随。
- 表单卡片：玻璃质感（`backdrop-filter`）悬浮于排版之上，保持 44px 触摸目标与可见焦点。

## 兼容性与迁移

- 不改 session-store 状态机、不改登录令牌处理逻辑。
- `AuthPage.test.ts` 的 DOM 契约完全保留（`role=status` / `role=alert` / input 类型 / button[type=submit] / disabled 逻辑 / 清空保留语义）。
- `App.svelte` 的 `auth-main` 布局从居中卡片调整为全出血舞台；`.auth-main` global 规则相应扩展。
- 无新增运行时依赖（Canvas 2D 原生 API + 内联 SVG Lucide 组件）。

## 主题与无障碍

- 所有颜色走 `global.css` 自定义属性；沉浸式新增 token 在 light/dark 各加一套。
- 键盘：表单原生 `<form>` 提交，tab 顺序自然，`input[type=password]` 显示切换按钮带 `aria-label`。
- 焦点环可见（`:focus-visible`）。
- `prefers-reduced-motion`：Canvas 动画停止、marquee 静止、视差位移归零，保留功能可用。

## 性能考量

- Canvas 粒子数上限（≈80），dpr 限制 ≤2，rAF 单帧一次绘制。
- `backdrop-filter` 仅用于小面积表单卡片，避免大面积性能损耗。
- 字体使用系统栈（已有 global.css），无网络字体加载。

## 权衡

- 选用 Canvas 2D 而非 WebGL：无依赖、bundle 不增、满足"高级渲染逻辑"且 250KB 性能 gate 安全。
- 排版主导而非粒子主导：贴合用户选择的"排版实验主义"方向，文字版式即冲击力来源。
- 沉浸式壳与内容页分离（AuthScene vs AuthPage）：保持 AuthPage 可测、DOM 契约清晰。
