# 执行计划:对话侧边栏 UI 升级

## 顺序

按"数据层 → token → 组件 → 测试 → 实测"推进。前两步是纯增量,不会让中间状态编译失败;第 3 步是唯一的大改动。

### 1. 时间分档纯函数

- `frontend/src/lib/conversations/conversation-store.svelte.ts`
  - 删除 `ConversationGroups` 与 `groupConversations`。
  - 新增 `ConversationSection` 类型与 `buildSidebarSections(conversations, now)`,规则见 design.md §3。
  - 边界用 `new Date(y, m, d - n).getTime()` 构造,不做毫秒减法。
  - 档内不排序,保持传入顺序。
- `frontend/src/lib/conversations/conversation-store.test.ts:398`
  - 替换 `groupConversations` 用例,新增:五档各自命中、档边界(恰好在 00:00 两侧)、空档不返回、置顶优先且不参与分档、档内顺序保持、`updatedAt > now` 归入 `today`。

验证:`cd frontend && npm run test -- conversation-store`

### 2. token

- `frontend/src/styles/global.css`
  - `:root` 加 `--accent-soft: rgb(29 78 216 / 0.08);`
  - `:root[data-theme="dark"]` 加 `--accent-soft: rgb(96 165 250 / 0.16);`
  - 放在各自调色板的 Feedback 段内,紧跟 `--accent-contrast`。

### 3. 侧边栏组件(主体)

`frontend/src/lib/conversations/Sidebar.svelte`

模板:

- 顶部:移除搜索按钮与设置按钮,只留品牌与 `onCollapse`/`onClose` 控件。
- 导航区:在「新建对话」与「项目」之间插入搜索行,`class="nav-entry"`、`disabled`、`aria-label="搜索(即将上线)"`、`title="搜索(即将上线)"`、`SearchIcon size={20}`(aria-label 必须逐字保持,`AppShell.test.ts:1226` 依赖它)。
- 列表:`sections` 改为 `$derived(buildSidebarSections(store.items, Date.now()))`;`{#each sections as section (section.key)}` 用 `key` 而非 `label` 作键;去掉 `{#if section.items.length > 0}`(空档已不返回)。
- 行:删除 `<span class="item-model">`;把 pin 与 `···` 两个按钮包进 `<div class="row-actions">`。
- 底部:`.sidebar-footer` 内放设置按钮(`aria-label="设置"`,`SettingsIcon size={20}`)与现有退出按钮,退出按钮的 `class="icon-button sign-out"` 与 `aria-label` 保持不变。

样式(整段重写 `<style>`,规格见 design.md §5):

- `.row-actions` 绝对定位 + `opacity` 显隐,四种显现条件 + `(any-pointer: coarse)` 常驻。
- `.item-title` 在同样条件下加 `mask-image` / `-webkit-mask-image` 尾部渐隐。
- `.item-row-active` 去掉 `box-shadow`,改 `background: var(--accent-soft)`,标题 `--text-strong`/600。
- `.list-region` 加细滚动条。
- 不留任何硬编码颜色字面量。

### 4. 跟随更新 AppShell 测试

`frontend/src/lib/conversations/AppShell.test.ts`

- `summary()` fixture:`updated_at` 改为 `Date.now()` 派生(`created_at` 同步),使行稳定落入「今天」档。
- `:1179` 用例:改名为 `opens settings from the sidebar footer`,断言方向反转 —— 设置按钮在收起按钮**之后**(`DOCUMENT_POSITION_PRECEDING`),其余(打开对话框、切换主题、写 localStorage)不变。
- `:1326`:`最近` → `今天`。
- 其余用例不改。若有用例因 `.item-model` 消失而失败,说明它依赖了本次有意移除的信息,一并调整并在 PR 说明中列出。

### 5. 全量验证

```bash
cd frontend && npm run lint && npm run check && npm run test && npm run build
```

### 6. 浏览器实测(AC9 / AC3 / AC11 只能这样验)

用 preview 起 dev server,逐项确认:

- light / dark × 桌面静态列 / ≤760px 抽屉 四种组合。
- 行动作:idle 隐藏 → hover 显现 → Tab 聚焦显现 → 选中行常显 → 菜单展开常显;全程行高与标题起点不动。
- 长标题在动作显现时尾部渐隐,不被按钮压住。
- 侧边栏收起 / 展开动画、抽屉开合与焦点返回正常。
- DevTools 模拟 `prefers-reduced-motion: reduce`,确认无过渡残留。
- 触屏模拟(`any-pointer: coarse`)下动作常驻。

## 风险文件与回退点

| 文件 | 风险 | 回退 |
|---|---|---|
| `Sidebar.svelte` | 唯一大改动,模板与样式同时重写 | `git checkout -- frontend/src/lib/conversations/Sidebar.svelte` |
| `conversation-store.svelte.ts` | 导出签名变更,`Sidebar.svelte` 是唯一调用方 | 独立提交,可单独回滚 |
| `global.css` | 仅增两行 token,无副作用 | 独立提交 |
| `AppShell.test.ts` | 改的是**断言方向**,容易掩盖真回归 | 每处修改都要在 diff 里能对应到 design.md §6 的一行;对应不上的失败一律当回归处理 |

## start 前确认

- [ ] design.md §6 的四处测试变更已逐条对照,没有"顺手改绿"的额外断言
- [ ] `buildSidebarSections` 的 `now` 是参数而非内部 `Date.now()`
- [ ] 搜索行的 `aria-label` 逐字保持 `搜索(即将上线)`
- [ ] `.item-row` / `.item-row-active` / `.nav-entry` / `.section-label` / `.edit-form` / `#sidebar-rename-input` / `[data-row-menu-trigger]` / `button.sign-out[aria-label='退出登录']` 类名与标签全部保留
