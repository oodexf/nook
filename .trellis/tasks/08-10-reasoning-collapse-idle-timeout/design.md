# 技术设计：模型思维链折叠展示与空闲超时

## 架构与边界

改动贯穿五层，每层职责单一，沿用现有边界：

```
上游 OpenAI 兼容服务
  └─ server::provider   解析 reasoning_content / reasoning → core::ChatStreamEvent::ReasoningDelta
       └─ server::chat  新增 PublicStreamEvent::ReasoningDelta（SSE: reasoning_delta）+ 独立累积 + finalize 持久化
            └─ storage  messages.reasoning 列（迁移 0002）
            └─ REST     MessageResponse.reasoning（会话详情）
                 └─ frontend sse.ts → generation-store → ReasoningBlock（StreamingTurn / MessageItem 复用）
```

## 后端设计

### 1. core（`crates/core/src/provider.rs`、`conversation.rs`）

- `ChatStreamEvent` 新增变体：
  ```rust
  pub enum ChatStreamEvent {
      Delta(String),
      ReasoningDelta(String),
      Done { finish_reason: String, usage: TokenUsage },
  }
  ```
- `Message` 增加 `reasoning: Option<String>`。user 消息恒为 `None`（由 storage 列级 CHECK 保证）。

### 2. server::provider（`crates/server/src/provider.rs`）

**字段解析**：

```rust
#[derive(Default, serde::Deserialize)]
struct ProviderDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
    reasoning: Option<String>,
}
```

`dispatch` 中：`reasoning_content` 与 `reasoning` 按序拼接（`reasoning_content` 在前），非空则先于 content delta push `ChatStreamEvent::ReasoningDelta`。两者并存属异常情况，拼接保证不丢内容。

**空闲超时**（替换总超时）：

- `Client::builder()` 移除 `.timeout(timeout)`，保留 `.connect_timeout(min(timeout, 10s))`。
- models 列表请求（`fetch`）在单个 request 上加 `.timeout(timeout)`，保持原总超时语义。
- chat 流循环改为：
  ```rust
  loop {
      let next = match tokio::time::timeout(self.idle_timeout, bytes.next()).await {
          Ok(next) => next,
          Err(_) => { yield Err(ChatProviderError::Timeout); return; }
      };
      ...
  }
  ```
  `idle_timeout` 存为 `OpenAiProvider` 字段。任何相邻数据到达间隔 > timeout 才算超时；思维链持续输出期间永不触发。

### 3. server::chat（`crates/server/src/chat.rs`）

- `PublicStreamEvent` 新增 `ReasoningDelta { text: String }`；`encode_event` 事件名 `reasoning_delta`。
- 流式循环：`ChatStreamEvent::ReasoningDelta(text)` → 累积进独立 `accumulated_reasoning: Arc<Mutex<String>>`，并 `yield ReasoningDelta { text }`。
- `finalize` 签名增加 `reasoning: String`（空串存 NULL）；`GenerationFinalization` 增加 `reasoning: Option<String>`。
- `DropFinalizer` 持有 `accumulated_reasoning` 的 `Arc` 克隆，断连兜底持久化与正文一致。
- `replay_terminal`：持久化 reasoning 非空时先 yield 单个 `ReasoningDelta`（全文），再 yield 正文 delta，再 terminal —— 与实时流事件顺序一致。
- `with_request_id` / 终端事件匹配处补充新变体。

### 4. storage（`crates/storage/`）

- 迁移 `migrations/0002_message_reasoning.sql`：
  ```sql
  ALTER TABLE messages ADD COLUMN reasoning TEXT NULL
      CHECK (reasoning IS NULL OR role = 'assistant');
  ```
  `MIGRATIONS` 数组追加 version 2。注意 `ALTER TABLE ... ADD COLUMN` 的列级 CHECK 可以引用同表其他列（SQLite 支持）。
- `conversation_repository::messages_for_conversation` SELECT 增加 `reasoning`；`map_message` 映射。
- `generation_repository::finalize_generation` UPDATE messages 增加 `reasoning = ?`；空串按 NULL 写入（在 server 层转换：`(!reasoning.is_empty()).then_some(reasoning)`）。
- `insert_message` / 测试辅助插入路径补 `reasoning` 列。

### 5. REST（`crates/server/src/conversations.rs`）

- `MessageResponse` 增加 `reasoning: Option<String>`，serde 照常序列化为 `null` 或字符串（可空字段是稳定契约）。

## 前端设计

### 1. SSE 解码（`frontend/src/lib/api/sse.ts`）

- 新增 `ChatStreamReasoningDelta { kind: "reasoning-delta"; text: string }`，复用 `MAX_DELTA_LENGTH` 边界；`KNOWN_EVENTS` 加 `"reasoning_delta"`；`decodePayload` 加分支。协议状态机不变（meta 优先、terminal 后禁事件）。

### 2. 流式状态（`generation-store.svelte.ts`）

- `ActiveGeneration` 增加 `pendingReasoning` / `visibleReasoning`；`applyEvent` 的 `reasoning-delta` 分支与 `delta` 对称累积；flush 调度复用现有 `scheduleFlush`。
- `settle` 时 reasoning 随终态一同定型；重试新 attempt 从空开始（与正文一致）。

### 3. 组件

新增 `frontend/src/lib/generation/ReasoningBlock.svelte`（与 StreamingTurn 同层，因为两处都是生成展示语境；若 spec 要求共享组件位置则放 `lib/components/`）：

- Props：`reasoning: string`、`streaming: boolean`（控制标题文案与默认展开）。
- 内部折叠状态：流式期间初始展开；`streaming` 从 true 变 false（或正文开始出现，由父组件传 `autoCollapsed` 信号）时自动折叠一次；之后纯用户控制。实现建议：父组件传入 `defaultExpanded`，组件内部 `$state` 管理，自动折叠用一个 `hasAutoCollapsed` 标志保证只发生一次。
- 标题行：chevron 图标（复用 `ChevronRightIcon`）+ 「正在思考…」（streaming）/「思考过程」；内容区纯文本、小字号、次要颜色、`white-space: pre-wrap`。
- `reasoning` 为空时父组件不渲染该组件。

接入点：

- `StreamingTurn.svelte`：正文区上方渲染 `ReasoningBlock`（`reasoning = visibleReasoning`），正文开始出现时触发自动折叠。
- `MessageItem.svelte`：`message.reasoning` 非空时在 Markdown 正文上方渲染，默认折叠。
- `frontend/src/lib/api/conversations.ts`：`ChatMessage` 增加 `reasoning: string | null`，`decodeChatMessage` 接受 `null` 或有界字符串（复用 `MAX_CONTENT_LENGTH` 边界）。

## 数据流与契约

实时流事件序列（有思维链时）：

```
meta → reasoning_delta* → delta* → done|stopped|error
```

回放序列（replay_terminal）：

```
meta → reasoning_delta(全文,可选) → delta(全文) → terminal
```

REST 消息：

```json
{ "id": "...", "role": "assistant", "content": "...", "reasoning": "..." | null, ... }
```

## 兼容性与迁移

- **SSE 协议**：新增事件类型，前端解码器本就有 unknown-event 容忍 → 新旧前后端任意组合不崩溃（旧前端忽略 reasoning_delta；新前端收不到时模块不出现）。
- **DB**：`ALTER TABLE ADD COLUMN` 对现有行填 NULL；迁移框架按 version 顺序应用，已有 `MigrationMismatch` 防护。
- **API**：新增可空字段，旧客户端解码器若严格校验未知字段需确认 —— `decodeChatMessage` 现状只校验需要的字段，不排斥额外字段。
- **上下文**：历史 reasoning 不进 `messages_before_assistant` 的上游上下文（`ProviderChatMessage` 只有 role/content，天然不含）。

## 权衡

| 决策 | 选择 | 放弃 | 理由 |
|---|---|---|---|
| reasoning 存 messages 表列 | 加可空列 | 存 generations 表 / JSON 合并进 content | 消息是展示实体；独立列不污染正文 Markdown；查询路径不变 |
| 空闲超时实现 | 移除 client 总超时 + 逐 chunk `tokio::time::timeout` | 保留总超时但思考期间刷新 deadline | reqwest 总超时无法按事件类型豁免；逐 chunk 超时语义直白且与用户决策一致 |
| 两字段并存 | 拼接为一个 ReasoningDelta | 优先级二选一 | 不丢内容；实现简单；实际服务不会同时返回 |
| 自动折叠 | 仅自动一次，之后尊重用户 | 每次新正文都折叠 | 避免与用户操作打架 |
| 思考内容渲染 | 纯文本 | Markdown | 思维链常含未闭合标记，渲染噪音大；保持 MVP |

## 回滚

- 代码回滚：单层可独立 revert；SSE 新事件旧端可容忍。
- DB 迁移：version 2 仅加可空列，回滚代码后旧代码 SELECT 不读该列仍可运行（SQLite 列存在不影响旧查询）；无需反向迁移。

## 测试策略

- provider 单测：reasoning_content 解析、reasoning 解析、两字段拼接、空串忽略、空闲超时触发（用 tokio test time / 可控流）、models 请求总超时保留。
- chat 集成测试（`test_provider.rs` 现有模式）：reasoning_delta 透传顺序、finalize 持久化 reasoning、replay 顺序。
- storage 测试：迁移 0002 应用、CHECK 约束（user 消息带 reasoning 拒绝）、finalize 写 reasoning。
- 前端：`sse.test.ts` 新事件解码；`generation-store.test.ts` 累积与终态；`ReasoningBlock` / `StreamingTurn` / `MessageItem` 组件测试（折叠交互、自动折叠一次、历史默认折叠、空 reasoning 不渲染）。
