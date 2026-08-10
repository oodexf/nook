# 实施清单

0. 新增 `frontend/src/lib/components/ChevronsUpDownIcon.svelte`(Lucide 路径内联组件)
1. 新增 `frontend/src/lib/conversations/greetings.ts`(时间段分桶 + 问候语池 + `pickGreeting`;问候语文案不含表情符号)
2. 新增 `frontend/src/lib/models/ComposerModelSelector.svelte`(触发按钮 + 向上弹出卡片,含刷新/错误/stale/列表/外点与 Esc 关闭)
3. 修改 `frontend/src/lib/conversations/Composer.svelte`:新增可选 snippet 属性,渲染在发送/停止按钮左侧
4. 修改 `frontend/src/lib/conversations/ChatPane.svelte`:草稿视图且非流式时注入 ComposerModelSelector
5. 修改 `frontend/src/lib/conversations/EmptyConversation.svelte`:h2 换为问候语,删除两段说明文案与 DraftModelSelector
6. 删除 `frontend/src/lib/models/DraftModelSelector.svelte`
7. 更新 `AppShell.test.ts`(选择器用例改写、标题断言改写),新增 `greetings.test.ts` 与控件交互用例
8. 更新 `.trellis/spec/frontend/component-guidelines.md` 组件树描述

## 验证命令

```bash
cd frontend
npm run check        # svelte-check
npx eslint src
npm test             # vitest
```

## 风险点 / 回滚

- AppShell.test.ts 选择器相关约 260 行用例改写量大,逐一对应新交互。
- 弹出层定位在窄屏需人工目测(760px 断点)。
- 回滚:`git checkout` 本任务触及的 8 个文件即可,无后端/数据变更。
