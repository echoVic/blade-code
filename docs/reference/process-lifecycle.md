# 子进程生命周期

Blade Code 把自己启动的命令视为一棵 owned process tree。超时、取消、用户终止或应用退出时，调用方必须等待整棵树完成回收后再报告结束。

## 终止协议

- POSIX：子进程以独立进程组启动，先向进程组发送 `SIGTERM`，等待 500ms，再以 `SIGKILL` 清理仍存活的成员。
- Windows：先等待 `taskkill /PID <pid> /T`，等待 500ms，再执行 `taskkill /PID <pid> /T /F`。如果系统命令不可用，则退化为直接终止 child。
- 自然退出：child 的 `close` 或 `error` 事件会释放所有权，之后不会再向旧 PID 发送信号。
- 幂等性：同一进程树的并发终止请求共享一个 Promise，不会重复执行终止序列。
- 安全边界：PID 0、PID 1 和 Blade 自身 PID 不会被当作 POSIX 进程组广播目标。

统一实现位于 `packages/cli/src/utils/process/OwnedProcessTree.ts`。需要执行任意用户命令的入口应使用 `spawnOwnedProcess()`，不要自行组合 `child.kill()` 和定时器。

## 已接入入口

- 前台 Bash 的 timeout 和 abort；
- 后台 Bash 的单任务终止和应用退出清理；
- ACP 本地 terminal fallback 的 timeout 和 abort；
- command hook 的 timeout、abort 和输入写入失败。

PTY terminal 和只启动单个固定二进制的内部查询工具使用各自的生命周期协议，不属于这一 ChildProcess 包装器的覆盖范围。

## Session 所有权

- 同一项目中的同一 session 同时只能由一个 `SessionRuntime` 持有。运行时使用原子创建的 session lease 阻止第二个 CLI、TUI、ACP 或 server runtime 向同一 JSONL 父链并发写入。
- 活 owner 存在时创建 runtime 会 fail closed，并返回 `BLADE_SESSION_IN_USE`；被拒绝的输入不会写入 transcript，也不会发起模型请求。
- runtime 初始化失败或 `dispose()` 完成时只释放 owner token 与自身匹配的 lease。进程异常退出留下的 lease 会在确认 PID 已不存在后由下一 owner 回收。
- 后台 Bash 在启动时绑定当前 session。`TaskOutput`、`KillShell` 和 `/tasks` 只能读取或操作该 session 的 shell；对其他 session 的 ID 按不存在处理。
- `SessionRuntime.dispose()` 会等待当前 session 的所有后台 shell 进程树完成回收，不影响其他活跃 session。
- 后台 agent 会话保留在 session store 中，允许同一 parent session 跨 CLI 进程读取和恢复。列举、输出、恢复和清理都按 `parentSessionId` 隔离。
- 缺失 session 上下文时，后台 Bash 和后台 agent 启动会 fail closed，不会退化为全局可见任务。

## Transcript 提交与恢复

- session transcript 使用逐行 JSONL，换行符是单条事件的提交边界。加载时只允许忽略最后一个未换行且无法解析的尾片段，它代表进程在 append 过程中退出；任何已换行的坏记录或中间损坏都会 fail closed。
- 同一进程中的 transcript append 按文件串行。首次恢复写入前会检查文件尾：完整 JSON 记录只缺换行时补齐换行，无法解析的 crash tail 则截回最后一个已提交边界，再追加新事件。
- `SessionService`、`PersistentStore` 和 runtime resume 使用同一解析语义，避免会话列表可见但 CLI 无法恢复，或读取时跳过坏行而后续写入继续污染历史。

## 验证

`packages/cli/tests/integration/process-tree-lifecycle.test.ts` 会启动一个父进程和一个忽略 `SIGTERM` 的后代，验证父进程获得优雅清理机会、后代最终被强制回收，并且 API 只在回收完成后返回。

生产资格门禁还会要求 `deepseek-v4-flash` 和 `deepseek-v4-pro` 通过以下真实 CLI 进程轨迹：

- 模型触发一个必然超时的 Bash 进程树，收到结构化 `timeout_error` 后继续使用 Write 工具完成恢复任务，同时验证没有后代进程遗留；
- 模型启动后台 Bash 但不主动终止，正常结束 headless 会话，然后验证 session dispose 已等待整棵进程树回收。
- 首个 CLI 在工具执行期间持有 session，第二个同 session CLI 必须返回结构化占用错误且不写入输入；首个 CLI 退出后，第三个 CLI 必须恢复该 session 并完成写入与 Bash 验证。
- 在完整 session 尾部注入未换行的截断 JSON 记录，第二个 CLI 必须恢复原有历史、完成 Write/Bash 任务，并使最终 transcript 的每一行重新成为合法 JSON。
