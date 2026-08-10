# 新建对话页 UI 升级 — 技术设计

## 架构与边界

```
ChatPane
  ├─ EmptyConversation          (精简:Logo + 随机问候语,删除说明文案与模型卡片)
  └─ Composer
       └─ [新增] ComposerModelSelector   (仅草稿视图渲染,位于发送按钮左侧)
            ├─ 触发按钮:显示当前 draftModelId 对应 label
            └─ 弹出卡片(向上弹出):模型列表 + 刷新 + 加载/错误/过期状态
```

- 新组件 `frontend/src/lib/models/ComposerModelSelector.svelte` 接管原
  `DraftModelSelector.svelte` 的全部职责(选择、刷新、状态展示),
  旧组件文件删除(全仓库仅 EmptyConversation 引用)。
- `Composer.svelte` 保持领域无关:新增可选 snippet 属性(如 `beforeSend`),
  由 ChatPane 注入模型选择控件,Composer 不直接依赖 ModelStore。
- `ChatPane.svelte` 决定何时渲染控件:仅当 `store.detailStatus === "idle"`
  且非流式(`!streamVisible`)时;已有对话视图维持头部 locked-model 标签,
  不在输入框内重复显示。

## 问候语

新文件 `frontend/src/lib/conversations/greetings.ts`:

- 按本地时间 `new Date().getHours()` 分桶:凌晨 0–5 / 早上 5–11 /
  中午 11–14 / 下午 14–18 / 晚上 18–24。
- 每桶 3–4 条预选问候语;`pickGreeting(date = new Date())` 先定桶再桶内随机。
- `EmptyConversation` 在组件初始化时取一次存入 `$state`(非响应式重算),
  同一视图内不闪烁;每次重新进入草稿视图(组件重建)重新随机。
- 可注入 date 参数保证单元测试确定性。

## ComposerModelSelector 交互契约

- 触发按钮:显示当前模型 label(找不到时回退显示 id);右侧新增
  `ChevronsUpDownIcon`(Lucide 路径内联组件);面板打开时
  `aria-expanded="true"`。选中行用现有 `CheckIcon`。全部图标为 Lucide
  官方路径的内联 SVG 组件,不使用表情符号。
- 弹出卡片:`position: absolute; bottom: 100%`,右对齐于触发按钮,
  向上弹出;`role="dialog"`,aria-label "选择模型"。
- 状态映射(沿用 store 语义):
  - `idle/loading` → "正在加载模型列表..."
  - `error` → 配置错误/普通错误文案 + 重试按钮(调 `store.refresh`)
  - `ready` → stale 横幅(如有)+ 模型行列表(当前项带选中标记,
    点击 → `store.selectDraftModel(id)` 成功后关闭面板)
  - 刷新成功提示沿用"模型列表已更新。"
- 关闭:选择模型后、Esc、点击面板外(`window` pointerdown 判断包含关系)。
  关闭后焦点回到触发按钮。
- 不显示"更新于"时间戳与"默认模型:..."提示(属删除范围);
  刷新按钮保留在弹出卡片头部。

## 兼容与迁移

- `model-store` 无任何 API 变更;选择仍走 `selectDraftModel`(校验 + 持久化)。
- `composerDisabled` 门控不变;控件本身在 store 未 ready 时仍可选择前展示状态。
- spec `component-guidelines.md` 中的组件树提及 `DraftModelSelector`,
  实施后需同步更新(Composer 下的模型选择改为 ComposerModelSelector,
  位置从中央卡片变为输入框内)。

## 视觉品质(Awwwards 标尺)

- 弹出卡片:细腻阴影(var(--shadow) 或新增 elevation 令牌)、圆角、
  开合动效(opacity + translateY 150–200ms,沿用 --motion-* 令牌,
  `prefers-reduced-motion` 下降为无动画)。
- 问候语作为主视觉:更大字号/字重层级与字距微调,配 Logo 构成居中式
  hero;其余元素保持克制留白。
- 所有可交互元素具备 hover 与 focus-visible 反馈;行间选中态用
  accent 底色 + CheckIcon,不用表情符号。

## 测试影响

- `AppShell.test.ts` L1530–1790 的 `#draft-model-select` / 刷新按钮用例
  全部改写为针对新控件(触发按钮 + 弹出面板)。
- L253/460/1231/1291 等 "开始一个新对话" 断言改为问候语断言
  (h2 存在且文本属于问候语池)。
- 新增 `greetings.test.ts`:分桶边界 + 池内取值。
- 新增/扩展组件级交互测试:打开面板、选择应用、Esc/外点关闭、错误重试。

## 风险

- 弹出卡片在移动端窄屏下的定位(右对齐 + max-width 限制)。
- iOS 安全区:面板在 composer-card 内向上弹出,不受底部 inset 影响。
- 删除 DraftModelSelector 后 lint/未使用引用清理。
