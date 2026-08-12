# 子进程生命周期

Blade Code 把自己启动的命令视为一棵 owned process tree。超时、取消、用户终止或应用退出时，调用方必须等待整棵树完成回收后再报告结束。

## 终止协议

- POSIX：子进程以独立进程组启动，先向进程组发送 `SIGTERM`，等待 500ms，再以 `SIGKILL` 清理仍存活的成员。
- Windows：先等待 `taskkill /PID <pid> /T`，等待 500ms，再执行 `taskkill /PID <pid> /T /F`。如果系统命令不可用，则退化为直接终止 child。
- 自然退出：child 的 `close` 或 `error` 事件会释放所有权，之后不会再向旧 PID 发送信号。
- 幂等性：同一进程树的并发终止请求共享一个 Promise，不会重复执行终止序列。
- 安全边界：PID 0、PID 1 和 Blade 自身 PID 不会被当作 POSIX 进程组广播目标。

统一终止实现位于 `packages/cli/src/utils/process/OwnedProcessTree.ts`。Session-owned
用户命令还必须使用 `CommandAdmissionGate` 与 durable process lease，不能只依赖
`spawnOwnedProcess()` 的进程内句柄，也不要自行组合 `child.kill()` 和定时器。

## 已接入入口

- 前台 Bash 的 admission、timeout、abort 和进程硬崩溃恢复；
- 后台 Bash 的单任务终止和应用退出清理；
- ACP 本地 terminal fallback 的 admission、timeout、abort 和进程硬崩溃恢复；
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
- 本地前台 Bash 和 ACP local terminal fallback 先启动不执行用户命令的 detached gate，
  写入并 fsync `.foreground-processes` lease 后才通过 pipe release command。lease 或
  release write 失败时等待整棵 gate tree 回收后返回结构化错误，用户命令零执行。gate
  同时监听 owner pipe；owner 硬退出后会主动终止 attached command，下一 Runtime 的
  identity-checked reaper 覆盖 wrapper 同时退出或未完成清理的窗口。
- foreground lease 仅包含 session/process identity、owner/root PID、平台启动身份和
  时间，使用 `0600` 文件、`0700` 目录和 atomic write + fsync；不包含命令、cwd、env、
  stdout/stderr 或凭据。自然退出、spawn error、timeout 和 abort 都会删除 lease。
- 新 Runtime 取得 Session lease 后先依次回收 foreground、background orphan process，
  再恢复 workspace patch transaction、subagent 和其他 Runtime 资源。只有 owner 已退出
  且 root PID 启动身份仍匹配时才发送 TERM/KILL；PID reuse、损坏或超限 sidecar 均
  fail closed。orphan subagent reconciliation 在取得 child Session lease 后执行同一组
  reaper，再修复 child turn/tool receipt。ACP 客户端真正创建的 remote terminal 继续
  由客户端 terminal handle 所有，本地 lease 只用于 ACP local fallback。
- 后台 Bash 在启动时绑定当前 session。`WriteStdin`、`TaskOutput`、`KillShell` 和 `/tasks` 只能读取或操作该 session 的 shell；对其他 session 的 ID 按不存在处理。
- 后台 Bash 的 stdin 由 runtime 持有。`WriteStdin` 等待写入回调并处理 pipe error；`close_stdin=true` 显式发送 EOF。进程已经退出、stdin 已关闭或缺失 session 时 fail closed。
- 后台 Bash 先启动一个不执行用户命令的 detached gate wrapper，写入并 fsync durable
  shell lease 后，再等待 gate release byte 的 pipe write callback 成功，才返回 tool
  result 并放行实际 executable；lease 或 gate write 失败时用户命令零执行。lease 仅包含
  session/shell identity、owner/root PID、平台启动身份和时间；不包含命令、cwd、env 或输出。新
  Runtime 获取 Session lease 后先执行 orphan reaper：只有 owner 身份已退出且 root PID
  启动身份仍匹配时才终止 process group/tree。TERM grace period 后、发送强制信号前会
  再次校验 ownership。PID 已复用或身份不可验证时绝不发送信号；损坏或超限 lease 会
  fail closed 并阻止 session 恢复。
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
- running sidecar 记录 owner PID 和平台进程启动身份；Session lease 使用同一身份校验。
  新 Blade 进程只有在 owner 已退出或 PID 身份变化，并成功取得 child lease 后才恢复
  orphan；没有身份的 legacy 记录继续按 PID 保守判断，没有 PID 的近期 sidecar 保留
  30 分钟兼容窗口。
- orphan child 恢复先执行 durable turn/tool crash receipt，再从 child JSONL 重建当前 run
  的 model context，并与 sidecar 已继承的 source history 做 suffix/prefix 合并。只有
  `turn_completed` 且当前 run 有最终 assistant 文本时恢复 completed；其余记录为
  interrupted failed，可用新的 immutable child ID resume。损坏 JSONL 写 recovery-failed
  receipt 并禁止 resume，但不阻断 parent Session。
- crash reconciliation 复用正常 worktree finalize：interrupted 或含改动 worktree 保留，
  completed clean worktree 删除；旧进程已删除的 worktree lease 会从 sidecar 清除。
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
- 每个 Session turn 在模型执行前提交 `turn_started`；正常完成提交
  `turn_completed`，失败、取消、stream 提前关闭或进程恢复提交 `turn_aborted`。终态记录
  turn ID、cause 与 turns/tool-calls/duration 指标，不包含用户 prompt 或 provider
  错误正文。
- turn start 与 terminal append 在 transcript 文件锁内校验：同一事件可幂等重试，
  不同 ID 的第二个 active turn fail closed。新 Runtime 只有在取得 `SessionLease`
  并确认旧 owner 已释放后，才会把未闭合 turn 标记为 `process_restart`。
- 工具执行必须先提交 durable `tool_call`；CLI/TUI、Web、ACP、Headless 以及 streaming
  prelaunch/queued 路径在该提交失败时统一阻止工具启动，不允许无 journal 的文件、
  shell 或外部副作用继续执行。执行抛错、取消和 epoch discard 始终保留原 durable
  tool-call ID，使失败结果精确闭合对应调用。
- 工具执行完成后必须先 durable commit 对应 `tool_result`，才能把结果发布给
  CLI/TUI、Web、ACP、Headless、写入下一轮 Provider context 或应用领域投影。result
  commit 失败统一返回 `tool_persistence_failed` 并停止本次 run；不会发起下一次
  Provider 请求，也不会继续执行由该结果驱动的工作。此时副作用可能已经发生，durable
  call 保持 orphan，交由下一 Runtime 的 `sideEffectsUncertain` receipt 修复。
- 每个模型可见 user/control input 必须在 Provider 请求前 durable commit；每个非空
  assistant step 必须在下一次 Provider 请求、`structured_output` 发布、Goal finalize
  或成功 terminal 前 durable commit。失败时返回 canonical
  `message_persistence_failed`，从 JSONL model-context projection 重建当前 Runtime
  内存并清除未提交消息。streaming delta 可以先作为临时进度显示，但不构成成功或恢复
  证据；失败 turn 不确认 inbox，冷启动会优先重新执行该 durable input。
- 最终 assistant message 同批携带有界 `turnFinalization` receipt，只记录 turn ID、
  本 turn 已 claim 的 inbox IDs 和 turns/tool-calls/duration 指标。正常成功路径把这些
  inbox IDs 的 `inbox_acknowledged` 与 `turn_completed` 作为一个 validated batch fsync，
  成功后才更新 mailbox sidecar。若进程在 receipt 后、terminal batch 前退出，新 Runtime
  在确认没有 orphan tool call 后提交相同完成 batch 并重载 sidecar；已完成输入不会重放，
  receipt 未列出的 late follow-up 不会被误确认。
- 新 Runtime 取得 Session lease 后，会在同一个 validated batch 中修复 materialized
  transcript 的 orphan tool calls。每个 orphan 先获得 synthetic error
  `tool_result`，明确标记 `processRestartRecovery` 与 `sideEffectsUncertain`，随后 active
  turn 才提交 `turn_aborted(process_restart)`；已终止 turn 遗留的 orphan 同样会修复。
  重复恢复不会重复写 receipt。存在 pending durable interaction 的调用由专用问答/权限
  recovery 接管，不会被通用 crash receipt 提前关闭。
- `SessionEventLog` 将 durable turn 事件按 seq 发布为 `committed.turn_*`。Web SSE
  断点续传可据此恢复 running/idle 状态；CLI/TUI、Web、ACP 与 Headless 共享相同
  JSONL 生命周期，不维护各自独立的终态。
- Web Session SSE 由 Zustand Session Store 的导航事务持有，而不是由 `ChatView`
  组件持有。`selectSession` 先等待 history 与新订阅同时 ready，再原子提交 Session
  状态并替换旧连接；只有切换到临时会话、删除/归档当前 Session、取消或显式终止时
  才关闭 active subscription。React StrictMode 的 effect replay、Suspense 或 view
  remount 不得关闭 Store 已提交的连接。
- Provider 请求重试只允许发生在首个真实 stream chunk 进入 Agent loop 之前。内容、
  thinking、usage 或完整 tool call 一旦向上游 surface 发布，后续 transport/stream
  故障必须 fail closed，不能重放请求或重复工具副作用。stream idle watchdog 超时同样
  不自动重试，避免长时间静默后形成重叠请求或 retry storm。
- Blade 关闭 pi-ai/Provider SDK 的内部自动重试，由单一 runtime policy 处理
  `408`、`409`、`429`、`5xx`、网络故障和首 chunk 前的 stream close。策略优先遵守
  `retry-after-ms` / `Retry-After`，否则使用带 jitter 的指数退避；单次等待最多
  60 秒，全部 sleep 都响应 turn `AbortSignal`。quota/billing、context overflow、
  caller abort 和显式 `x-should-retry: false` 立即失败。
- Retry lifecycle 通过统一的 `provider_retry` LoopEvent 投影
  `scheduled → attempt → recovered|exhausted`。事件只包含 attempt、max retries、
  bounded delay、分类原因和可选 HTTP status，不包含 Provider response body、原始
  headers、URL 或 credential。TUI loading、Web StatusBar、ACP
  `session_info_update._meta["blade/providerRetry"]`、Headless JSONL 和 subagent SSE
  消费同一协议；元事件不计为内容 chunk，不触发 stream commit 或工具执行。
- 每次 Provider stream read 同时受 stall warning 和 hard idle timeout 约束。warning
  默认为 30 秒，并在较短 hard timeout 下收窄到其一半；runtime 始终保留同一个 pending
  `iterator.next()`，不能因为 warning 启动重叠读取或第二个请求。超过 warning 产生
  `provider_stall: detected`，下一 Provider event 到达后产生 `recovered`；事件包含
  bounded duration、warning/hard deadline、stall count 和 `outputStarted`，不包含
  Provider payload。stall 元事件与 retry 元事件一样不计入 replay boundary、内容
  chunk、stream commit 或工具执行，并统一投影到 TUI、Web、ACP、Headless 与
  subagent SSE。hard timeout、caller abort 和部分输出后的故障仍 fail closed。
- 自动压缩分为预测式 threshold compaction 与反应式 context-limit recovery。Provider
  返回 `413`、`context_length_exceeded`、`prompt_too_long` 等上下文错误时，runtime
  只允许在零真实输出边界内执行一次 reactive compaction；任意 content、thinking、
  usage 或 tool call 已出现时拒绝重放，第二次仍超限时也直接失败，不能形成无限压缩
  循环。
- compaction 在重试 Provider 前必须先原子提交 exact replacement context。JSONL
  summary part 保存有界 `replacementMessages` checkpoint、reason、strategy 和
  pre/post tokens；提交失败不应用内存替换，也不重试 Provider。完整可见 transcript
  继续保留用于 UI、导出和审计，`SessionService.loadSessionModelContext()` 只从最新
  checkpoint 加载 replacement context 与其后的事件；旧版无 replacement 的摘要以
  summary-only 投影安全降级。
- `compaction` LoopEvent 统一携带 `threshold|context_limit|turn_limit` reason、
  `llm|fallback|snip` strategy 和 `completed|fallback|failed` outcome。Web 在 reactive
  recovery 显示独立的 context-limit 状态；TUI、Headless JSONL、Server SSE 与 ACP
  `session_info_update._meta["blade/compaction"]` 使用同一生命周期，不把内部摘要或
  Provider 错误正文写入 assistant 内容。
- user-turn rewind 不截断 transcript，而是追加 `session_rewound` marker。resume、
  catalog、fork、search 和 ContextManager 通过同一 projector 累积计算有效历史，
  被回退的原始事件保留用于审计但不会重新进入模型或 UI。
- conversation rewind 以 user-authored durable message ID 为边界，移除该回合及之后的
  message/tool/compaction 事件及对应 turn 生命周期；session metadata 与 lineage
  不受影响。
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
- parent 和 subagent 分别启动含延迟副作用的前台 Bash，宿主在 tool result 前硬杀
  Blade owner；新 Runtime 必须在各自 Session lease 临界区回收 identity-matched
  process tree、闭合 orphan tool receipt，并证明 sidecar 不含命令、环境、输出或 API key；
- 模型启动后台 Bash 但不主动终止，正常结束 headless 会话，然后验证 session dispose 已等待整棵进程树回收。
- 模型在 TUI、Web 和 ACP 中启动等待输入的后台 Bash，读取动态 `shell_id`，通过 `WriteStdin` 写入并关闭 stdin，再由 `TaskOutput` 等待退出；Flash 和 Pro 都必须产生正确宿主文件且三个工具事件完整可见。
- 模型在 TUI、Web 和 ACP 中启动产生超过 1 MiB 输出的后台 Bash，再由 `TaskOutput` 验证尾部标记、结构化省略字节数和共享展示摘要；Flash 和 Pro 都必须在截断后继续完成宿主文件写入。
- 首个 CLI 在工具执行期间持有 session，第二个同 session CLI 必须返回结构化占用错误且不写入输入；首个 CLI 退出后，第三个 CLI 必须恢复该 session 并完成写入与 Bash 验证。
- 在完整 session 尾部注入未换行的截断 JSON 记录，第二个 CLI 必须恢复原有历史、完成 Write/Bash 任务，并使最终 transcript 的每一行重新成为合法 JSON。
