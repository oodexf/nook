# 修复流式推理输出重复

## Goal

修复 OpenAI 兼容供应商在同一个流式分片中同时返回 `reasoning_content` 与 `reasoning` 时，推理文本被重复拼接、展示并持久化的问题，同时保留对两种字段名的兼容。

## Background

- `.local-data/chat.db` 中 assistant 消息 `01KZVFPJGH8754C5M83MNSQ05N` 的最终回答 `content` 正常，但 `reasoning` 出现“我们我们需需……”式逐片重复。
- 更早的多条 assistant 消息也有相同的 reasoning 重复模式，说明问题发生在流式增量进入数据库之前，而不是 Markdown 渲染阶段。
- `crates/server/src/provider.rs` 的 `UpstreamSseDecoder::dispatch` 当前会无条件依次拼接同一分片中的 `reasoning_content` 和 `reasoning`。
- 现有测试明确要求不同值 `"a"`、`"b"` 合并为 `"ab"`；修复必须保留这一兼容行为，只消除两个字段值完全相同时的重复。

## Requirements

- R1：继续接受只提供 `reasoning_content` 的供应商分片。
- R2：继续接受只提供 `reasoning` 的供应商分片。
- R3：当同一分片的两个 reasoning 字段非空且内容完全相同时，只产生一份推理增量。
- R4：当同一分片的两个 reasoning 字段内容不同时，保持既有字段顺序并拼接两者，避免丢失供应商实际提供的数据。
- R5：空 reasoning 字段不得产生空事件，也不得阻止同分片的答案 `content` 输出。
- R6：修复位于供应商协议归一化边界，使 SSE、前端显示和数据库持久化统一收到已归一化的增量。

## Acceptance Criteria

- [ ] 新增回归测试：`reasoning_content` 与 `reasoning` 同值时只输出一次 `ReasoningDelta`。
- [ ] 现有单字段别名测试继续通过。
- [ ] 两字段不同值时继续输出按 `reasoning_content` 后 `reasoning` 拼接的完整文本。
- [ ] 空字段与同分片答案内容的现有行为不回归。
- [ ] `cargo fmt --check`、相关 provider 测试以及后端 workspace 质量检查通过。
- [ ] 不改写已有数据库历史消息；修复只保证后续流式输出不再产生该类重复。

## Out of Scope

- 自动清洗数据库中已经持久化的重复 reasoning。
- 对跨分片的任意自然语言重复做启发式去重。
- 修改前端 SSE 协议、渲染逻辑或消息数据库 schema。
- 改变最终回答 `content` 的增量合并语义。

## Key Decisions

- 采用精确同值去重，不使用子串、前后缀或模糊匹配，避免误删模型有意重复的文本。
- 保留双字段不同值拼接，以兼容可能把推理拆分到两个字段的供应商。
- 本任务为边界层小型缺陷修复，使用 PRD-only 轻量任务，不额外创建 design/implement 文档。
