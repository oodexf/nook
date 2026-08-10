# 模型思维链折叠展示与空闲超时

## Goal

让支持思维链的模型（DeepSeek、通义千问、OpenRouter 等 OpenAI 兼容服务）的思考过程在聊天界面中以**独立可折叠模块**展示：流式期间可点击展开实时查看思维链，再次点击折叠；思考内容持久化到数据库，刷新后仍可查看。同时把上游超时从「整个请求总时长」改为「空闲超时」，使**思考时长不再触发最大响应时间限制**（当前默认 30s 总超时会把长思考直接断流，见 `crates/server/src/provider.rs:103` 与 `crates/server/src/config.rs:6`）。

## Confirmed Facts（代码证据）

- 上游解析：`crates/server/src/provider.rs` `ProviderDelta` 只反序列化 `content` 字段，`reasoning_content` / `reasoning` 被 serde 忽略（约 line 380）。
- 超时现状：`OpenAiProvider::new` 用 reqwest `Client::builder().timeout(ai_request_timeout)`（`provider.rs:100-106`），作用于整个流式请求；超时映射为 `ChatProviderError::Timeout` → HTTP 504 `provider_timeout`（`chat.rs:861`）。
- 对外 SSE 协议：`crates/server/src/chat.rs` `PublicStreamEvent` 仅 `meta / delta / done / stopped / error` 五种；前端 `frontend/src/lib/api/sse.ts` 解码器有 unknown-event 容忍，新增事件类型向后兼容。
- 持久化：消息存 `messages` 表（`crates/storage/migrations/0001_initial.sql`），无 reasoning 列；finalize 走 `finalize_generation`（`crates/storage/src/generation_repository.rs:150`）单事务写正文+状态。
- 前端流式状态：`frontend/src/lib/generation/generation-store.svelte.ts` `applyEvent`（line 247 起）按 `delta` 累积 `pending`/`visible`；`StreamingTurn.svelte` 渲染流式内容；`MessageItem.svelte` 渲染持久化消息。
- 回放路径：幂等重试/断线重连走 `replay_terminal`（`chat.rs` 约 line 520），把持久化正文作为单个 delta 重放。
- 前端 UI 文案为中文。

## User Decisions（已确认）

1. 上游字段格式：**两种都兼容** —— 同时解析 `delta.reasoning_content` 和 `delta.reasoning`，任一非空即视为思考内容。
2. 持久化：**保存到数据库**，刷新/重新加载会话后仍可展开查看。
3. 超时可以义：**空闲超时** —— 只要持续有任何上游事件到达就不计时超时；连续 N 秒（`AI_REQUEST_TIMEOUT_SECS`）无任何数据才算超时。

## Requirements

### R1 后端：解析并透传思维链

- `core::provider::ChatStreamEvent` 新增 `ReasoningDelta(String)` 变体。
- `server::provider` 的 `ProviderDelta` 同时解析 `reasoning_content` 与 `reasoning`；同一 chunk 中两者都出现时按序拼接为一个 `ReasoningDelta`。
- `chat.rs` `PublicStreamEvent` 新增 `ReasoningDelta { text }`，SSE 事件名 `reasoning_delta`；流式循环中独立累积思维链。
- 空字符串 reasoning delta 不向下游发送（与 content delta 现状一致）。

### R2 后端：思维链持久化

- 新增迁移 `0002_message_reasoning.sql`：`messages` 表加 `reasoning TEXT NULL` 列（仅助手消息会有值，列级 CHECK 约束 `reasoning IS NULL OR role = 'assistant'`）。
- `core::Message` 增加 `reasoning: Option<String>`；`GenerationFinalization` 增加 `reasoning` 字段；`finalize_generation` 同事务写入。
- `replay_terminal` 重放时先重放持久化的 reasoning（单个 `reasoning_delta` 事件），再重放正文 delta，保持事件顺序与实时流一致。
- 客户端断连的 `DropFinalizer` 路径同样持久化已累积的 reasoning。
- REST 会话详情 `MessageResponse` 增加 `reasoning` 字段（可空）。

### R3 后端：空闲超时

- 移除 reqwest client 对整个 chat 流式请求的总超时；保留 connect timeout（≤10s）。
- chat 流读取循环中，对每次上游 chunk 读取施加 `ai_request_timeout` 空闲超时：任何两次数据到达间隔超过该值 → `ChatProviderError::Timeout`（映射行为不变，仍 504 / `provider_timeout`）。
- 非流式的 models 列表请求保持原总超时语义不变。
- `wait_for_terminal_result`（幂等重连轮询，`chat.rs:349`）的 deadline 语义不变。
- 历史 reasoning **不回传**给上游模型（上下文只含正文，与现状一致）。

### R4 前端：可折叠思考模块

- `sse.ts` 解码器新增 `reasoning_delta` 事件（`kind: "reasoning-delta"`）。
- `generation-store` 独立累积思维链（与正文分开的 pending/visible 通道）。
- 新增共享 `ReasoningBlock` 组件，`StreamingTurn`（流式中）与 `MessageItem`（历史消息）复用：
  - 有思维链内容时，思考模块显示在正文上方；
  - 流式思考中默认展开，标题显示「正在思考…」；第一条正文 delta 到达后自动折叠一次，标题变为「思考过程」；
  - 自动折叠只发生一次，之后完全尊重用户手动展开/折叠；
  - 历史消息默认折叠；
  - 无思维链内容时模块不出现（与现状完全一致）。
- 思考内容以纯文本 + 弱化样式（小字号、次要颜色）展示，不做 Markdown 渲染。

## Acceptance Criteria

- [ ] AC1（透传）：上游流式返回 `reasoning_content` 或 `reasoning` 时，前端在生成过程中出现可折叠思考模块，点击展开可实时看到思维链增长，再次点击折叠。
- [ ] AC2（自动折叠）：第一条正文到达后思考模块自动折叠为「思考过程」一行；用户随后手动展开/折叠不受干扰。
- [ ] AC3（持久化）：生成完成后刷新页面，历史助手消息仍展示可折叠的思考模块（默认折叠），内容与生成时一致。
- [ ] AC4（空闲超时）：上游持续输出思维链超过 `AI_REQUEST_TIMEOUT_SECS` 总时长不超时；任意相邻上游数据间隔超过该值时按原路径报 `provider_timeout`（504）。
- [ ] AC5（回归）：上游不返回 reasoning 字段的模型，流式展示、持久化、回放行为与改动前完全一致；`messages.reasoning` 为 NULL。
- [ ] AC6（迁移）：旧版本数据库自动迁移，历史消息 `reasoning = NULL`，会话详情与渲染正常。
- [ ] AC7（回放）：断线重连 / 幂等重试重放已完成生成时，先出现思考模块内容再出现正文，顺序与实时流一致。
- [ ] AC8（质量门）：`cargo test`、`cargo clippy`、前端 `npm run test` / lint / type-check 全部通过（含新增测试：provider 解析两种字段、空闲超时、迁移、SSE 解码、store 累积、组件折叠交互）。

## Out of Scope

- 思考内容的 Markdown / 代码高亮渲染（纯文本展示）。
- 「已思考 N 秒」计时显示（可作为后续增强）。
- reasoning tokens 用量统计拆分。
- 将历史思维链回传给上游模型作为上下文。
- 取消/停止按钮行为变更、重试逻辑变更。

## Open Questions

无阻塞问题。
