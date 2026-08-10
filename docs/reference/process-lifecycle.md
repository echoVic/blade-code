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
- trusted+YOLO Session 的 post-edit `type-check` 自动验证。
- Session 私有 LSP server 的 startup、request、shutdown、crash restart 和 dispose。

PTY terminal 和只启动单个固定二进制的内部查询工具使用各自的生命周期协议，不属于这一 ChildProcess 包装器的覆盖范围。

## Session 所有权

- 同一项目中的同一 session 同时只能由一个 `SessionRuntime` 持有。运行时使用原子创建的 session lease 阻止第二个 CLI、TUI、ACP 或 server runtime 向同一 JSONL 父链并发写入。
- Session archive 会按稳定 ID 顺序获取根及全部 fork/subagent 后代的 lease；任一 owner
  或 queued/running 后代都会使操作零写入失败。归档后所有 Runtime 入口在恢复资源前
  fail closed，详见 [Durable Session Archive](session-archive.md)。
- 活 owner 存在时创建 runtime 会 fail closed，并返回 `BLADE_SESSION_IN_USE`；被拒绝的输入不会写入 transcript，也不会发起模型请求。
- runtime 初始化失败或 `dispose()` 完成时只释放 owner token 与自身匹配的 lease。进程异常退出留下的 lease 会在确认 PID 已不存在后由下一 owner 回收。
- 后台 Bash 在启动时绑定当前 session。`WriteStdin`、`TaskOutput`、`KillShell` 和 `/tasks` 只能读取或操作该 session 的 shell；对其他 session 的 ID 按不存在处理。
- 后台 Bash 的 stdin 由 runtime 持有。`WriteStdin` 等待写入回调并处理 pipe error；`close_stdin=true` 显式发送 EOF。进程已经退出、stdin 已关闭或缺失 session 时 fail closed。
- 每个后台 Bash 的 stdout 和 stderr 分别只保留自上次 `TaskOutput` 消费以来最近 1 MiB 的原始字节，持续输出不会让 runtime 内存无界增长。被丢弃的更早输出按 stream 累计字节数，保留内容从合法 UTF-8 边界开始。
- `TaskOutput` 会在 1 MiB 运行时边界之上再次按命令类型限制模型和事件表面的文本（3,000-20,000 字符，默认 15,000），保留头尾并返回 `output_truncated`、`stdout_omitted_bytes`、`stderr_omitted_bytes` 和 `truncation_info`。TUI、headless、Web SSE 与 ACP 使用同一结果和展示摘要。
- `SessionRuntime.dispose()` 会等待当前 session 的所有后台 shell 进程树完成回收，不影响其他活跃 session。
- post-edit 自动验证使用 Session 私有队列和冻结环境。只有显式通过 Workspace Trust
  且处于 `yolo` 的本地 Session 才能执行项目 `type-check` script；turn abort、
  timeout 或 runtime dispose 都会终止并等待其 owned process tree。ACP、未信任项目、
  `default`/`autoEdit` 和未声明 script 的项目零执行。
- LSP server 使用同一冻结环境与 owned process tree。每个 Session 独占连接；
  `shutdown` / `exit` 超时后升级为进程树终止。Web task、TUI、headless、Task/Team
  child 和异常初始化都必须等待自己的 LSP PID 回收。
- foreground 与后台 agent 都会写入 durable sidecar。sidecar 通过原子 rename、
  `fsync` 和 `0600` 文件权限提交，存储目录使用 `0700`；公开 API 不返回 prompt、
  messages、配置快照、workspace 或 owner PID。
- agent 的列举、输出、恢复和清理按 `parent sessionId + canonical projectPath`
  复合身份隔离。相同 parent ID 在不同 workspace 中不能读取或恢复彼此的 agent。
- running sidecar 记录 owner PID。新 Blade 进程只会把 PID 已退出的记录立即标记为
  orphan；没有 PID 的 legacy sidecar 保留 30 分钟兼容窗口，不会误伤另一个仍存活
  进程中的 agent。
- 每次 resume 创建新的不可变 child ID，并记录 `rootAgentId`、`resumedFrom` 和
  `resumeDepth`。child 继承源 transcript 和冻结的模型、权限、工具、系统提示与隔离
  配置；worktree lease 继续由原 owner ID 管理，不会被 child ID 错误接管。
- 直接从 TUI、Web 或 ACP 恢复 subagent 只允许在 parent turn idle 且 durable input
  队列为空时执行；模型在自己的活动 turn 中调用 Task `resume_from` 仍走同一持久化和
  owner 校验。
- 缺失 session 上下文时，后台 Bash 和后台 agent 启动会 fail closed，不会退化为全局可见任务。

## Transcript 提交与恢复

- session transcript 使用逐行 JSONL，换行符是单条事件的提交边界。加载时只允许忽略最后一个未换行且无法解析的尾片段，它代表进程在 append 过程中退出；任何已换行的坏记录或中间损坏都会 fail closed。
- 同一进程中的 transcript append 按文件串行。首次恢复写入前会检查文件尾：完整 JSON 记录只缺换行时补齐换行，无法解析的 crash tail 则截回最后一个已提交边界，再追加新事件。
- `SessionService`、`PersistentStore` 和 runtime resume 使用同一解析语义，避免会话列表可见但 CLI 无法恢复，或读取时跳过坏行而后续写入继续污染历史。
- user-turn rewind 不截断 transcript，而是追加 `session_rewound` marker。resume、
  catalog、fork、search 和 ContextManager 通过同一 projector 累积计算有效历史，
  被回退的原始事件保留用于审计但不会重新进入模型或 UI。
- conversation rewind 以 user-authored durable message ID 为边界，移除该回合及之后的
  message/tool/compaction events；session metadata 与 lineage 不受影响。
- code rewind 只接受每个文件的连续 snapshot 后缀。执行前检查所有文件的写后 hash
  与 backup 完整性，任一文件被外部修改时整组拒绝，不产生 rewind marker。
- snapshot manifest 使用 canonical workspace hash 和 session ID 共同分区。同 ID
  的不同 workspace 不共享快照；旧版未分区 manifest 只有在全部文件都属于当前
  workspace 时才会原子迁移，混合或不匹配 manifest 保持 fail closed。
- rewind 必须由 session-owned Runtime 执行。活动 turn、durable pending input、
  运行中的后台 shell 或后台 agent 都会阻止 rewind，避免恢复过程与写操作竞态。

## 验证

`packages/cli/tests/integration/process-tree-lifecycle.test.ts` 会启动一个父进程和一个忽略 `SIGTERM` 的后代，验证父进程获得优雅清理机会、后代最终被强制回收，并且 API 只在回收完成后返回。

生产资格门禁还会要求 `deepseek-v4-flash` 和 `deepseek-v4-pro` 通过以下真实 CLI 进程轨迹：

- 模型触发一个必然超时的 Bash 进程树，收到结构化 `timeout_error` 后继续使用 Write 工具完成恢复任务，同时验证没有后代进程遗留；
- 模型启动后台 Bash 但不主动终止，正常结束 headless 会话，然后验证 session dispose 已等待整棵进程树回收。
- 模型在 TUI、Web 和 ACP 中启动等待输入的后台 Bash，读取动态 `shell_id`，通过 `WriteStdin` 写入并关闭 stdin，再由 `TaskOutput` 等待退出；Flash 和 Pro 都必须产生正确宿主文件且三个工具事件完整可见。
- 模型在 TUI、Web 和 ACP 中启动产生超过 1 MiB 输出的后台 Bash，再由 `TaskOutput` 验证尾部标记、结构化省略字节数和共享展示摘要；Flash 和 Pro 都必须在截断后继续完成宿主文件写入。
- 首个 CLI 在工具执行期间持有 session，第二个同 session CLI 必须返回结构化占用错误且不写入输入；首个 CLI 退出后，第三个 CLI 必须恢复该 session 并完成写入与 Bash 验证。
- 在完整 session 尾部注入未换行的截断 JSON 记录，第二个 CLI 必须恢复原有历史、完成 Write/Bash 任务，并使最终 transcript 的每一行重新成为合法 JSON。
