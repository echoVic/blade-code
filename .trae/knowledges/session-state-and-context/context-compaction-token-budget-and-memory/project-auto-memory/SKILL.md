---
name: knowledge-session-state-and-context-project-auto-memory
description: >
  覆盖项目级 MEMORY.md 索引、主题文件、MemoryRead/MemoryWrite 工具和压缩后启发式巩固。
  适用于修改跨 Session 记忆加载、topic 命名、手工读写、安全过滤、项目身份或 consolidation 规则。
  不含单 Session Token 压缩与 replacement checkpoint（见 ../compaction-pipeline-and-checkpoints/）和 durable transcript（见 ../../durable-transcript-and-event-projection/）。
  关键词：AutoMemoryManager, MemoryConsolidation, MemoryRead, MemoryWrite, MEMORY.md, topic, BLADE_AUTO_MEMORY。
---

## Module Structure

Auto Memory 位于 Session transcript 之外，以项目路径派生独立存储目录。系统提示只自动加载有界索引，详细 topic 由工具按需读取；成功压缩后还会用无 LLM 的规则从被丢弃消息中追加少量候选知识。

### Directory Layout
- `packages/cli/src/memory/AutoMemoryManager.ts`：索引、topic、列举和清理
- `packages/cli/src/memory/MemoryConsolidation.ts`：压缩后启发式提取
- `packages/cli/src/memory/types.ts`：启用开关与索引行数预算
- `packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`：按 topic 读取或列举
- `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`：手工写入与敏感模式拒绝
- `packages/cli/src/prompts/builder.ts`：新模型上下文中的索引注入
- `packages/cli/src/slash-commands/memory.ts`：用户侧项目记忆管理

### Key Entry Points
- `AutoMemoryManager.loadIndex()`：加载有界 `MEMORY.md`
- `AutoMemoryManager.readTopic()` / `writeTopic()`：读取或更新详细主题
- `extractLearnings()`：从用户、assistant 和 tool 消息提取有限规则命中
- `consolidateAfterCompaction()`：按日期追加提取结果
- `memoryReadTool` / `memoryWriteTool`：模型侧手工访问入口

## Gotchas
- `MEMORY.md` 自动注入只取前 200 行并附加剩余行提示；`MemoryRead(topic="MEMORY")` 仍可读取完整索引，因此索引过长不会丢失，但会增加一次显式工具调用 (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`)
- `BLADE_AUTO_MEMORY=0` 只阻止 Prompt builder 自动注入索引，不会注销 MemoryRead/MemoryWrite，也不会阻止手工访问项目记忆 (`packages/cli/src/prompts/builder.ts`, `packages/cli/src/tools/builtin/index.ts`)
- topic 中的路径分隔符和特殊字符统一替换为 `-`；不同原始 topic 可能映射到同一个 `.md` 文件，调用方不能把原始名称当成无碰撞身份 (`packages/cli/src/memory/AutoMemoryManager.ts`)
- append 是“读取旧正文再整体 writeFile”，AutoMemoryManager 没有 keyed mutex 或原子替换；MemoryWrite 的非并发标记只约束单个 executor，跨 Session 同 topic 写入仍可能 last-writer-wins (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`)
- Memory 工具优先用 `ExecutionContext.workspaceRoot` 派生项目，Prompt builder 使用传入的 `projectPath`，自动巩固使用 `getCwd()`；worktree 和多 workspace 路径必须显式对齐，不能假设三条入口天然写到同一目录 (`packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`, `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`, `packages/cli/src/prompts/builder.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)
- MemoryWrite 的敏感信息拒绝只覆盖少量 `password/token/secret/api key/private key` 正则，既可能漏掉其他凭据，也允许不带赋值形态的普通 password 语句；通过校验不等于内容可安全持久化 (`packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`)
- MemoryRead 对 topic 不存在和空列表都返回 `success: true`，调用方必须检查返回正文，不能把工具成功当作记忆已命中 (`packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`)
- `listTopics()` 只把 `ENOENT` 解释为空列表，其他文件系统错误会抛出并可由 retry-safe 的 MemoryRead 做瞬态重试；`deleteTopic()` 仍把任意 unlink 异常折叠为 false，两个入口的失败语义不同 (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`)
- 自动巩固只识别用户显式 remember/convention/lesson 标记、assistant 的 fix 文本和有限 tool error 模式；tool error 每次最多保留 5 条，它不是对被丢弃上下文的完整语义总结 (`packages/cli/src/memory/MemoryConsolidation.ts`)
- 压缩成功后 consolidation 以 fire-and-forget 启动并吞掉全部异常；记忆写入失败既不回滚 checkpoint，也不会令 compaction 失败 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)

## Architecture
- `AutoMemoryManager` 通过项目存储路径把 `MEMORY.md` 与 topic 文件放在 Session transcript 之外，使同一项目的后续 Session 可以复用，但不会继承 rewind、fork 或 committed seq 语义 (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/context/storage/pathUtils.ts`)
- Prompt builder 只把索引放入 `<auto-memory>`，详细 topic 不自动进入系统提示；MemoryRead 是渐进披露入口 (`packages/cli/src/prompts/builder.ts`, `packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`)
- MemoryRead 是并发安全且可重试的 ReadOnly 工具，MemoryWrite 是不可并发、不可自动重放的 Write 工具；两者仍通过统一 ToolExecutor 权限与结果契约 (`packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`, `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`)
- consolidation 不调用额外模型，只把规则命中按日期追加到 preferences、conventions、lessons 或 debugging topic，避免压缩额外产生 Provider 请求 (`packages/cli/src/memory/MemoryConsolidation.ts`)

## Decisions
- Auto Memory 以索引加 topic 的两层结构实现渐进披露：启动成本固定在索引前 200 行，详细经验留给按需工具读取 (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/prompts/default.ts`, `git:40128981`)
- 自动巩固采用保守启发式并在失败时不影响压缩主路径，优先保证 Session checkpoint 可提交，而不是保证每次压缩都产生记忆 (`packages/cli/src/context/CompactionService.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)

## Patterns
- `topic="MEMORY"` 是索引写入的保留入口，`topic="_list"` 只在 MemoryRead 中表示列举；普通 topic 最终统一补 `.md` 后缀 (`packages/cli/src/tools/builtin/memory/MemoryReadTool.ts`, `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`, `packages/cli/src/memory/AutoMemoryManager.ts`)
- append 会在旧正文缺少尾换行时补一个分隔换行，consolidation 自身则把每条结果格式化为带 ISO 日期的 Markdown 列表项 (`packages/cli/src/memory/AutoMemoryManager.ts`, `packages/cli/src/memory/MemoryConsolidation.ts`)
- topic 列表按最后修改时间降序返回并包含 `MEMORY` 本身；UI 或 Agent 若要把索引固定在首位，需要在消费端另行排序 (`packages/cli/src/memory/AutoMemoryManager.ts`)
