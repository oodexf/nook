# 侧边栏改版:导航入口与历史会话行内操作

## Goal

按用户提供的 ChatGPT 截图风格改版侧边栏(`frontend/src/lib/conversations/Sidebar.svelte`),纯前端 UI 改动,不改后端契约。

## 需求

### R1 导航入口区(图1)

- 顶部:品牌文字保留,右侧依次放 搜索图标按钮(占位,点击不生效或仅显示占位输入) 和 收起侧边栏按钮(沿用现有 `onCollapse`;移动端抽屉沿用 `onClose`)。
- 入口列表改为图片样式(图标 + 文字的行项,行高与选中态对齐列表行),先只做两项:
  - **新建对话**(编辑/铅笔方形图标)— 沿用现有 `onNew` 行为。
  - **项目**(文件夹图标)— 占位项,点击不生效(后续实现)。
- 移除原实心"新对话"大按钮;设置、退出登录入口保持现状(顶栏齿轮 / 底部图标)。

### R2 历史会话列表(图2)

- 分区标题:列表上方显示 "Recents" 小标题(置顶项存在时显示 "Pinned" 分组在上)。
- 每行右侧操作:
  - **置顶图标按钮**(占位):仅 UI 状态切换(组件内 `$state` 存储 pinned id 集合,不持久化、不调后端);置顶后行归入 Pinned 分组并显示实心/高亮 pin 图标。
  - **三点图标按钮**:点击展开弹出菜单(占位全集,对齐截图):Share、Rename、Pin chat、Archive、Delete、Move to project。
    - Rename:沿用现有内联重命名(`startEditing`)。
    - Pin chat:同置顶占位行为。
    - Delete:沿用现有删除路径(若现有 Sidebar 无删除入口,则先占位或接入 store.remove;以现有行为为准)。
    - Share / Archive / Move to project:占位项,点击仅关闭菜单。
- 菜单需:点击外部/Escape 关闭、同一时刻只开一个、键盘可达(按钮有 aria-label,菜单项为 button)、Delete 用 danger 色。

### 约束

- 遵循 `.trellis/spec/frontend/`:颜色全部走 CSS 变量(深浅色主题)、图标用内联 SVG 组件、icon-only 按钮必须有 aria-label、触控目标 ≥44px(`--compact-action-size` 行内按钮沿用现有粗指针扩大方案)。
- 不改 `crates/`、不改 API 类型;置顶是组件内本地状态,刷新即失(占位语义)。
- 新图标组件放 `frontend/src/lib/components/`,命名沿用 `XxxIcon.svelte`。

## 验收标准

- [ ] 侧边栏顶部为 品牌 + 搜索占位按钮 + 收起按钮;下方为"新建对话""项目"两个入口行项,样式对齐图1。
- [ ] 历史会话列表显示 Recents 标题;每行 hover/聚焦可见 pin 与三点按钮;点击三点展开含 6 项的菜单,Share/Archive/Move 为占位;Rename 与 Delete 沿用现有行为;Pin 切换组件内本地状态并分组显示。
- [ ] 菜单点击外部、Escape 可关闭,无嵌套交互元素,icon-only 按钮均有 aria-label。
- [ ] `npm run lint`、`npm run check`(或项目对应命令)与相关测试通过。
