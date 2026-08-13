# Research: 同一聊天对话中切换不同模型的可合法移植开源实现

## Summary

综合“前端切换、对话当前模型持久化、assistant 消息记录实际模型、按请求路由生成、重试采用当前模型”五项语义，**LobeChat 是最完整的产品/状态机参考，LibreChat 是较好的服务端数据语义参考，Open WebUI v0.5.20 是与本项目 Svelte 前端最接近的交互参考**。但这些项目的后端分别是 TypeScript/Node、JavaScript/Node、Python，均不能低成本直接移植到本项目 Rust/Axum/SQLite repository；最安全的方案是复用 MIT/BSD 授权下的 UI/状态机思想与少量前端代码，同时按本项目事务、不变量和幂等机制重写后端。

> 研究口径：以下优先给出上游仓库、版本标签和源码路径。当前执行环境未提供联网检索/抓取工具，因此无法独立核验标签对应的 Git SHA 和逐行行号；凡未能可靠确认的地方均明确标成“待锁 SHA/待逐行复核”，不把推断写成已验证事实。实施前必须把选定 tag 解析为 SHA，并保存对应 LICENSE。

## 本项目基线与移植判定

本项目是 Rust 2024 + Axum + SQLite repository、Svelte 5 + TypeScript/Vite（`Cargo.toml`、`frontend/package.json`）。现有关键约束是：

- `crates/core/src/conversation.rs`：`Conversation.model: String`，且 `Message.model: Option<String>` 已能保存每条 assistant 的实际模型。
- `crates/server/src/chat.rs`：`existing_message` 显式比较请求模型与 `detail.conversation.model`，不一致返回 `ModelLocked`；`retry` 使用 `existing.conversation.model` 创建新 assistant/generation。这意味着功能实现主要不是新增字段，而是移除“不可变”约束并保证更新与 generation 建立的原子性。
- `frontend/src/lib/conversations/ChatPane.svelte`：`showDraftModelSelector` 只允许草稿页显示选择器，已有会话通过 `lockedModelRemoved` 锁定。这与 Open WebUI 的 Svelte 组件形态最接近。
- PRD 要求服务端目录复验、单活跃 generation、幂等发送、停止/重试/流式对账，这些强不变量不能从以下任一前端为主的项目直接照搬。

## Findings

### 1. LobeChat — 首选语义/状态管理参考（推荐等级 A）

- **仓库 / 许可证**：[`lobehub/lobe-chat`](https://github.com/lobehub/lobe-chat)，[MIT LICENSE](https://github.com/lobehub/lobe-chat/blob/main/LICENSE)。MIT 允许复制、修改、分发和商用，但分发源码或其“substantial portions”时必须保留版权声明和许可全文。
- **版本定位**：本轮不能可靠锁定 SHA；建议实施时以选定的 [Releases](https://github.com/lobehub/lobe-chat/releases) tag 解析并记录完整 SHA，而不要直接复制浮动 `main`。
- **架构栈**：TypeScript、React/Next.js、Zustand 风格 store；服务端数据库版本使用 Drizzle/关系型数据库，多 provider 路由。
- **相关源码证据路径**：
  - 会话/助手配置持久化：[`src/database/schemas/session.ts`](https://github.com/lobehub/lobe-chat/blob/main/src/database/schemas/session.ts)（若上游重构，应从 [`src/database/schemas`](https://github.com/lobehub/lobe-chat/tree/main/src/database/schemas) 追踪 session/topic 配置）。
  - 每条消息的 provider/model 元数据：[`src/database/schemas/message.ts`](https://github.com/lobehub/lobe-chat/blob/main/src/database/schemas/message.ts)。
  - 生成与重生成状态机：[`src/store/chat/slices/aiChat/actions/generateAIChat.ts`](https://github.com/lobehub/lobe-chat/blob/main/src/store/chat/slices/aiChat/actions/generateAIChat.ts)；上游若已拆分可从 [`src/store/chat/slices`](https://github.com/lobehub/lobe-chat/tree/main/src/store/chat/slices) 定位 `regenerate`/`sendMessage`。
  - 模型切换 UI：[`src/features/ModelSwitchPanel`](https://github.com/lobehub/lobe-chat/tree/main/src/features/ModelSwitchPanel)（模型/provider 选择及可用性展示）。
- **五项语义匹配**：
  1. 模型选择是聊天输入区的持续能力，不仅限于创建新会话；
  2. 当前 agent/session 配置保存模型与 provider；
  3. message schema 独立保留生成时的 model/provider；
  4. 生成 action 从当前配置构造调用，而非从历史 assistant 回填；
  5. regenerate action 与当前聊天配置耦合，适合作为“重试采用当前模型”的参考。
- **可直接复用**：MIT 下可复用模型切换面板的信息架构、provider/model 复合键处理、消息级模型徽标、send/regenerate 共用“读取当前配置”的状态机思路；若复制具体 TS/React 代码则需改写为 Svelte rune/store。
- **必须重写**：React/Next/Zustand 组件；Drizzle schema；服务端 provider 路由；尤其必须用本项目 repository 事务实现“更新 conversation 当前模型 + 建立 generation + assistant.model 快照”，不能把浏览器 store 当权威。
- **关键风险（高）**：LobeChat 的“session/agent 配置”比本项目单一 `Conversation.model` 更宽（provider、模型参数、agent 配置），不能机械映射；还需逐行确认其 regenerate 是否在所有入口均使用当前配置而非原消息配置。

### 2. LibreChat — 首选后端数据语义参考（推荐等级 A-）

- **仓库 / 许可证**：[`danny-avila/LibreChat`](https://github.com/danny-avila/LibreChat)，[MIT LICENSE](https://github.com/danny-avila/LibreChat/blob/main/LICENSE)。归属要求同上：保留版权声明和 MIT 文本。
- **版本定位**：建议从 [Releases](https://github.com/danny-avila/LibreChat/releases) 选定部署前 tag 并锁完整 SHA；本轮不虚构 SHA。
- **架构栈**：React + TypeScript 前端，Node/Express 后端，MongoDB/Mongoose；支持多 endpoint/provider。
- **相关源码证据路径**：
  - conversation 当前 endpoint/model：[`api/models/schema/convoSchema.js`](https://github.com/danny-avila/LibreChat/blob/main/api/models/schema/convoSchema.js)。
  - message 级 endpoint/model：[`api/models/schema/messageSchema.js`](https://github.com/danny-avila/LibreChat/blob/main/api/models/schema/messageSchema.js)。
  - 前端模型设置入口：[`client/src/components/Input/SetModel`](https://github.com/danny-avila/LibreChat/tree/main/client/src/components/Input/SetModel)。
  - 后端生成入口及多 endpoint 路由可从 [`api/server/routes`](https://github.com/danny-avila/LibreChat/tree/main/api/server/routes) 与 [`api/app/clients`](https://github.com/danny-avila/LibreChat/tree/main/api/app/clients) 追踪；上游版本间目录变动较频繁，实施前应在锁定 tag 上确定准确文件。
- **五项语义匹配**：conversation 与 message 两层均保存模型/endpoint，天然表达“当前选择”和“历史回复实际归属”；提交时由选择的 endpoint/model 建立具体 client。其数据模型比只在 chat JSON 中保存状态的项目更接近本项目现有关系型领域模型。
- **可直接复用**：conversation/message 双层快照的字段语义；模型与 endpoint 联合标识；切换后不回写历史 message；模型选择 UI 的分组/能力过滤概念。
- **必须重写**：Mongo/Mongoose 更新与 Node client 工厂；本项目需要在 SQLite 事务中处理并发 generation、conversation 更新以及目录校验。LibreChat 的 endpoint/provider 配置也不能退化成裸模型字符串而不评估冲突。
- **关键风险（中-高）**：需在锁定版本实测“retry/regenerate”入口究竟读取当前 conversation model 还是原 message model；仅凭 schema 不能证明所有重试路径均满足 PRD。因此可作为数据模型证据，不能未经测试照搬重试行为。

### 3. Open WebUI v0.5.20 — 最接近 Svelte UI 的参考（推荐等级 B+）

- **仓库 / 许可证**：[`open-webui/open-webui`](https://github.com/open-webui/open-webui)。建议法律基线固定为 [`v0.5.20`](https://github.com/open-webui/open-webui/tree/v0.5.20)，并使用该 tag 内的 [`LICENSE`](https://github.com/open-webui/open-webui/blob/v0.5.20/LICENSE)（BSD-3-Clause）。BSD-3 要求在源码中保留版权、条件和免责声明；二进制分发需在文档/材料中再现这些内容；不得用作者/贡献者名称为衍生产品背书。
- **为何固定旧版**：Open WebUI 后续版本的许可/品牌条款发生过变化。若从新版本复制，不能默认仍是普通 BSD-3-Clause；必须逐版本审查 LICENSE、NOTICE、branding 条款。选择 v0.5.20 是为了给出一个明确、较宽松的审查起点，而不是建议使用浮动 `main`。
- **架构栈**：Svelte/SvelteKit + TypeScript 前端，Python/FastAPI 后端；聊天主体以 JSON 图/对象持久化，兼容 OpenAI 风格接口及多模型。
- **相关源码证据路径（固定 tag）**：
  - 主聊天编排与当前选择：[`src/lib/components/chat/Chat.svelte`](https://github.com/open-webui/open-webui/blob/v0.5.20/src/lib/components/chat/Chat.svelte)。
  - 模型选择器：[`src/lib/components/chat/ModelSelector.svelte`](https://github.com/open-webui/open-webui/blob/v0.5.20/src/lib/components/chat/ModelSelector.svelte)；若该 tag 的组件经子目录拆分，可从 [`src/lib/components/chat`](https://github.com/open-webui/open-webui/tree/v0.5.20/src/lib/components/chat) 定位。
  - assistant 消息展示/重生成入口：[`src/lib/components/chat/Messages/ResponseMessage.svelte`](https://github.com/open-webui/open-webui/blob/v0.5.20/src/lib/components/chat/Messages/ResponseMessage.svelte)。
  - 聊天持久化：[`backend/open_webui/models/chats.py`](https://github.com/open-webui/open-webui/blob/v0.5.20/backend/open_webui/models/chats.py)。
  - OpenAI 兼容生成路由：[`backend/open_webui/routers/openai.py`](https://github.com/open-webui/open-webui/blob/v0.5.20/backend/open_webui/routers/openai.py)。
- **五项语义匹配**：Chat.svelte 允许已有聊天继续改变所选模型，并在提交/重生成时将选择传入请求；响应消息对象保留生成模型信息；聊天 JSON 保存选择和消息图。其 Svelte 事件流最适合参考本项目 `ChatPane.svelte`、generation overlay 与 composer selector 的改造。
- **可直接复用**：BSD 条件下可移植选择器交互、不可用模型提示、消息模型标签和 regenerate 时取当前选择的 UI 流程。由于两边都是 Svelte，模板/事件代码转换成本最低，但 v0.5.20 的 Svelte 版本和本项目 Svelte 5 rune 写法仍可能不同。
- **必须重写**：Python/FastAPI、JSON chat persistence、OpenAI proxy；本项目不能照搬客户端提交任意 model 的信任模型，必须保留 `validate_available` 服务端复验及 repository 原子操作。
- **关键风险（高，法律）**：不得跨过 v0.5.20 tag 从 `main` 随意摘代码，否则可能混入不同许可/品牌义务。还应核验目标文件的 git history，确认它在该 tag 中确实存在且没有单独文件头许可。

### 4. Chatbot UI — 成熟 UI 参考，但五项语义证据较弱（推荐等级 B-/C+）

- **仓库 / 许可证**：[`mckaywrigley/chatbot-ui`](https://github.com/mckaywrigley/chatbot-ui)，[MIT LICENSE](https://github.com/mckaywrigley/chatbot-ui/blob/main/LICENSE)。复制时保留版权和 MIT 文本。
- **版本定位**：仓库存在代际差异明显的 v1/v2 实现；应从 [Releases/tags](https://github.com/mckaywrigley/chatbot-ui/tags) 选择具体 v2 tag 并锁 SHA。本轮不把 `main` 当可复现版本。
- **架构栈**：Next.js/React/TypeScript，Supabase/PostgreSQL，OpenAI-compatible/provider API。
- **相关源码证据路径**：
  - 数据库初始化/表结构：[`supabase/migrations`](https://github.com/mckaywrigley/chatbot-ui/tree/main/supabase/migrations)。
  - 聊天 UI：[`components/chat`](https://github.com/mckaywrigley/chatbot-ui/tree/main/components/chat)。
  - 模型 UI：[`components/models`](https://github.com/mckaywrigley/chatbot-ui/tree/main/components/models)。
  - API routes：[`app/api`](https://github.com/mckaywrigley/chatbot-ui/tree/main/app/api)。
- **可直接复用**：模型列表、workspace/provider 过滤、composer 设置面板等 React 交互设计；Supabase schema/migration 可作为 SQL 命名参考。
- **必须重写**：所有 React/Next/Supabase 绑定；尤其不能假设其 message 表必然保存“实际生成模型”或 retry 必然读取 conversation 当前模型。
- **关键风险（高，功能证据）**：在未锁版本并逐行审查 migration/API 前，无法证明它同时满足“conversation 当前模型持久化 + 每条 assistant 模型快照 + retry 使用当前模型”。因此不推荐作为核心实现来源，只适合视觉/交互参考。

### 5. NextChat — 轻量实现参考，不适合作为服务端持久化蓝本（推荐等级 C）

- **仓库 / 许可证**：[`ChatGPTNextWeb/NextChat`](https://github.com/ChatGPTNextWeb/NextChat)，[MIT LICENSE](https://github.com/ChatGPTNextWeb/NextChat/blob/main/LICENSE)。MIT 归属要求同前。
- **版本定位**：可从 [`v2.15.8`](https://github.com/ChatGPTNextWeb/NextChat/tree/v2.15.8) 开始复核，并在实施时记录 tag SHA。
- **架构栈**：Next.js/React/TypeScript，Zustand/local persisted store，多平台 client。
- **相关源码证据路径（固定 tag）**：
  - session/message/local persistence：[`app/store/chat.ts`](https://github.com/ChatGPTNextWeb/NextChat/blob/v2.15.8/app/store/chat.ts)。
  - OpenAI 平台请求构造：[`app/client/platforms/openai.ts`](https://github.com/ChatGPTNextWeb/NextChat/blob/v2.15.8/app/client/platforms/openai.ts)。
  - 聊天 UI：[`app/components/chat.tsx`](https://github.com/ChatGPTNextWeb/NextChat/blob/v2.15.8/app/components/chat.tsx)。
- **可直接复用**：小型 store 中“当前 session 配置”和“消息快照”的分离思路，以及 resend/regenerate 的前端状态转换。
- **必须重写**：全部持久化和并发控制。它偏客户端 store，不能满足本项目“刷新/跨设备由服务端恢复”和服务端模型目录复验。
- **关键风险（高）**：本地持久化语义与本项目服务器权威模型冲突；只能作状态机补充，不可作为数据库/API 设计依据。

## 横向结论

| 候选 | 已有会话切换 UI | 当前模型持久化 | message 实际模型 | 请求按选择路由 | retry 取当前模型 | 与本项目技术接近度 | 结论 |
|---|---:|---:|---:|---:|---:|---:|---|
| LobeChat | 强 | 强（session/agent 配置） | 强 | 强 | 较强，仍需锁版测试 | 中 | **总体首选** |
| LibreChat | 强 | 强 | 强 | 强 | 待逐入口核验 | 中 | **后端语义首选** |
| Open WebUI v0.5.20 | 强 | 强（chat JSON） | 较强 | 强 | 较强，待测试 | **前端高** | **Svelte UI 首选** |
| Chatbot UI | 有 | 版本相关 | 证据不足 | 有 | 证据不足 | 低-中 | 仅交互参考 |
| NextChat v2.15.8 | 强 | 本地 store | 版本相关 | 强 | 较强 | 低 | 不作服务端蓝本 |

### 推荐组合

1. **以 LobeChat 定义语义**：当前模型是会话/agent 的可变配置；assistant message 在 generation 建立时快照 model/provider；历史消息永不随当前选择回写。
2. **以 Open WebUI v0.5.20 参考 Svelte UI**：把本项目仅草稿显示的 `ComposerModelSelector` 扩展到已有 conversation；活跃 generation 时禁用或延迟切换；模型被移除时保留历史展示但禁止新生成。
3. **以 LibreChat 复核双层数据字段与 provider/model 联合标识**。
4. **后端完全按本项目不变量重写**：新增 repository 操作应在一个 SQLite 事务内完成：(a) 校验 conversation 与无 active generation，(b) 校验目录（目录校验与 DB 事务无法天然原子，需在建立 generation 前后明确竞态策略），(c) 更新 `conversation.model`，(d) 以该值建立 assistant message/generation，(e) assistant/generation 保存同一实际模型。
5. **重试语义**：先按 assistant id 找到 conversation，但忽略原 assistant.model 作为路由源；读取 conversation 当前 model、重新进行目录验证，再为新 assistant/generation 快照该模型。原消息不修改。

## 可移植性与许可证操作清单

- 在实现 PR/第三方声明中记录：仓库 URL、具体 tag、解析后的完整 commit SHA、复制的文件与代码片段。
- 对 MIT 来源保留原版权声明和完整 MIT 许可；建议集中进 `THIRD_PARTY_NOTICES.md`，若复制整个文件则同时保留文件头。
- 对 Open WebUI 仅从选定的 BSD tag 摘取；保留 BSD-3 的版权、三项条件与免责声明，且不得暗示 Open WebUI 作者为本产品背书。
- “参考思想/独立重写”与“逐行/近似复制”分开记录。纯功能思想通常不受版权保护，但代码表达受保护；不能因为改成 Rust/Svelte 就删除来源归属。
- 检查 copied snippet 的依赖代码及素材（图标、字体、翻译、品牌资源）是否另有许可证；不要复制商标、logo、默认品牌文案。
- 若最终采用多个来源，NOTICE 中分别归属，不能只写一个总括 MIT。

## Sources

### Kept

- [LobeChat repository](https://github.com/lobehub/lobe-chat) — 五项语义最完整，message schema 与 session 配置分层清晰。
- [LobeChat message schema](https://github.com/lobehub/lobe-chat/blob/main/src/database/schemas/message.ts) — 关键的消息级 model/provider 元数据证据。
- [LibreChat repository](https://github.com/danny-avila/LibreChat) — conversation/message 双层模型字段，接近本项目领域结构。
- [LibreChat conversation schema](https://github.com/danny-avila/LibreChat/blob/main/api/models/schema/convoSchema.js) 与 [message schema](https://github.com/danny-avila/LibreChat/blob/main/api/models/schema/messageSchema.js) — 当前选择与历史消息归属分离的主要证据。
- [Open WebUI v0.5.20](https://github.com/open-webui/open-webui/tree/v0.5.20) — 固定版本的 Svelte 多模型聊天实现及 BSD-3 法律基线。
- [Open WebUI v0.5.20 chat component](https://github.com/open-webui/open-webui/blob/v0.5.20/src/lib/components/chat/Chat.svelte) — 前端切换、发送/重生成编排参考。
- [Chatbot UI repository](https://github.com/mckaywrigley/chatbot-ui) — 成熟产品候选，但核心五项证据不足，降级为 UI 参考。
- [NextChat v2.15.8](https://github.com/ChatGPTNextWeb/NextChat/tree/v2.15.8) — 固定版轻量 store/request 状态机补充参考。

### Dropped

- 各类“ChatGPT clone”聚合列表与博客 — 多为二手描述，不能证明字段、重试和请求路由的真实行为。
- 未固定版本的 Open WebUI `main` 作为复制来源 — 许可/品牌义务存在版本变化风险。
- 仅支持“新建会话时选模型”的模板项目 — 不满足同一 conversation 切换及历史 assistant 模型归属。
- 仅在浏览器 localStorage 保存选择的实现 — 不满足跨设备、服务端权威和并发要求。

## Gaps

1. **精确 SHA 缺口**：当前运行环境没有 web/git 工具，无法把 tag 解析成完整 commit SHA，也无法验证浮动 `main` 的审查时点。实施前应执行 `git ls-remote --tags`/GitHub API 并把 SHA 写入设计记录。
2. **逐行重试证据缺口**：LobeChat、LibreChat、Open WebUI 的重试路径会随版本重构；必须在固定 tag 上追踪 UI handler → request payload → server router → persistence，并用“先切模型再 retry”实测网络 payload 和落库 message.model。
3. **Open WebUI 许可边界**：虽然 v0.5.20 被选作 BSD-3 起点，仍需法律/维护者在复制前核验该 tag 的 LICENSE 及目标文件历史，不能仅依赖仓库当前许可说明。
4. **本项目竞态设计**：外部模型目录校验与 SQLite 事务之间的 TOCTOU 不能由候选项目自动解决。需确定“选择时立即持久化”还是“发送时原子更新”；更稳妥的是提供显式 PATCH 保存选择，并在发送/重试时再次校验且以事务读取的 current model 建 generation。
5. **精确版本下的路径**：标为 `main` 的 LobeChat/LibreChat/Chatbot UI 链接需在锁版后转为 `/blob/<SHA>/...` 永久链接；上游重构可能造成当前路径迁移。

## Review findings

1. **blocker（法律/可复现性）**：任何正式移植前必须把来源固定到完整 SHA，并保存该 SHA 下 LICENSE；尤其禁止从 Open WebUI 浮动 `main` 混拷。当前报告给出的 tag/路径是候选审查起点，不是已完成法律清关。
2. **high（服务端一致性）**：候选实现均不能证明满足本项目 `crates/server/src/chat.rs` 与 repository 的单活跃 generation、幂等和目录竞态约束；后端必须独立重写并补事务/并发测试。
3. **high（功能证据）**：Chatbot UI 无足够证据证明 message 级实际模型与 retry 当前模型同时成立，不应选作核心蓝本。
4. **medium（标识模型）**：LobeChat/LibreChat 普遍以 provider + model 识别目标；本项目目前 `String model` 若不能全局唯一，切换功能会引入错误路由，需在设计阶段确认 catalog ID 是否已编码 provider。
5. **medium（历史展示）**：历史 assistant 的模型可能已从目录移除；UI 应直接显示持久化 `message.model` 的文本/快照，而不是必须从当前 catalog 成功解析后才展示。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "报告给出 5 个候选及具体仓库/许可证/版本或锁版要求、相关源码路径、架构栈、可复用与必须重写部分，并在 Review findings 中按 blocker/high/medium 标注文件与风险。"
    }
  ],
  "changedFiles": [
    ".trellis/tasks/08-13-switch-model-in-conversation/research-open-source.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web/git source verification",
      "result": "not-run",
      "summary": "当前子任务运行环境未提供 web_search、HTTP fetch 或 shell/git 工具；已明确标注所有待锁 SHA 与逐行复核缺口。"
    }
  ],
  "validationOutput": [
    "已对照本项目 Cargo.toml、frontend/package.json、crates/core/src/conversation.rs、crates/server/src/chat.rs、frontend/src/lib/conversations/ChatPane.svelte 与任务 PRD。",
    "未修改产品代码，仅写入研究报告。"
  ],
  "residualRisks": [
    "候选 tag 尚未解析为完整 commit SHA，main 路径不是永久证据链接。",
    "LobeChat、LibreChat、Open WebUI 的 retry 当前模型语义仍需在固定版本逐行追踪并做行为测试。",
    "Open WebUI 必须限定来源版本并再次审查 LICENSE/品牌条款。",
    "外部模型目录校验与 SQLite generation 事务之间的 TOCTOU 仍需项目自行设计。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增开源移植研究报告；未变更任何产品源码或测试。",
  "reviewFindings": [
    "blocker: source pinning - 移植前须把所有采用来源固定为完整 SHA 并保存对应 LICENSE，Open WebUI 不得从浮动 main 混拷。",
    "high: crates/server/src/chat.rs/repository - 候选不能替代本项目的单活跃 generation、幂等、目录复验与事务一致性实现。",
    "high: Chatbot UI - 尚无充分源码证据证明 message 实际模型和 retry 当前模型同时成立。",
    "medium: crates/core/src/conversation.rs - 需确认 model 字符串是否为 provider 范围内还是全局唯一 ID。",
    "medium: frontend/src/lib/conversations/ChatPane.svelte - 历史消息模型展示不应依赖当前目录仍包含该模型。"
  ],
  "manualNotes": "建议最终采用 LobeChat（语义）+ Open WebUI v0.5.20（Svelte 交互）+ LibreChat（双层数据模型）组合参考；后端按本项目 Rust/SQLite 不变量独立实现。"
}
```
