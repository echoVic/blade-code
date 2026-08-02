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

- 后台 Bash 在启动时绑定当前 session。`TaskOutput`、`KillShell` 和 `/tasks` 只能读取或操作该 session 的 shell；对其他 session 的 ID 按不存在处理。
- `SessionRuntime.dispose()` 会等待当前 session 的所有后台 shell 进程树完成回收，不影响其他活跃 session。
- 后台 agent 会话保留在 session store 中，允许同一 parent session 跨 CLI 进程读取和恢复。列举、输出、恢复和清理都按 `parentSessionId` 隔离。
- 缺失 session 上下文时，后台 Bash 和后台 agent 启动会 fail closed，不会退化为全局可见任务。

## 验证

`packages/cli/tests/integration/process-tree-lifecycle.test.ts` 会启动一个父进程和一个忽略 `SIGTERM` 的后代，验证父进程获得优雅清理机会、后代最终被强制回收，并且 API 只在回收完成后返回。

生产资格门禁还会要求 `deepseek-v4-flash` 和 `deepseek-v4-pro` 通过两条真实 CLI 进程轨迹：

- 模型触发一个必然超时的 Bash 进程树，收到结构化 `timeout_error` 后继续使用 Write 工具完成恢复任务，同时验证没有后代进程遗留；
- 模型启动后台 Bash 但不主动终止，正常结束 headless 会话，然后验证 session dispose 已等待整棵进程树回收。
