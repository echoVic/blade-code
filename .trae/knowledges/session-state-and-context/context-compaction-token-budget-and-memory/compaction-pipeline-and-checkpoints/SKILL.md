---
name: knowledge-session-state-and-context-compaction-pipeline-and-checkpoints
description: >
  覆盖 Token 占用投影、70% handoff、micro/snip/LLM/fallback 压缩、context-limit 恢复和 replacement checkpoint。
  适用于修改压缩阈值、摘要重试、continuation ledger、工具结果预算、保留证据或 Provider overflow 恢复。
  不含项目级 Auto Memory（见 ../project-auto-memory/）和完整 transcript/replay（见 ../../durable-transcript-and-event-projection/）。
  关键词：CompactionService, ContextTokenTracker, TokenBudgetHandoff, SnipCompaction, ReactiveCompaction, CompactionFallback, replacementMessages。
---

## Module Structure

该节点控制单个 Session 发给 Provider 的有效上下文。它保留完整 JSONL 历史，只通过有版本的 replacement checkpoint 改变后续模型请求，并把任何可重放恢复限制在 Provider 尚未交付真实输出的边界内。

### Directory Layout
- `packages/cli/src/context/ContextTokenTracker.ts`：Provider usage 基线与下一请求占用投影
- `packages/cli/src/context/TokenBudgetHandoff.ts`：70% 交接和 80% 压缩状态机
- `packages/cli/src/context/SnipCompaction.ts`：旧工具轮次和 cache-expiry micro compact
- `packages/cli/src/context/CompactionService.ts`：LLM 摘要、ledger、效果验证与失败熔断
- `packages/cli/src/context/CompactionFallback.ts`：无模型的 token-bound replacement planner
- `packages/cli/src/context/ReactiveCompaction.ts`：context-limit 错误的一次性紧急恢复
- `packages/cli/src/context/compactionCheckpoint.ts`：replacementMessages 的持久格式和边界
- `packages/cli/src/context/ToolResultBudget.ts`：单结果与单轮工具输出预算

### Key Entry Points
- `checkAndCompactInLoop()` in `packages/cli/src/agent/loop/executeLoopGenerator.ts`：按固定层级协调压缩
- `ContextTokenTracker.project()` in `packages/cli/src/context/ContextTokenTracker.ts`：生成 handoff/compaction 共用占用快照
- `CompactionService.compact()` in `packages/cli/src/context/CompactionService.ts`：生成并验证 replacement
- `PersistentStore.saveCompaction()` in `packages/cli/src/context/storage/PersistentStore.ts`：先持久化 checkpoint 再允许内存替换

## Gotchas
- 预测式占用以 `max(totalTokens, promptTokens + completionTokens)` 为 Provider floor，Provider 已计算的 assistant response 不能再次本地累加；只估算该响应之后的消息和固定 context 正向增长 (`packages/cli/src/context/ContextTokenTracker.ts`)
- Provider usage 缺失、history 被破坏性重写、首个追加项不是 assistant 或 revision 不匹配时必须退回完整本地估算，不能沿用旧 baseline (`packages/cli/src/context/ContextTokenTracker.ts`)
- handoff/compaction 阈值基于 `maxContextTokens - output reserve` 的输入预算，而非整个 context window；未显式给 output cap 时 reserve 为 10%，并限制在 8192 到 32768 (`packages/cli/src/context/TokenBudgetHandoff.ts`)
- durable handoff 只允许出现在 70% 到 80% band，当前 compaction epoch 只能有一条严格 v1 记录；重复或畸形 raw record 会把该 epoch 标记 suppressed，而不是择一恢复 (`packages/cli/src/context/TokenBudgetHandoff.ts`, `git:4cf1fcba`)
- handoff 是只供模型继续任务的隐藏 user message：会持久化但不进入 client stream，fork 会剥离，compaction 输入也会先剥离；不要把它渲染成普通用户消息 (`packages/cli/src/context/TokenBudgetHandoff.ts`, `packages/cli/src/context/events/SessionEventLog.ts`)
- `checkAndCompactInLoop()` 的顺序是 cache-expiry micro compact、普通 snip、80% LLM compaction；snip 结果延迟应用，确保 LLM compaction 被取消或 checkpoint 失败时不会留下半更新内存 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- 当 token snapshot 为 unknown 时仍可应用 micro/snip，但不会做 LLM compaction 或 handoff；没有 usage 不等于完全禁用本地瘦身 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- reactive compaction 每个成功 Provider boundary 只允许一次，并且仅在 context-limit 错误发生于任何 content/thinking/usage/tool-call 之前才可重放；跨过输出边界后必须 fail closed (`packages/cli/src/context/ReactiveCompaction.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- compaction hook 可显式阻止压缩；该情况抛 `CompactionBlockedError`，reactive 路径返回失败且保留原上下文，不能伪造 fallback checkpoint (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/context/ReactiveCompaction.ts`)
- 摘要采样内部关闭 SDK retry，只共享最多三次总预算；context overflow 的缩减顺序是移除可重读文件、丢弃最旧完整 message/tool unit、降低单消息字符上限，且每次输入必须严格变小 (`packages/cli/src/context/CompactionService.ts`, `git:2d8977b9`)
- LLM 返回非空摘要仍要通过效果门槛：大历史 replacement 不得超过源消息 80%，所有结果还受 context 50% 和 50,000 tokens 上限；缩减不足会记账后进入 fallback (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/context/CompactionFallback.ts`, `git:9889c4f0`)
- deterministic fallback 先预算 ledger 与 active-task checkpoint，再从最新端保留完整 message unit；assistant tool call 与对应 results 不拆分，边界只截一个 unit，reasoning 和图片载荷被移除或占位 (`packages/cli/src/context/CompactionFallback.ts`)
- mandatory active-task checkpoint 超过目标时会把目标提升到 checkpoint 实际大小，而不是静默删除用户约束；未截断 checkpoint 已覆盖的最后 user message 才会从 fallback tail 去重 (`packages/cli/src/context/CompactionFallback.ts`, `packages/cli/src/context/CompactionService.ts`)
- replacement 必须先通过 `saveCompaction()` fsync 到 JSONL，再替换内存并重试 Provider；checkpoint commit 失败时本轮以 `checkpoint` phase 失败，不能仅在内存继续 (`packages/cli/src/agent/loop/conversationPersistence.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- continuation ledger 的七个 heading 是宿主协议；显式 `EXACT CONTINUATION RECORD` 会在模型摘要后由宿主去重并逐字归位，不能交给模型自由改写 (`packages/cli/src/context/CompactionService.ts`, `git:86f49fec`)
- 最近文件恢复必须同时按 Session 与 active workspace 过滤，并拒绝 workspace 外路径和符号链接；先截前五条再过滤会饿死真正可恢复文件 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/context/FileAnalyzer.ts`)

## Architecture
- 主循环在每次请求前对 system messages、tool schemas、history 和 pending control message 建立 request fingerprint；Provider baseline 与本地增量共同生成一份供 handoff 和 compaction 共享的 snapshot (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/context/ContextTokenTracker.ts`)
- token lifecycle 分为 `below_handoff -> handoff_band -> compaction_due`：中间阶段持久化一次 continuation reminder，达到压缩线后生成 replacement checkpoint (`packages/cli/src/context/TokenBudgetHandoff.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- CompactionService 将摘要、最近 20% 候选消息、最近文件恢复和 active-task checkpoint 组合为 replacement，再用 TokenCounter 验证最终大小；失败则转入同一格式的 deterministic fallback (`packages/cli/src/context/CompactionService.ts`)
- compaction checkpoint 以 summary part 的 `replacementMessages` 持久化，版本、条数 4096 和 16 MiB 限制在序列化与恢复两端同时校验 (`packages/cli/src/context/compactionCheckpoint.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)

## Decisions
- token handoff 被设计成 durable、严格可验证但 client-hidden 的控制事实，用来在真正压缩前迫使模型显式记录执行前沿，而不是依赖摘要猜测未完成状态 (`packages/cli/src/context/TokenBudgetHandoff.ts`, `git:feb27f31`, `git:ce84b669`)
- compaction fallback 从固定消息比例改为实测 token 预算和原子 message unit，以避免长单消息、tool pair 或超大 context window 绕过上限 (`packages/cli/src/context/CompactionFallback.ts`, `git:1d3f3173`)
- 多模态压缩只发送文本与固定图片占位，避免把 data URL/远程图片重新送给摘要模型；canonical history 和 LLM 成功后的 retained tail 不被改写 (`packages/cli/src/context/CompactionService.ts`, `git:9a3ad0ea`)
- 压缩失败熔断按 normalized workspace 与 session 复合键隔离，连续三次失败后本地 fallback，避免一个会话拖垮其他 Session 或持续产生摘要费用 (`packages/cli/src/context/CompactionService.ts`)

## Context Preservation
- exact record、active task、最近文件和最新完整消息单元代表四种不同恢复证据：前两者保执行约束，文件恢复保工作集，tail 保最近对话，修改预算时不能把它们合并成单一摘要 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/context/CompactionFallback.ts`)
- snip 对候选旧 tool turn 按“只读成功 < 写操作 < 错误”排序，但只从最近保留窗口之前移除；错误证据和写入副作用会比可重读查询保留更久 (`packages/cli/src/context/SnipCompaction.ts`)
- 超过 60 秒未调用 Provider 时 micro compact 只保留最近三轮 tool turn，以服务端 prompt cache 已失效为前提减少重传成本 (`packages/cli/src/context/SnipCompaction.ts`, `git:777b9949`)
