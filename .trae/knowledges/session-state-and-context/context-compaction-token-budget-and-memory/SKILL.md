---
name: knowledge-session-state-and-context-context-compaction-token-budget-and-memory
description: >
  覆盖模型可见上下文预算、压缩 checkpoint 与跨 Session 项目记忆之间的总边界。
  适用于判断问题属于压缩流水线还是 Auto Memory、修改两者交接、排查上下文缩减后信息保留。
  不含完整 transcript/replay（见 ../durable-transcript-and-event-projection/）和活动 turn 恢复（见 ../active-turn-interactions-and-recovery/）；具体实现继续进入本节点的两个子节点。
  关键词：context compaction, token budget, replacement checkpoint, Auto Memory, MemoryRead, MemoryWrite, consolidation。
---

## Module Structure

该节点区分两种不同持久边界：compaction 只替换当前 Session 的模型可见上下文，Auto Memory 则把显式或启发式知识写入项目级文件供后续 Session 使用。二者只在成功压缩后的异步 consolidation 处相交。

### Directory Layout
- `packages/cli/src/context/`：Token 投影、handoff、snip、LLM/fallback 压缩与 replacement checkpoint
- `packages/cli/src/agent/loop/executeLoopGenerator.ts`：每次 Provider 边界前协调上下文预算
- `packages/cli/src/services/SessionService.ts`：分别加载完整 UI 历史与 replacement 后模型上下文
- `packages/cli/src/memory/`：项目记忆索引、主题文件和压缩后启发式提取
- `packages/cli/src/tools/builtin/memory/`：MemoryRead 与 MemoryWrite 工具适配
- `packages/cli/src/prompts/builder.ts`：把有界 `MEMORY.md` 索引注入新模型上下文

### Key Entry Points
- `checkAndCompactInLoop()` in `packages/cli/src/agent/loop/executeLoopGenerator.ts`：每次 Provider 请求前的分层压缩协调
- `CompactionService.compact()` in `packages/cli/src/context/CompactionService.ts`：LLM 摘要与 deterministic fallback
- `PersistentStore.saveCompaction()` in `packages/cli/src/context/storage/PersistentStore.ts`：原子保存 replacement checkpoint
- `AutoMemoryManager.loadIndex()` in `packages/cli/src/memory/AutoMemoryManager.ts`：启动时读取有界项目记忆
- `consolidateAfterCompaction()` in `packages/cli/src/memory/MemoryConsolidation.ts`：从被压缩消息启发式提取项目记忆

## Gotchas
- `ContextManager` 已是 PersistentStore 薄门面，不拥有当前 Session 内存、filter 或 compaction；新增 runtime 上下文逻辑应接入 Agent loop/CompactionService，而不是恢复旧式 manager 状态 (`packages/cli/src/context/ContextManager.ts`, `git:a074815b`)
- `ContextAssembler` 目前只有测试消费者，`ContextCompressor` 与 `ContextFilter` 没有生产调用点；修改这些类不会改变实际 Agent loop 的模型上下文 (`packages/cli/src/context/ContextAssembler.ts`, `packages/cli/src/context/processors/ContextCompressor.ts`, `packages/cli/src/context/processors/ContextFilter.ts`)
- `checkAndCompactInLoop()` 的顺序是 cache-expiry micro compact、普通 snip、80% LLM compaction；snip 结果延迟应用，确保 LLM compaction 被取消或 checkpoint 失败时不会留下半更新内存 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- replacement 必须先通过 `saveCompaction()` fsync 到 JSONL，再替换内存并重试 Provider；checkpoint commit 失败时本轮以 `checkpoint` phase 失败，不能仅在内存继续 (`packages/cli/src/agent/loop/conversationPersistence.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- 完整 transcript 始终保留，`loadSessionModelContext()` 只使用最新有效 replacement checkpoint 加其后事件；UI、搜索和导出仍看 materialized 完整历史 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/context/compactionCheckpoint.ts`)
- `computeAdaptiveBudget()` 当前只有测试调用，生产 loop 仍使用默认 `MessageBudgetTracker` 与默认单结果预算；只修改 adaptive 函数不会改变实际 tool result 截断 (`packages/cli/src/context/ToolResultBudget.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- 压缩后 memory consolidation 是 fire-and-forget 且吞掉失败，并使用进程 `getCwd()` 建立项目记忆；多 workspace/worktree 调用不能把它当作 checkpoint 成功条件或精确 active-workspace 写入 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)
- MemoryWrite 的敏感信息检查是少量正则启发式，不是通用 secret scanner；通过检查不代表内容适合持久化 (`packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`)

## Architecture
- 主循环在每次请求前对 system messages、tool schemas、history 和 pending control message 建立 request fingerprint；Provider baseline 与本地增量共同生成一份供 handoff 和 compaction 共享的 snapshot (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/context/ContextTokenTracker.ts`)
- token lifecycle 分为 `below_handoff -> handoff_band -> compaction_due`：中间阶段持久化一次 continuation reminder，达到压缩线后生成 replacement checkpoint (`packages/cli/src/context/TokenBudgetHandoff.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- compaction checkpoint 以 summary part 的 `replacementMessages` 持久化，版本、条数 4096 和 16 MiB 限制在序列化与恢复两端同时校验 (`packages/cli/src/context/compactionCheckpoint.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- Auto Memory 与 Session transcript 分离：Prompt builder 只注入 `MEMORY.md` 前 200 行，主题文件由 MemoryRead 按需获取，MemoryWrite 与 consolidation 负责写入 (`packages/cli/src/prompts/builder.ts`, `packages/cli/src/memory/AutoMemoryManager.ts`)
- 成功压缩只异步触发 memory consolidation；记忆写入结果既不改变 replacement checkpoint，也不参与本轮成功判定 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)

## Decisions
- token handoff 被设计成 durable、严格可验证但 client-hidden 的控制事实，用来在真正压缩前迫使模型显式记录执行前沿，而不是依赖摘要猜测未完成状态 (`packages/cli/src/context/TokenBudgetHandoff.ts`, `git:feb27f31`, `git:ce84b669`)
- compaction fallback 从固定消息比例改为实测 token 预算和原子 message unit，以避免长单消息、tool pair 或超大 context window 绕过上限 (`packages/cli/src/context/CompactionFallback.ts`, `git:1d3f3173`)
- Auto Memory 使用独立项目存储而不是 Session transcript，使记忆可跨会话复用，但也不继承 transcript 的事件顺序、回退和审计语义 (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/context/storage/PersistentStore.ts`, `git:40128981`)

## Patterns
- 判断信息去向时先区分“本 Session 后续 Provider 必须继续看到”与“未来 Session 可按需读取”：前者进入 replacement/ledger，后者进入项目 memory (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/memory/AutoMemoryManager.ts`)
- 修改压缩保留证据时进入 compaction 子节点；修改项目知识索引、topic、写入安全或 consolidation 时进入 Auto Memory 子节点 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)

## Child Knowledge Nodes
- `./compaction-pipeline-and-checkpoints/SKILL.md`：适用于修改 Token 投影、handoff、snip、LLM/fallback 压缩、context-limit 恢复或 replacement checkpoint
- `./project-auto-memory/SKILL.md`：适用于修改 MEMORY.md/topic 存储、MemoryRead/Write、敏感内容检查或压缩后自动巩固
