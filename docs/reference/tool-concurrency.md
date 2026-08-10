# 工具并发模型

Blade 对同一模型响应中的多个工具调用使用统一的批内调度语义。CLI/TUI、Web、
Headless 和 ACP 都经过同一个 `StreamingToolExecutor` 与 `ToolExecutor`，不会因入口
不同而改变执行顺序。

## 两层并发属性

工具有两个正交属性：

- `parallelism: shared | exclusive` 控制批内 gate。连续的 `shared` 工具可以同时
  执行；`exclusive` 工具形成 FIFO 屏障，后续 shared 工具不能越过。
- `isConcurrencySafe` 控制能否在 provider 流提交前预启动，以及是否需要路径锁。
  `false` 不代表整个批次必须串行。

未声明 `parallelism` 的工具保持兼容：`isConcurrencySafe: true` 推导为 `shared`，
其他工具默认为 `exclusive`。

## 内置工具策略

- Read、Glob、Grep 和其他纯读工具为 `shared`，并可在显式 allowlist 中流式预启动。
- Write、Edit 和 NotebookEdit 为 `shared`，但同一路径通过全局
  `FileLockManager` 串行；不同路径可以并行。
- Bash 为 `shared`，同时受进程级 execute bucket 上限约束，默认最多并发 3 个。
- Task 为 `shared`；每次调用拥有独立 durable child session。可能修改代码的并行
  child 仍必须使用 `isolation: "worktree"`。
- 计划切换、配置修改、用户提问等共享状态操作保持 `exclusive`。

## 流式提交边界

纯读 allowlist 工具可在完整模型响应到达前启动。非预启动工具必须等 provider 流
成功结束后才批量派发，避免 fallback 或不完整响应重放副作用。

如果一个 exclusive 工具已经在流中排队，后续读工具也进入队列，防止读取越过写入
屏障。fallback 会递增 executor epoch、中止旧世代调用并丢弃其结果。

## 结果与取消

- 需要用户确认的工具按 ToolExecutor 串行审批，防止 Web/TUI/ACP 同时出现多个交互；
  获批后的 shared 工具仍可并行执行。
- 工具可以按完成时间乱序结束，但写入模型历史和前端事件的结果保持原 tool-call
  顺序。
- 等待 gate 的调用收到 abort 后立即返回 `abortedBeforeLaunch`，不会等待前序长任务。
- 单个工具失败不会抹掉同批其他工具的结果；所有结果都形成完整 tool-call 边界。
- Web 以 child session/tool-call ID 保存多个 subagent 卡片；TUI 使用 keyed progress
  map；ACP 保持独立 `tool_call` ID。

## 资格验证

确定性测试覆盖 shared overlap、exclusive FIFO、公平性、排队取消、同路径锁、
streaming fallback 和结果原序。真实 API 资格要求 GPT 在一个 production stream
中发出两个工具调用，两者必须同时进入执行屏障。Web GUI 还要验证多卡刷新重建、
独立展开和无 console error。
