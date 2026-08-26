---
name: knowledge-shell-process-and-worktree
description: >
  Covers Bash 前后台执行、stdin/终止、输出有界化、进程树与持久租约、Workspace 写沙箱，以及托管 Git worktree 的隔离和交付。
  Navigate when: 排查命令超时/取消/残留进程、后台 Shell、输出截断、ACP terminal、审计沙箱、worktree 创建/恢复/应用/清理。
  Excludes: 通用工具权限和 scheduler（见 ../tool-execution-pipeline/）、文件补丁事务（见 ../filesystem-search-and-atomic-patching/）。
  Keywords: Bash, WriteStdin, KillShell, BackgroundShellManager, DurableProcessLeaseStore, OwnedProcessTree, WorkspaceWriteSandbox, WorktreeManager, foreground handoff.
---

## Module Structure

该节点连接命令执行与 workspace 隔离。Bash 可走本地、ACP 或沙箱路径，并把长前台
命令原进程移交为后台任务；worktree 管理器则将 Session 映射到独立 Git 工作目录并
在交付前验证源工作区没有漂移。

### Directory Layout
- `packages/cli/src/tools/builtin/shell/` — Bash、后台管理、stdin、终止与输出捕获
- `packages/cli/src/context/storage/DurableForegroundProcess.ts` — 前台命令租约与 handoff
- `packages/cli/src/context/storage/DurableProcessLeaseStore.ts` — 可恢复的进程身份租约
- `packages/cli/src/utils/process/` — 启动闸门、进程组拥有权和跨平台终止
- `packages/cli/src/utils/shell/` — 命令归一化、只读审计和验证命令识别
- `packages/cli/src/worktree/WorktreeManager.ts` — worktree 生命周期、diff 制品和变更交付
- `packages/cli/src/tools/builtin/worktree/worktreeTools.ts` — Agent 可调用的进入/退出适配器

### Key Entry Points
- `bashTool` in `packages/cli/src/tools/builtin/shell/bash.ts` — 本地、ACP、后台与自动 handoff 分流
- `BackgroundShellManager` in `packages/cli/src/tools/builtin/shell/BackgroundShellManager.ts` — Session-owned Shell 生命周期
- `prepareForegroundProcess()` in `packages/cli/src/context/storage/DurableForegroundProcess.ts` — 先持久登记再释放命令启动闸门
- `WorktreeManager.enter()` / `apply()` / `exit()` in `packages/cli/src/worktree/WorktreeManager.ts` — 隔离、交付和离开工作树

## Gotchas
- Bash 明确是 `isRetrySafe=false`；即使抛出 `EBUSY/EAGAIN` 也不能自动重放，因为命令可能已经产生外部副作用 (`packages/cli/src/tools/builtin/shell/bash.ts`, `packages/cli/tests/unit/tooling/tools/builtin/bash.test.ts`)
- `Bash` 的 `isConcurrencySafe=false` 但显式 `parallelism='shared'`：独立命令可同批进入，仍受 execute bucket 限流；由于没有 `file_path`，通用 FileLockManager 不会替 Shell 串行工作区写入 (`packages/cli/src/tools/builtin/shell/bash.ts`, `packages/cli/src/tools/execution/ToolExecutor.ts`)
- ACP terminal 执行设置 `allowLocalFallback=false`；远端终端失败必须原样失败，不能在宿主机悄悄重跑同一命令 (`packages/cli/src/tools/builtin/shell/bash.ts`, `git:27f9df37`)
- `WriteStdin` 会产生外部可见输入且默认不可重放，最多接受 64 KiB；ACP 后台终端当前不支持 stdin 写入 (`packages/cli/src/tools/builtin/shell/writeStdin.ts`, `packages/cli/tests/unit/tooling/tools/builtin/write-stdin.test.ts`)
- 前台自动转后台复用原进程，不重启命令；只有存在 Session、超时大于 handoff budget、非只读审计代理且首个命令不是 `sleep` 时才有资格 (`packages/cli/src/tools/builtin/shell/ForegroundCommandHandoff.ts`, `packages/cli/src/tools/builtin/shell/bash.ts`)
- foreground → background 租约提交失败时，前台 owner 仍保持权威并继续等待；不能同时把两个 lease 当作有效所有者 (`packages/cli/src/context/storage/DurableForegroundProcess.ts`, `packages/cli/src/tools/builtin/shell/bash.ts`)
- 后台 Shell ID 绑定 Session；TaskOutput、WriteStdin、KillShell 用其他 Session ID 查询时都按不存在处理，不能跨会话接管 (`packages/cli/src/tools/builtin/shell/BackgroundShellManager.ts`, `packages/cli/src/tools/builtin/task/taskOutput.ts`)
- 本地前后台输出各流只保留最后 1 MiB，随后还会按命令类型二次投影；`stdout_total_bytes`/`omitted_bytes` 才能区分“命令没输出”和“早期输出已丢弃” (`packages/cli/src/tools/builtin/shell/BoundedOutputBuffer.ts`, `packages/cli/src/tools/builtin/shell/ShellOutputProjection.ts`)
- worktree 从 committed `HEAD` 创建，原工作区未提交改动不会复制；返回的 `sourceHadChanges` 是警告，不代表新 worktree 包含这些内容 (`packages/cli/src/worktree/WorktreeManager.ts`, `packages/cli/src/tools/builtin/worktree/worktreeTools.ts`)
- worktree 交付要求源仓库 HEAD 和创建时工作状态指纹都未变化；只检查 patch 可应用而忽略源状态会覆盖任务期间的用户改动 (`packages/cli/src/worktree/WorktreeManager.ts`)
- `ExitWorktree(action='remove')` 在无法验证状态或存在未提交文件/未合并 commit 时拒绝，只有用户明确允许 `discard_changes=true` 才强制删除 (`packages/cli/src/worktree/WorktreeManager.ts`, `packages/cli/src/tools/builtin/worktree/worktreeTools.ts`)
- stale worktree GC 只删除符合托管命名、足够旧、Git 身份一致且无脏文件/未推送 commit 的目录；异常目录和活跃 Session 均保留 (`packages/cli/src/worktree/WorktreeManager.ts`)

## Architecture
- 命令启动经过独立 Node admission gate：目标子进程仅在 lease 持久化后收到启动字节，owner 消失时 gate 负责终止进程组，关闭了“进程已启动但尚未登记”的崩溃窗口 (`packages/cli/src/utils/process/CommandAdmissionGate.ts`, `packages/cli/src/context/storage/DurableForegroundProcess.ts`)
- `DurableProcessLeaseStore` 同时记录 owner 与 root PID 的平台指纹；恢复时先识别活 owner，再验证 PID 未复用，POSIX leader 已退出但进程组仍活跃时单独清理 leaderless group (`packages/cli/src/context/storage/DurableProcessLeaseStore.ts`, `packages/cli/src/utils/process/ProcessIdentity.ts`)
- `BackgroundShellManager` 统一管理本地后台、自动 handoff 和 ACP 外部前台候选，默认最多 16 个全局活动进程、每 Session 4 个 (`packages/cli/src/tools/builtin/shell/BackgroundShellManager.ts`)
- worktree manager 以 Session keyed mutex 串行生命周期操作，目录位于按仓库路径哈希隔离的 managed root，分支名同时包含逻辑名称和 Session 哈希 (`packages/cli/src/worktree/WorktreeManager.ts`)
- 任务交付使用临时 Git index 收集 tracked/untracked 变更，生成 binary patch，先 `git apply --check` 再应用到源工作区，不通过 merge 或复制目录 (`packages/cli/src/worktree/WorktreeManager.ts`)

## Decisions
- managed worktree 同时服务显式 Enter/Exit 工具和子代理任务隔离；工具层只负责用户交互，实际恢复、差异和交付语义集中在 `WorktreeManager` (`packages/cli/src/tools/builtin/worktree/worktreeTools.ts`, `packages/cli/src/agent/subagents/SubagentWorktreeLifecycle.ts`, `git:c80db2c1`)
- 后台与前台命令都升级为持久 lease 和 owned process tree，以便 Session 恢复时回收 orphan，而不是只依赖当前 Node 子进程句柄 (`packages/cli/src/context/storage/DurableProcessLeaseStore.ts`, `git:c012135e`, `git:cbe0e8ed`)
- 输出限制分为 capture 上限和模型/UI projection 上限，既限制常驻内存又保留完整计数事实，避免单纯截断字符串后无法判断损失量 (`packages/cli/src/tools/builtin/shell/ShellOutputCapture.ts`, `packages/cli/src/tools/builtin/shell/OutputTruncator.ts`, `git:81a9acc9`)

## Patterns
- 本地 POSIX 子进程作为 detached group leader 启动，终止先发 `SIGTERM` 再在 grace period 后发 `SIGKILL`；Windows 使用 `taskkill /T` 并保留直接 child fallback (`packages/cli/src/utils/process/OwnedProcessTree.ts`)
- workspace-required 或只读审计 Bash 会先生成沙箱命令；cwd 在 lexical 与 realpath 两层都必须位于 workspace，沙箱启动失败按 permission denied fail closed (`packages/cli/src/tools/builtin/shell/WorkspaceWriteSandbox.ts`, `packages/cli/src/tools/builtin/shell/bash.ts`)
- 只读审计沙箱不继承任意进程环境、禁止网络和 workspace 写入，只允许专用临时目录写入及受信任 PATH 中的运行时；普通 worktree 沙箱允许 workspace 写入 (`packages/cli/src/tools/builtin/shell/WorkspaceWriteSandbox.ts`)
- SessionRuntime 启动时先回收 foreground/background orphan，关闭时主动 kill 本 Session 后台进程并释放 worktree 内存绑定 (`packages/cli/src/agent/runtime/SessionRuntime.ts`)

## Resource Bounds
- 后台与前台 capture 分别为 stdout/stderr 各 1 MiB，并最多保留 32 个 chunk；超大 chunk 从 UTF-8 边界保留尾部 (`packages/cli/src/tools/builtin/shell/BoundedOutputBuffer.ts`)
- worktree diff 最多 100 个文件、单文件 1 MiB、总计 2 MiB；真正交付的 binary patch 上限为 50 MiB，展示截断不改变交付内容 (`packages/cli/src/worktree/WorktreeManager.ts`)
- 后台容量耗尽返回 `RESOURCE_EXHAUSTED/background_shell_busy` 且可稍后重试，不会排队等待并额外占用内存 (`packages/cli/src/tools/builtin/shell/BackgroundShellManager.ts`, `packages/cli/src/tools/builtin/shell/bash.ts`)
