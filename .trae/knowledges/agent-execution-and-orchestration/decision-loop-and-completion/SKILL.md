---
name: knowledge-agent-execution-and-orchestration-decision-loop-and-completion
description: >
  覆盖流式 Agent loop、工具调用轮次、持久提交顺序、错误恢复、完成门禁、系统提示和结构化输出。
  进入时机：修改 executeLoopGenerator、CompletionPolicy、ConversationState、流式工具预启动、
  Plan 模式或最终响应判定。不包含：Session 磁盘生命周期（见 ../../session-state-and-context/）、
  具体工具权限与执行阶段（见 ../../tool-and-automation-platform/tool-execution-pipeline/）。
  关键词：Agent, executeLoopGenerator, StreamingToolExecutor, completion gate,
  independent verification, StructuredOutput, durable tool result, stream_end。
---

## Module Structure

该节点描述一次 Agent run 如何在 Provider 回合、工具副作用、持久化和多重完成条件之间推进，并保证崩溃恢复后不会把未提交状态当成成功。

### Directory Layout
- `packages/cli/src/agent/Agent.ts` — 无状态入口、运行模式切换和 SessionRuntime 适配
- `packages/cli/src/agent/ExecutionEngine.ts` — ContextManager 容器与简单单轮执行兼容入口
- `packages/cli/src/agent/ExecutionSummary.ts` — 运行统计摘要
- `packages/cli/src/agent/loop/` — 主循环、会话状态、工具流、完成策略和恢复检测
  - `executeLoopGenerator.ts` — 核心状态机
  - `StreamingToolExecutor.ts` — 流式预启动、排队、顺序收集和 epoch 丢弃
  - `completionPolicy.ts` — 显式委派、worktree、验证和停止策略
  - `conversationPersistence.ts` — 消息、工具调用、工具结果和压缩的 durable commit
  - `independentVerification.ts` — 非平凡实现的独立验证门禁
  - `goalCompletionVerification.ts` — Goal 完成候选门禁
  - `actionStationarity.ts` — 重复工具动作的进展感知检测
- `packages/cli/src/prompts/` — 默认提示、Plan 提示、项目指令和 Provider 边界附加内容
- `packages/cli/src/services/StructuredOutputService.ts` — JSON Schema 终态契约与恢复

### Key Entry Points
- `Agent.chatStream()` in `packages/cli/src/agent/Agent.ts` — 统一事件流入口并处理 durable input、follow-up 与 Goal continuation
- `executeLoopGenerator()` in `packages/cli/src/agent/loop/executeLoopGenerator.ts` — 完整 agentic loop
- `StreamingToolExecutor.addTool()` in `packages/cli/src/agent/loop/StreamingToolExecutor.ts` — 决定流内预启动、排队或拒绝
- `checkIndependentVerificationGate()` in `packages/cli/src/agent/loop/independentVerification.ts` — 主 Agent 独立验证准出
- `createStructuredOutputContract()` in `packages/cli/src/services/StructuredOutputService.ts` — 结构化终态校验入口

## Gotchas
- `stream_end` 是每个 Provider turn 的终止信号，一个完整 run 内可能出现多次；消费者不能把第一次 `stream_end` 当成 Agent 已完成 (`packages/cli/src/agent/loop/types.ts`)
- 流式预启动同时要求工具在固定只读 allowlist、声明 `isConcurrencySafe` 且前面没有 exclusive barrier；仅把工具标成并发安全不会让它在 Provider 流提交前启动 (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
- 工具副作用前必须先按模型调用顺序提交 durable `tool_call`；required commit 失败时工具根本不启动，不能把返回的失败结果解释为“可能已执行” (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`, `packages/cli/src/agent/loop/conversationPersistence.ts`)
- 工具执行完成后仍要先提交 durable `tool_result` 才能发布给界面或下一次 Provider 请求；该提交失败时副作用可能已发生，loop 以 `tool_persistence_failed` 停止并要求恢复阶段处理不确定性 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/agent/loop/conversationPersistence.ts`, `git:b98a073e`)
- 成功的显式验证证据会在后续 Edit、Write、ApplyPatch 或 NotebookEdit 成功时清空；独立验证的 mutation revision 也同步失效，PASS 不能跨源码修改复用 (`packages/cli/src/agent/loop/completionPolicy.ts`, `packages/cli/src/agent/loop/independentVerification.ts`)
- 非平凡实现门禁只在主 Agent 修改至少 3 个实现文件、触及高风险路径或执行潜在写 Bash 时触发；子代理、禁止委派、exactly-once Task 契约或不可用 Task 工具会跳过这一门禁 (`packages/cli/src/agent/loop/independentVerification.ts`)
- 用户明确要求的 test、lint、type-check、build 是另一道完成门禁；它按请求中的具体类别匹配成功 Bash 命令，运行了任意一种检查并不自动满足全部要求 (`packages/cli/src/agent/loop/completionPolicy.ts`)
- 合法结构化终态只能通过保留的 `StructuredOutput` 工具提交，JSON prose 不算完成；新 steering 或后续 workspace mutation 会清除已接受对象并重置纠正预算 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/services/StructuredOutputService.ts`)
- `StructuredOutput` 恢复同时校验 schema digest 和对象内容；恢复扫描遇到更新的 user message 会停止，旧 schema 或旧输入下的结果不会被误复用 (`packages/cli/src/services/StructuredOutputService.ts`)
- Stop hook 超时或抛错采用保守的“允许停止”结果，而不是无限阻塞完成；只有明确返回 `shouldStop: false` 才注入继续提示并使 Goal 验证失效 (`packages/cli/src/agent/loop/completionPolicy.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- Plan 批准后会先持久化 Session permission mode，再把批准内容包进用户消息并重新进入普通 loop；Plan run 的成功结果本身不是任务执行完成 (`packages/cli/src/agent/Agent.ts`)
- 默认 Agent 已取消固定 100 回合上限，`-1` 表示无限；防止无界循环依靠输出重复、动作停滞、预算与完成门禁，而不是隐含 turn ceiling (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `git:85643629`)

## Architecture
- `ConversationState` 把根系统提示、可压缩 history 和当前 pending 分开；压缩只替换 history，所有退出路径通过 `writeback()` 提交 pending，避免过去的双消息源漂移 (`packages/cli/src/agent/loop/ConversationState.ts`)
- 无工具候选不会直接返回：loop 依次处理 steering、结构化输出、不完整意图、委派/worktree 契约、独立验证、显式验证、Stop hook 和 Goal 验证，调整顺序会改变哪些证据可被后续输入失效 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- 流式工具结果虽然按安全条件并行启动，但 `getRemainingResults()` 始终按 Provider tool-call 顺序收集；durable tool-use 写入也由单独 promise tail 串行化 (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
- `Agent.chatStream()` 在 Session 模式下把一次 run 包在活动操作、顶层任务准入和 durable turn handle 中，并可连续消费 pending follow-up 或 Goal continuation；无 `ChatContext` 的兼容路径只做简单单轮调用 (`packages/cli/src/agent/Agent.ts`)
- Loop 的内容增量是临时展示，成功终态以 durable assistant message 和 turn finalization 为准；结构化输出事件、Goal finalize 与成功返回都发生在最终消息提交之后 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/agent/loop/conversationPersistence.ts`)

## Decisions
- 工具执行从多 stage pipeline 迁移为 flat executor 后，loop 只保留流式调度和领域副作用，权限、Hook、验证与锁由统一 ToolExecutor 负责；新逻辑不应恢复已删除的旧 stage 抽象 (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`, `packages/cli/src/agent/Agent.ts`, `git:e6a1bef4`)
- 独立验证要求 fresh、内置、前台且由宿主严格解析的 verifier verdict，目的是隔离主模型自证和陈旧 PASS；门禁在写操作后按 revision 重新建立 (`packages/cli/src/agent/loop/independentVerification.ts`, `packages/cli/src/agent/subagents/builtinVerificationAgent.ts`, `git:dfa8904c`)
- 系统提示的稳定部分不含 Git 快照和目录列表，并在每个 Provider 边界追加当前 deferred tool 目录，兼顾 Prompt Cache 稳定性与 ToolSearch 后动态 schema 可见性 (`packages/cli/src/agent/loop/providerSystemPrompt.ts`, `packages/cli/src/agent/Agent.ts`, `git:25d5a7d3`)
- `replaceDefault` 只替换基础提示，不能绕过 communication style、受信项目规则、Auto Memory、环境或 append；项目指令还受 Workspace Trust 控制 (`packages/cli/src/prompts/builder.ts`, `packages/cli/src/prompts/projectInstructions.ts`)

## Patterns
- 完成策略函数返回 action descriptor 而不直接执行副作用；loop 负责持久化 assistant/control 消息后再 retry 或 fail，从而让恢复看到相同控制边界 (`packages/cli/src/agent/loop/completionPolicy.ts`, `packages/cli/src/agent/loop/conversationPersistence.ts`)
- 普通文本重复与工具动作停滞使用两套检测器：相同文本连续 3 次触发换策略提示，动作签名连续 8 次提示、16 次终止；`TaskOutput` 的结果进展可打断动作计数 (`packages/cli/src/agent/loop/errorRecovery.ts`, `packages/cli/src/agent/loop/actionStationarity.ts`)
- 完成条件依赖的工具成功、验证命令、修改文件和 verifier verdict 都从结构化 ToolResult metadata 累积，不从模型自然语言声明推断 (`packages/cli/src/agent/loop/completionPolicy.ts`, `packages/cli/src/agent/loop/independentVerification.ts`, `packages/cli/src/agent/loop/toolDomainPolicy.ts`)

## Error Handling & Recovery
- 输出因 token 长度截断时最多恢复 3 次；若预算判定停止或次数耗尽，只有已提交的有效结构化输出可以继续通过完成门禁，否则返回截断失败 (`packages/cli/src/agent/loop/completionPolicy.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- 不完整意图检测只看末尾 200 字符并排除未闭合代码块，代码块且无工具调用也会触发；最多纠正 2 次，避免自然语言模式形成无限重试 (`packages/cli/src/agent/loop/completionPolicy.ts`)
- 工具错误恢复按工具名累计连续失败，3 次后提示改换策略；每 5 回合的自检和 3 次相同模型输出检测是独立机制，不能共享或重置彼此计数 (`packages/cli/src/agent/loop/errorRecovery.ts`)
- Provider fallback 时 `discard()` 会递增 executor epoch 并取消所有活动工具；迟到的旧世代结果即使正常返回也会转换为 abort 结果，不能泄漏进新模型回合 (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
