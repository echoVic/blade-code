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

## MCP 目录等待

主循环和侧边提问在进入 Provider 前等待 MCP 目录刷新。取消只结束当前等待者，
不取消其他任务共享的刷新；成功、失败或取消后都会移除等待者的 signal listener，
取消后迟到的刷新失败也会被接收，不产生未处理拒绝。

侧边提问在准备前及上下文准备完成后检查取消，不会把已经取消的请求送入 Provider。
上下文文件读取仍等待自身结束，再释放 Runtime 所有权；本修复不承诺中断任意阻塞的
文件系统调用或 Runtime 初始化。服务器关闭时，目录等待者先退出，随后按原顺序
断开 Session-owned MCP transport。

侧边上下文与系统提示并行准备。一项失败时，保留首个异常，但仍等待已启动的另一项
结束后才释放执行器和会话租约；失败请求不会调用 Provider。真实 Chromium 验证使用
损坏的上下文记录和 FIFO 内存读取，检查读取结束前不返回错误，恢复输入后可继续提问。
FIFO 场景仅在支持命名管道的系统运行，确定性单测另行覆盖两侧失败及迟到失败。

## TUI 与 Headless

TUI 的进程级 shutdown 会先同步调用 active command 的 abort controller，再执行
React/Agent cleanup。这样即使终端宿主在信号后开始卸载 UI，Agent generator 仍能先提交
terminal turn record。

全局 SIGINT 处理仅在 stdin 与 stdout 都属于 TTY 时保留双击退出。任一端重定向时，
首次 SIGINT 直接进入协调关闭，不输出交互提示；ACP 管道因此不必等待第二次信号。
Headless 仍使用下述独立的 invocation-local signal owner。

主任务运行中提问 `/btw` 时，第一次 `Esc` 只取消侧边提问；侧边面板关闭后，下一次
`Esc` 可以停止主任务。重复取消按当前目标去重，不再把侧边请求和主轮次当成同一个
忙碌阶段；替换侧边请求也会重新允许取消。此交互由真实 DeepSeek Flash/Pro raw PTY
验证，并检查主任务中断记录、工具进程回收和后续提问，raw PTY 不等同于桌面 Computer Use。

Headless 继续由 invocation-local signal owner 控制：收到 `SIGINT` 或 `SIGTERM` 后取消
当前 turn，等待输出 drain 和 Runtime disposal，再以中断状态返回。Headless 不依赖
进程级 UI cleanup。

## Web 与 serve

`blade web` 和 `blade serve` 在监听成功后立即注册 server cleanup。关闭开始后：

- message、side question、task dispatch/retry/delivery、user shell、code review 和
  durable resume 不再接纳新工作；
- HTTP mutation 返回 `503 SERVICE_UNAVAILABLE`；
- active Agent run、side question、user shell 与 review 收到 abort；
- 已观察到的 completion Promise 全部 settle 后才释放 Runtime；
- Runtime initialization、Runtime disposal 与 shared MCP cleanup 全部完成后才清空
  Session route owner；
- task scheduler、stale-session GC 和网络监听最后停止。

只关闭浏览器页、SSE viewer 或其他 subscriber 不会触发该流程。Viewer ownership 与
server-owned Agent run 继续分离；只有 server/process shutdown 才关闭 run admission。

Web 侧边对话（`/btw`）随请求存活：关闭侧边面板或断开请求会取消该次提问，服务器
关闭也会立即传递取消信号，而不是先等侧边请求结束再释放 Runtime。已经进入 Runtime
初始化的提问在初始化完成后仍能收到取消；关闭期间的新提问返回 `503`。请求结束后移除
客户端取消监听，后续提问不受影响。侧边对话不创建主任务，也不改写主会话 JSONL；
主任务仍由服务器持有，不因提问取消或提交请求断连而停止。

## ACP

`AcpSession.destroy()` 同时持有 prompt 和 user-shell completion barrier：

1. 标记 Session closing 并关闭 update egress；
2. 中止 prompt 与 user shell；
3. 等待二者完成最终 ACP/Runtime bookkeeping；
4. 等待 `Agent.destroy()`；
5. 释放 SessionRuntime 与 ACP service context。

同一 Session 或 BladeAgent 的并发 destroy 调用共享一个 Promise。stdio ACP connection
自然关闭、宿主信号和进程 cleanup 最终都进入同一个 BladeAgent owner。

退出时仅向真实 TTY stdout 写入键盘、光标与样式复位序列；管道或文件输出不写 ANSI
控制码，避免污染 ACP JSON 流。stdin 的 raw mode 恢复独立保留，cleanup 顺序与预算不变。

ACP `session/cancel` 也会取消等待 MCP 目录的侧边提问，返回 `stopReason="cancelled"`。
独立 stdio 测试验证 Flash/Pro 取消后仍可继续 `/btw`，完整展示文本和主 JSONL 均按契约校验。

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

主运行 shutdown 真实 API 轨迹使用 DeepSeek Flash/Pro，在真实前台 Bash 活跃后发送
生产 `SIGTERM` 或 `SIGINT`，验证 durable abort、恢复 turn、资源回收、延迟副作用和凭据不泄露。
当前 release matrix 运行两种信号 × Headless、真实 ACP stdio 和 production Chromium 十二格；
raw PTY TUI 不计入该门禁，需另行验证，且不等同于原生桌面 Computer Use。

侧边对话另有 DeepSeek Flash/Pro × 关闭面板、服务器 `SIGTERM` 四格 Chromium 验证。
测试先收到真实 Provider 内容，再暂停投递，要求取消在 3 秒内完成；服务器关闭必须出现
正常停止日志，不能仅以退出码为零判定成功。后续提问精确返回预期答案，主 JSONL
字节不变；框架及模型均不重试。主运行活动轨迹另行覆盖浏览器刷新后继续执行。

MCP 目录取消另有 DeepSeek Flash/Pro × 关闭侧边面板、服务器关闭、停止主轮次六格
Chromium 验证：使用真实 stdio MCP transport 暂停目录刷新，要求等待者在 3 秒内结束，
被取消的操作不发 Provider 请求。面板关闭和主轮次停止不会关闭共享 MCP，释放刷新后
可继续真实提问；服务器关闭则验证 MCP 进程被回收。主轮次必须仅提交一条 aborted 终态。
