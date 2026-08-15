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

## 有界 admission

ToolExecutor 在真正进入外部 invocation 前同时取得四类 permit：

```text
Session total
Session kind
process total
process kind
```

生产默认值全部有限：

| 范围 | total | readonly | write | execute | pending |
| --- | ---: | ---: | ---: | ---: | ---: |
| 全进程 | 32 | 24 | 8 | 3 | 256 |
| 单 Session | 10 | 8 | 4 | 2 | 64 |

等待 permit 的最终期限为 180 秒。单 Session 的 execute 上限 2，确保一个 Session
不能占满三个全局 Bash slot；另一个 Session 即使在前者已有排队项时，也能立即使用
剩余的全局容量。

validation、workspace isolation、hooks、permission resolution 与人工审批发生在 scarce
permit 之前。等待用户确认不会长期占用全局工具执行容量。permit 从 invocation 启动
持有到 Promise settle；成功、失败、throw、timeout 与 cancellation 都只释放一次。

### 后台 Shell admission

前台 Bash 自动交接和显式后台 Bash 在工具 permit 之外使用独立有限容量：

| 范围 | active background shells |
| --- | ---: |
| 全进程 | 16 |
| 单 Session | 4 |

hidden foreground candidate 在 spawn 前就计入该容量，避免多个并发 handoff 穿透上限。
自然退出、spawn/release 失败、timeout、abort、KillShell 和 Session dispose 都只释放
一次。显式后台 overflow 在用户命令启动前返回
`resource_exhausted/background_shell_busy`；自动 handoff overflow 保留原 foreground
所有权，不重启命令。前台工具 permit 只在 handoff identity 提交后释放，background
capacity 则持有到进程/ACP terminal 终态。

## 内置工具策略

- Read、Glob、Grep 和其他纯读工具为 `shared`，并可在显式 allowlist 中流式预启动。
- Write、Edit 和 NotebookEdit 为 `shared`，但同一路径通过全局
  `FileLockManager` 串行；不同路径可以并行。
- Bash 为 `shared`，同时受 Session execute=2 与全进程 execute=3 约束。
- Task 为 `shared`；每次调用拥有独立 durable child session。可能修改代码的并行
  child 仍必须使用 `isolation: "worktree"`。
- 计划切换、配置修改、用户提问等共享状态操作保持 `exclusive`。

## Session 公平性

pending work 在每个 Session 内保持到达顺序，scheduler 在 Session 之间 round-robin：

1. 每次 drain 先考虑每个 Session 的第一项工作；
2. 每轮最多从一个 eligible Session 接纳一项，再移动到下一个 Session；
3. 被本地 total/kind 上限阻塞的 Session 不能阻塞其他 eligible Session；
4. abort、deadline 或 owner dispose 移除队列项后立即重新 drain；
5. 工具结果仍按原始 Provider tool-call 顺序投影，不按完成顺序写回模型。

`ownerId` 与 `sessionId` 分离：`sessionId` 决定公平性和本地容量，`ownerId` 只用于
ToolExecutor dispose 时删除自己保留的 queue entry。同一 Session 的另一个 executor
不会被连带取消。

## 流式提交边界

纯读 allowlist 工具可在完整模型响应到达前启动。非预启动工具必须等 provider 流
成功结束后才批量派发，避免 fallback 或不完整响应重放副作用。

如果一个 exclusive 工具已经在流中排队，后续读工具也进入队列，防止读取越过写入
屏障。fallback 会递增 executor epoch、中止旧世代调用并丢弃其结果。

每个 Provider response 最多接纳 64 个 function tool calls。第 65 项及之后返回
`resource_exhausted/tool_batch_full`，不进入 gate、permission、durable tool-use
preflight 或 scheduler；每个 Provider tool-call ID 仍获得一个完整结果。fallback
与 discard 会重置下一世代的 64 项预算。

streaming 与 non-streaming 路径只串行 durable tool-use commit，不串行外部工具执行。
因此 JSONL call part、result part、resume history 与 surface 结果保持 Provider 顺序，
不同工具在各自 identity 落盘后仍可并行运行。

## 结果与取消

- 需要用户确认的工具按 ToolExecutor 串行审批，防止 Web/TUI/ACP 同时出现多个交互；
  获批后的 shared 工具仍可并行执行。
- 工具可以按完成时间乱序结束，但 durable call/result、模型历史和前端事件保持原
  tool-call 顺序。
- 等待 gate 的调用收到 abort 后立即返回 `abortedBeforeLaunch`，不会等待前序长任务。
- scheduler queue overflow 和 wait timeout 返回可重试的
  `resource_exhausted/tool_busy`，metadata 包含
  `reason/scope/kind/limit/retryable`；工具没有启动，也不执行 PostToolUseFailure hook。
- queued progress 使用 `Waiting for tool execution capacity`，并携带 scope、kind、
  queue position、当前 in-flight 与实际约束 limit。Headless JSONL 使用 snake_case，
  TUI/Web 内存投影使用 camelCase，ACP 使用标准 `tool_call_update`。
- `ToolConcurrencyGate` 最多保留 64 个 pending call。close 会清理全部 waiter listener
  并拒绝后续调用；active invocation 由其所属 turn AbortSignal 管理。
- 单个工具失败不会抹掉同批其他工具的结果；所有结果都形成完整 tool-call 边界。
- Web 以 child session/tool-call ID 保存多个 subagent 卡片；TUI 使用 keyed progress
  map；ACP 保持独立 `tool_call` ID。

## 资格验证

确定性测试覆盖全部 total/kind/pending 上限、mixed-kind total、三 Session
round-robin、无 head-of-line blocking、queue overflow、deadline、queued abort、
owner dispose、listener/timer cleanup、shared/exclusive gate、同路径锁、64-call
streaming/non-streaming parity、fallback generation reset、ordered durable commit 和
生产 bypass 搜索门禁。

发布阻断真实 API 固定运行 DeepSeek Flash/Pro × Headless、真实 ACP stdio、raw PTY
TUI 与 production Chromium Web GUI 八格矩阵。每格在一个 Provider response 中发出
四个真实 foreground Bash，host 证明初始只启动两项、每释放一项只接纳一个 successor、
峰值为 2、call/result 顺序一致且全部资源回收。

额外的 production Chromium 轨迹同时运行两个 live Session：A 占用两个 execute slot
并排队第三项，B 必须使用剩余全局 slot 并先独立完成。两个 Session 完成后分别 reload，
验证 durable history、SSE/GUI progress、foreground lease、server/browser/port 与凭据
回收。
