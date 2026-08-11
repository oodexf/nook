# 聊天界面 UI 优化(uifix 分支)

## 背景

用户提出 5 项聊天界面 UI 改进,均在 `frontend/`(Svelte 5)内完成,不改后端契约。

## 需求

### R1 输入框改版(Composer.svelte)

- 改为截图样式:圆角胶囊容器(边框 + 浅色背景 + 轻阴影),单行时呈 pill,多行时为大圆角矩形。
- 左侧"+"图标按钮:点击打开本地文件选择器(`<input type="file" multiple>`);选中的文件仅以 chip 形式展示在输入区上方(文件名 + 移除 ×),**不随消息发送**(后端不支持附件,用户确认"仅选中展示,暂不发送");发送消息后清空已选文件。
- 右侧发送按钮改为圆形图标按钮(向上箭头),无可发送内容时禁用/淡化;streaming 时同位置变为圆形停止按钮(方块图标),保留 `stopping` 禁用态。
- 保留现有行为契约:Enter 发送 / Shift+Enter 换行 / IME 合成保护 / textarea 自动增高(上限 220px)/ 16px 字体防 iOS 缩放 / safe-area-inset-bottom。

### R2 修复:首轮 AI 回答后"重新生成"按钮不显示

- 现状:流结束后 generation overlay(`StreamingTurn`)一直挂载(`active` 未清除),持久化的助手消息被 `excludedMessageIds` 隐藏,而 overlay 没有重试按钮 → 重新生成按钮永不出现。
- 修复:`settle` 在 `onReconcile` 成功完成后,当持久化消息已存在(`assistantMessageId !== null`,completed/stopped/failed 中途失败均满足)时释放 stream(clear),让 `MessageList` 渲染权威消息并显示重试按钮;`assistantMessageId === null` 的流前失败保留 overlay 与错误展示(同时保持 ChatPane 发送失败恢复输入的逻辑);reconcile 失败时保留本地 overlay。

### R3 复制按钮反馈(copy-control.ts + global.css)

- 点击复制成功后图标变为绿色 ✓,1 秒后恢复(FEEDBACK_MS 1600 → 1000)。
- 失败态保持现有红色边框反馈。
- 消息级复制与代码块复制共享同一实现,行为一致。

### R4 代码块复制按钮(MarkdownContent.svelte)

- 代码内容顶格:移除 `pre` 为复制按钮预留的 `padding-top`。
- 复制按钮默认隐藏,鼠标悬停代码块或键盘聚焦(focus-within)时显示在右上角。

### R5 侧边栏(Sidebar.svelte / AppShell.svelte)

- "退出登录"改为图标按钮(logout 图标),位于侧边栏左下角,保留 `isSigningOut` 禁用态与 aria-label。
- 折叠侧边栏按钮左侧新增"设置"齿轮图标按钮(移动端抽屉中同样放在关闭按钮左侧)。
- 点击打开设置弹窗:主题选择(跟随系统 / 浅色 / 深色),持久化到 localStorage,通过 `<html data-theme>` 应用;新增深色 CSS 变量组。

## 验收标准

- [ ] 输入框呈胶囊样式,+ 可选本地文件并展示/移除 chip,发送后清空;圆形发送/停止按钮工作正常。
- [ ] 首轮及后续每轮回答完成后,最新助手消息显示"重新生成"按钮且可点击;流前失败仍展示错误并恢复输入。
- [ ] 任意复制按钮点击后显示绿色 ✓,约 1s 恢复;失败态不变。
- [ ] 代码块代码顶格,复制按钮仅悬停/聚焦时出现于右上角。
- [ ] 退出登录为左下角图标按钮;设置按钮在折叠按钮左侧,弹窗可切换并持久化主题,深色主题全站生效。
- [ ] `npm run check`、`npm run lint`、`npm run test` 全部通过(含受影响的存量测试更新)。
