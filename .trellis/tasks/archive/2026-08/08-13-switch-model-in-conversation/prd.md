# 支持同一对话切换模型

## Goal

允许用户在同一个对话中为后续回复切换可用模型，无需新建对话；后续模型继承原对话上下文，同时每条助手回复的实际模型保持可追溯。

## Background

- `Conversation.model` 当前是不可变模型；`crates/server/src/chat.rs` 拒绝已有对话提交不同模型。
- `crates/storage/migrations/0001_initial.sql` 通过触发器锁定已有消息对话的模型，`crates/storage/src/generation_repository.rs` 同时校验 generation 模型与 conversation 模型一致。
- `Message.model` 和 `Generation.model` 已保存每次助手生成的模型快照，用户消息的 model 为空。
- `frontend/src/lib/conversations/ChatPane.svelte` 仅在新对话草稿显示选择器，已有对话只显示锁定模型。
- 现行跨层规范明确“一条对话一个不可变模型”，实施时必须同步更新。

## Requirements

### Model selection and persistence

- 用户可在已有对话中从当前模型目录选择下一次生成使用的模型。
- 选择后立即通过服务端 API 按对话持久化，刷新页面与跨设备打开时恢复同一选择。
- `Conversation.model` 表示下一次生成的服务端权威当前模型；助手 `Message.model` 与 `Generation.model` 是生成时的不可变实际模型快照。
- 每次发送和重试均重新验证服务端当前模型仍在目录中，不能信任浏览器缓存或请求参数。
- 活跃 generation 期间前端禁用切换，服务端也必须拒绝绕过 UI 的模型更新。

### Conversation and retry behavior

- 切换后的模型继承该对话此前完整的用户/助手上下文，并继续遵守现有消息数与字符数裁剪规则。
- 重试历史助手回复时使用对话当前模型，而不是原回复模型；新回复记录当前模型，原历史回复不得修改。
- 切换不得破坏单对话单活跃 generation、幂等发送、停止、重试、SSE 顺序或流式对账。

### Removed models and migration

- 若保存的当前模型已下线，客户端按历史助手消息倒序选择最近仍可用的模型并立即保存。
- 若历史模型均不可用，则禁止发送并要求用户手动选择；不得静默回退到默认模型。
- 历史回复始终显示其持久化 model，即使该模型已不在当前目录。
- 旧数据库和单模型对话迁移后保留原 conversation model 作为初始当前选择，并保留所有历史消息/generation 模型。

### Open-source provenance

- 前端交互以 Open WebUI `v0.5.20`、commit `3b70cd64d7fa6902e8c79cf8dcbf3c7e84cf704b` 的 BSD-3-Clause 实现为主要移植基线。
- 可参考/移植的上游范围限于模型选择、发送/重试选择流和消息模型展示；Python/FastAPI、JSON chat persistence 与多模型并行逻辑不移植。
- 后端必须按本项目 Rust/Axum/SQLite 事务、安全与并发不变量独立实现。
- 直接复制或近似翻译代码前，必须记录精确上游文件/片段，并保留 BSD-3-Clause 要求的版权、条件与免责声明；不得复制品牌、logo 或暗示背书。

## Acceptance Criteria

- [ ] 已有对话能选择当前目录中的模型；选择无需发送消息即保存，刷新与跨设备打开后保持一致。
- [ ] 连续回复可由不同模型生成；每条助手回复、generation 与 SSE meta 的模型一致，刷新后历史归属不变。
- [ ] 新模型收到此前完整且按现有规则裁剪的跨模型上下文。
- [ ] 重试使用对话当前模型并生成新的模型快照，不改写被重试回复。
- [ ] 非法、目录外或发送前已下线的模型被服务端拒绝，且不创建错误 generation。
- [ ] 活跃 generation 期间 UI 不可切换模型，直接调用更新 API 也被拒绝，且不会产生第二个 generation。
- [ ] 当前模型下线时自动保存最近仍可用的历史助手模型；无可用历史模型时阻止发送并要求手动选择。
- [ ] 旧单模型数据库升级后可读取、发送、切换和重试，原 conversation/message/generation 模型数据无损。
- [ ] 存储、HTTP、聊天上下文、重试、SSE、前端 API/store/component/流式导航测试覆盖上述关键路径。
- [ ] 所有直接复制或近似移植代码可追溯到固定 SHA，并满足 BSD-3-Clause 的源码与分发归属要求。

## Out of Scope

- 同一条回复并行调用或对比多个模型。
- 根据内容自动路由模型。
- 修改已完成历史回复的模型归属。
- 新增供应商配置、目录来源或 provider+model 标识体系。
- 从 Open WebUI 浮动 `main`、其他版本或其他项目混合复制；新增来源需重新锁版和审查许可证。

## Technical Notes

- Open WebUI 调研与候选对比记录在 `research-open-source.md`。
- 具体 API、迁移、事务、前端状态和回滚方案记录在 `design.md`。
- 执行顺序与验证命令记录在 `implement.md`。
