# 执行计划：模型思维链折叠展示与空闲超时

按依赖顺序执行；每步完成后跑对应层的校验。

## 实现清单

### 1. storage：迁移与持久化
- [ ] 新增 `crates/storage/migrations/0002_message_reasoning.sql`（`ALTER TABLE messages ADD COLUMN reasoning TEXT NULL CHECK (reasoning IS NULL OR role = 'assistant')`）
- [ ] `migration.rs` `MIGRATIONS` 追加 version 2
- [ ] `core::Message` 增加 `reasoning: Option<String>`；`conversation_repository` SELECT/映射/插入路径同步
- [ ] `generation_repository::finalize_generation` UPDATE 增加 `reasoning`；`GenerationFinalization`（core）加字段
- [ ] storage 测试：迁移应用、CHECK 约束、finalize 写 reasoning、历史行 NULL

### 2. core + server::provider：上游解析与空闲超时
- [ ] `core::provider::ChatStreamEvent` 增加 `ReasoningDelta(String)`
- [ ] `ProviderDelta` 解析 `reasoning_content` + `reasoning`，dispatch 拼接推送
- [ ] `OpenAiProvider`：client 移除总 `.timeout()`，保留 connect timeout；models `fetch` 单请求加 `.timeout()`；chat 流逐 chunk `tokio::time::timeout(idle_timeout, bytes.next())`
- [ ] provider 测试：两种字段、拼接、空串忽略、空闲超时、models 总超时

### 3. server::chat + REST：透传、累积、回放
- [ ] `PublicStreamEvent::ReasoningDelta` + `encode_event` 事件名 `reasoning_delta` + `with_request_id` 匹配
- [ ] 流式循环独立累积 `accumulated_reasoning`；`finalize` 与 `DropFinalizer` 持久化（空串 → NULL）
- [ ] `replay_terminal` 先重放 reasoning 再重放正文
- [ ] `conversations.rs` `MessageResponse` 增加 `reasoning`
- [ ] chat 测试：透传顺序、持久化、回放顺序

### 4. 前端：解码与状态
- [ ] `sse.ts`：`reasoning_delta` 事件解码 + 类型 + 测试
- [ ] `conversations.ts`：`ChatMessage.reasoning: string | null` + 解码 + 测试
- [ ] `generation-store.svelte.ts`：`pendingReasoning`/`visibleReasoning` 累积、终态定型 + 测试

### 5. 前端：ReasoningBlock 组件与接入
- [ ] 新增 `ReasoningBlock.svelte`（折叠交互、自动折叠一次、中文文案、弱化样式）
- [ ] `StreamingTurn.svelte` 接入（流式默认展开，正文到达自动折叠）
- [ ] `MessageItem.svelte` 接入（历史默认折叠，空 reasoning 不渲染）
- [ ] 组件测试：展开/折叠、自动折叠一次、手动操作不受干扰、空内容不渲染

### 6. 全量质量门
- [ ] `cargo test`（workspace）
- [ ] `cargo clippy --all-targets -- -D warnings`（如项目有此配置；至少 `cargo clippy` 无新告警）
- [ ] `cd frontend && npm run test && npm run lint && npm run check`（以 package.json 实际脚本为准）

## 验证命令

```bash
cargo test -p storage -p core -p server
cargo clippy --workspace --all-targets
cd frontend && npm run test && npm run lint && npm run check
```

手工冒烟（有真实 reasoning 模型时）：发消息 → 思考模块展开流式增长 → 正文到达自动折叠 → 手动展开/折叠 → 刷新后历史消息默认折叠可展开；长思考（>30s）不超时。

## 风险点 / 回滚点

| 风险 | 位置 | 缓解 |
|---|---|---|
| 移除 client 总超时影响 models 请求 | `provider.rs::OpenAiProvider::new` | models fetch 单独加 `.timeout()`；单测覆盖 |
| `ALTER TABLE` 列级 CHECK 引用他列 | `0002_message_reasoning.sql` | SQLite 支持；迁移测试验证；失败时回退为无 CHECK 的可空列 |
| DropFinalizer 漏存 reasoning | `chat.rs` | 与正文同 Arc 模式；断连路径测试 |
| 自动折叠与用户操作竞争 | `ReasoningBlock.svelte` | `hasAutoCollapsed` 标志只触发一次；组件测试覆盖 |
| 回放事件顺序破坏前端协议机 | `chat.rs::replay_terminal` | reasoning_delta 在 terminal 前；前端 unknown-event 容忍兜底 |

## 开始前一查

- 确认 `frontend/package.json` 的实际脚本名（test/lint/check）。
- 确认 `crates/server/src/test_provider.rs` 的测试 provider 构造方式，reasoning 测试沿用同模式。
