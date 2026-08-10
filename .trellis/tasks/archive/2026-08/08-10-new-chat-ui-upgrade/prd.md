# 新建对话页 UI 升级

## Goal

精简新建对话(空草稿)页面:删除说明性文案,把模型选择从页面中央卡片下沉到输入框内(发送按钮左侧,点击向上弹出选择卡片),并用按时间段变化的随机问候语替代固定标题"开始一个新对话"。

## Background(代码证据)

- 空草稿页 `frontend/src/lib/conversations/EmptyConversation.svelte`:
  L16 `<h2>开始一个新对话</h2>`、L17 "从左侧选择历史对话..."、
  L19 `.composer-note` "在下方输入第一条消息后...",并渲染 `DraftModelSelector`。
- 模型卡片 `frontend/src/lib/models/DraftModelSelector.svelte`:含刷新按钮、
  模型下拉框、"默认模型:... 锁定"提示(L panel-hint)、"更新于..."(L panel-meta),
  以及加载/错误/配置错误/stale 状态 UI。
- 输入框 `frontend/src/lib/conversations/Composer.svelte`:行内结构为
  `+` 附件按钮 → textarea → 发送/停止圆按钮;草稿与已有对话共用。
- `frontend/src/lib/models/model-store.svelte.ts` 提供 `draftModelId`、
  `selectDraftModel(id)`(目录校验 + localStorage 持久化)、`refresh(csrfToken)`、
  `status`/`stale`/`isConfigurationError` 等,本次无 API 变更。
- `ChatPane.svelte` 的 `composerDisabled` 已处理草稿无可用模型的发送门控。
- spec `component-guidelines.md`:模型选择仅在首条消息前可交互;
  已有对话显示不可编辑模型标签(现为头部 locked-model)。

## Requirements

- R1 删除文案:EmptyConversation 的 "从左侧选择历史对话继续查看,或为下方的新对话选择一个模型。" 与 "在下方输入第一条消息后,对话将创建并锁定所选模型。";DraftModelSelector 的 "默认模型:...。发送第一条消息后模型将锁定,无法更改。" 与 "更新于 ..."。
- R2 整体移除中央"选择模型"卡片(DraftModelSelector 组件删除),
  模型选择唯一入口改为输入框内控件。
- R3 Composer 发送按钮左侧新增模型选择控件:默认显示当前草稿模型 label;
  点击在控件上方弹出选择卡片;点选后立即应用(`selectDraftModel`)并关闭。
- R4 弹出卡片承接原卡片状态职责:加载中、加载失败(含配置错误变体)+ 重试、
  stale 缓存提示、刷新按钮与刷新成功提示;不显示"更新于"时间戳。
- R5 控件仅出现在新建草稿视图(`detailStatus === "idle"` 且非流式);
  已有对话不显示(头部已有 locked-model 标签)。
- R6 h2 标题替换为随机问候语:按用户本地时间分桶(凌晨 0–5 / 早上 5–11 /
  中午 11–14 / 下午 14–18 / 晚上 18–24),每桶一个预选问候语池,
  每次进入草稿视图随机取一条,同一视图内保持不变。
- R7 弹出卡片支持 Esc 与点击外部关闭,关闭后焦点回到触发按钮。

## Acceptance Criteria

- AC-01(R1/R2)空草稿页不再出现被删的四段文案,也不再渲染中央模型卡片;
  仓库中无 DraftModelSelector 残留引用。
- AC-02(R3)草稿视图输入框发送按钮左侧显示当前草稿模型;点击弹出上方卡片;
  选择模型后 `draftModelId` 更新、localStorage 持久化、卡片关闭。
- AC-03(R4)目录加载中/失败/配置错误/stale 各状态在弹出卡片内可见,
  失败时有重试入口;ready 时卡片内有刷新按钮。
- AC-04(R5)打开已有对话时输入框内不出现模型控件。
- AC-05(R6)标题为问候语且属于当前时间段对应的池;同一视图内不变化。
- AC-06(R7)Esc 与外点可关闭卡片,焦点回到触发按钮。
- AC-07 `npm run check`、eslint、`npm test` 全部通过;AppShell 测试断言已同步。

## Key Decisions

- D1(Q1 用户确认)中央模型卡片整体移除,加载/错误/刷新等状态收进输入框上方的弹出卡片。
- D2 控件仅草稿视图渲染;已有对话沿用头部 locked-model 标签,输入框不重复显示。
- D3 Composer 通过可选 snippet 属性注入控件,保持 Composer 领域无关。
- D4 问候语时间段边界:凌晨 0–5、早上 5–11、中午 11–14、下午 14–18、晚上 18–24;
  组件初始化时取一次,不响应式重算,避免闪烁。

## Out of Scope

- 后端 API 与模型目录契约变更
- 已有对话的模型锁定/解锁逻辑
- 附件上传(仍为展示占位)

## Risks / Deferred

- "Awwwards 水准"为主观品质目标，验收以 AC-09 的可观察项为准。
- 移动端窄屏下弹出卡片定位需人工目测（760px 断点）。
- spec `component-guidelines.md` 组件树中 DraftModelSelector 描述需同步更新。
- AppShell.test.ts 约 260 行旧选择器用例需改写为新控件交互。

## Artifacts

- `prd.md`(本文件)、`design.md`(组件契约与状态映射)、`implement.md`(实施清单与验证命令)
