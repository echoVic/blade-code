# Runtime 协调关闭

Blade Code 把关闭过程视为 Runtime 所有权边界，而不是直接终止进程。TUI、Web、
Headless 与 ACP 都遵守同一顺序：

```text
关闭新工作入口
  -> 中止 active work
  -> 等待 terminal persistence
  -> 释放 Session 资源
  -> 停止 transport 与进程服务
```

## Agent barrier

每个 Agent 持有一个 active-operation gate。`chatStream()` 在 task admission 前取得
lease，并将组合后的 `AbortSignal` 传入 Provider streaming、工具、compaction、hooks
和 turn finalization。

`Agent.destroy()` 执行以下步骤：

1. 同步拒绝新的 Agent operation；
2. 以 `agent-destroy` 中止所有 active lease；
3. 等待 generator `finally` 和现有 `SessionRuntime.finishTurn()` 完成；
4. 断开 Agent-owned MCP；
5. 释放 ToolExecutor。

正常 shutdown 复用现有 `turn_aborted(cause="cancelled")`，不增加新的 JSONL event。
Durable inbox 在 aborted turn 后保持可恢复；后续 `--resume`、TUI、Web 或 ACP
`session/load` 可以继续原始输入。

## TUI 与 Headless

TUI 的进程级 shutdown 会先同步调用 active command 的 abort controller，再执行
React/Agent cleanup。这样即使终端宿主在信号后开始卸载 UI，Agent generator 仍能先提交
terminal turn record。

Headless 继续由 invocation-local signal owner 控制：收到 `SIGINT` 或 `SIGTERM` 后取消
当前 turn，等待输出 drain 和 Runtime disposal，再以中断状态返回。Headless 不依赖
进程级 UI cleanup。

## Web 与 serve

`blade web` 和 `blade serve` 在监听成功后立即注册 server cleanup。关闭开始后：

- message、task dispatch/retry/delivery、user shell、code review 和 durable resume
  不再接纳新工作；
- HTTP mutation 返回 `503 SERVICE_UNAVAILABLE`；
- active Agent run、user shell 与 review 收到 abort；
- 已观察到的 completion Promise 全部 settle 后才释放 Runtime；
- Runtime initialization、Runtime disposal 与 shared MCP cleanup 全部完成后才清空
  Session route owner；
- task scheduler、stale-session GC 和网络监听最后停止。

只关闭浏览器页、SSE viewer 或其他 subscriber 不会触发该流程。Viewer ownership 与
server-owned Agent run 继续分离；只有 server/process shutdown 才关闭 run admission。

## ACP

`AcpSession.destroy()` 同时持有 prompt 和 user-shell completion barrier：

1. 标记 Session closing 并关闭 update egress；
2. 中止 prompt 与 user shell；
3. 等待二者完成最终 ACP/Runtime bookkeeping；
4. 等待 `Agent.destroy()`；
5. 释放 SessionRuntime 与 ACP service context。

同一 Session 或 BladeAgent 的并发 destroy 调用共享一个 Promise。stdio ACP connection
自然关闭、宿主信号和进程 cleanup 最终都进入同一个 BladeAgent owner。

## 有界失败

进程级 graceful shutdown 由 5 秒 hard failsafe 覆盖。正常路径按以下顺序执行：

```text
active command abort
  -> 已注册 Runtime/server cleanup
  -> SessionEnd hooks
  -> logger shutdown
  -> terminal restore
  -> process exit
```

Runtime cleanup phase 使用独立的 4 秒预算；成功后 hard/phase timer 会被清除。若
Provider、工具或宿主 transport 无法在预算内 settle，进程由 hard failsafe 终止，现有
`process_restart` 冷恢复协议继续作为最终权威。Graceful abort 与冷恢复不能为同一 turn
产生两条 terminal record。

## 验证边界

确定性测试覆盖 operation admission、abort reason、idle barrier、并发 destroy、
ACP prompt/user-shell settle、Web closing `503`、run completion 与 Runtime dispose
顺序、cleanup failure isolation、logger 顺序和 timer 清理。

发布阻断真实 API 固定运行 DeepSeek Flash/Pro × Headless、真实 ACP stdio、
raw PTY TUI 与 production Chromium Web GUI 八格矩阵。每格都在真实前台 Bash 活跃后
发送生产 `SIGTERM`，并验证 durable abort、恢复 turn、进程树/lease/port/transport
回收、延迟副作用对照和 Provider credential absence。
