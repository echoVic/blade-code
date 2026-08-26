---
name: knowledge-filesystem-search-and-atomic-patching
description: >
  Covers Read/Write/Edit/ApplyPatch、Snapshot、Read-Before-Write、Glob/Grep、Notebook 编辑及本地/ACP 文件系统差异。
  Navigate when: 修改文件读写、智能替换、原子多文件补丁、会话回退、搜索降级、Git ignore 处理或 ACP 远端文件行为。
  Excludes: 通用权限与执行阶段（见 ../tool-execution-pipeline/）、Shell 进程和 worktree（见 ../shell-process-and-worktree/）。
  Keywords: Read, Write, Edit, ApplyPatch, FileAccessTracker, SnapshotManager, PatchTransactionCoordinator, FileSystemService, Glob, Grep.
---

## Module Structure

文件工具在统一 `FileSystemService` 上实现读取和单文件写入，并用 Session 访问记录与
快照保护编辑；`ApplyPatch` 对本地文件另建完整事务协议，对 ACP 远端文件使用受限的
补偿事务。搜索工具独立选择高性能后端并返回有界结果。

### Directory Layout
- `packages/cli/src/tools/builtin/file/` — Read/Write/Edit/ApplyPatch、访问跟踪、快照和事务
- `packages/cli/src/tools/builtin/search/` — Glob/Grep 与多级搜索后端
- `packages/cli/src/tools/builtin/notebook/` — Notebook 结构化编辑
- `packages/cli/src/services/FileSystemService.ts` — 本地与 ACP 文件操作接口
- `docs/reference/atomic-apply-patch.md` — ApplyPatch 的事务与恢复契约

### Key Entry Points
- `readTool` / `editTool` / `writeTool` in `packages/cli/src/tools/builtin/file/` — 单文件读取与编辑入口
- `applyPatchTool` in `packages/cli/src/tools/builtin/file/applyPatch.ts` — 原子多文件变更入口
- `SnapshotManager` in `packages/cli/src/tools/builtin/file/SnapshotManager.ts` — 按 Session、workspace 和 message 保存回退点
- `FileAccessTracker` in `packages/cli/src/tools/builtin/file/FileAccessTracker.ts` — Read-Before-Write 与外部修改检测
- `globTool` / `grepTool` in `packages/cli/src/tools/builtin/search/` — 文件名与内容检索

## Gotchas
- 现有文件的 `Write`、`Edit` 和本地 `ApplyPatch` 要求当前 Session 先成功登记 `Read`；记录按 Session 隔离，并把符号链接别名与 canonical path 归并 (`packages/cli/src/tools/builtin/file/FileAccessTracker.ts`, `packages/cli/src/tools/builtin/file/applyPatch.ts`)
- `FileAccessTracker.checkExternalModification()` 对 mtime 使用 2 秒缓冲，适合规避文件系统时间抖动但不是内容哈希锁；原子补丁另会在发布前逐字节重验旧内容 (`packages/cli/src/tools/builtin/file/FileAccessTracker.ts`, `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`)
- `Edit` 不只做精确替换，还依次尝试行尾空白、智能引号、反转义、空白归一化、弹性缩进和块锚点；非唯一匹配仍会在 `replace_all=false` 时失败，不能把容错匹配当成模糊批改 (`packages/cli/src/tools/builtin/file/edit.ts`, `git:300cc776`)
- `Edit`/`Write` 的快照创建或 post-state 登记失败只记录警告并继续报告文件写入成功，`snapshot_created=false` 才是能否 rewind 的权威标志 (`packages/cli/src/tools/builtin/file/edit.ts`, `packages/cli/src/tools/builtin/file/write.ts`)
- `ApplyPatch` 在提交前创建所有快照，任一快照失败会阻止整个提交；这与单文件 Edit/Write 的 best-effort 快照策略不同 (`packages/cli/src/tools/builtin/file/applyPatch.ts`)
- `ApplyPatch` 工具声明 `isConcurrencySafe=true` 与 `parallelism='shared'`，因为它在内部解析全部路径并获取稳定排序的多路径锁；改回通用单路径锁会破坏多文件原子性 (`packages/cli/src/tools/builtin/file/applyPatch.ts`, `packages/cli/src/tools/execution/FileLockManager.ts`)
- ACP 远端 `ApplyPatch` 只支持 Update，Add/Delete/Move 必须 fail closed；每次远端写后 read-back，失败时按逆序补偿并再次校验，而不是错误写入同名本地路径 (`packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`, `packages/cli/tests/integration/apply-patch-transaction.test.ts`)
- ACP 模式的二进制 `Write` 明确拒绝；绕过 `FileSystemService` 写本地文件会把远端编辑错误落到 Blade 宿主机 (`packages/cli/src/tools/builtin/file/write.ts`, `packages/cli/src/services/FileSystemService.ts`)
- Snapshot rewind 只接受目标 message 对每个文件形成历史连续后缀，并要求当前文件哈希仍等于 Blade 最后写后哈希；否则整批回退前即拒绝 (`packages/cli/src/tools/builtin/file/SnapshotManager.ts`)
- `Glob` 达到 `max_results` 后主动销毁流并把 `truncated=true`，此时 `total_matches` 只是已返回数量，不是实际总数 (`packages/cli/src/tools/builtin/search/glob.ts`)
- `Grep` 的后端依次为系统 `rg`、随包 vendor `rg`、可选 `@vscode/ripgrep`，再降级到 `git grep`、系统 grep 和 JavaScript；不同降级层的 ignore、glob 与 multiline 能力并不完全等价 (`packages/cli/src/tools/builtin/search/grep.ts`)
- 当前仅 `Read`、`Glob`、`Grep` 在本节点显式 opt-in `isRetrySafe`；Write、Edit、ApplyPatch 和 NotebookEdit 即使错误码看似瞬态也默认只调用一次 (`packages/cli/src/tools/builtin/file/read.ts`, `packages/cli/src/tools/builtin/search/glob.ts`, `packages/cli/src/tools/builtin/search/grep.ts`)

## Architecture
- `Read` 既返回内容也更新 Session 访问记录，写工具再检查该记录；这是跨工具的时序契约，不是单个 schema 能表达的约束 (`packages/cli/src/tools/builtin/file/read.ts`, `packages/cli/src/tools/builtin/file/FileAccessTracker.ts`)
- 本地 ApplyPatch 分为 parse、纯预演 plan、workspace/多路径锁、stage+backup+journal 发布、快照完成和访问记录更新；解析或预演失败发生在任何目标文件变更之前 (`packages/cli/src/tools/builtin/file/applyPatch.ts`, `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`)
- patch journal 以 canonical workspace 哈希分区并使用 `0600` 文件；`preparing` 在恢复时回滚，`committed` 只清理遗留 stage/backup，畸形或越界 journal 直接失败 (`packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts`)
- Snapshot 存储按 canonical workspace 与 Session 双重隔离，记录写前内容、是否原本存在和写后哈希，因此 Add、Delete、Move 都能参与 message 级回退 (`packages/cli/src/tools/builtin/file/SnapshotManager.ts`)
- 本地和 ACP 文件工具共享接口但能力不对称；是否使用远端文件由 Session 的 ACP service context 决定，而不是由路径形式猜测 (`packages/cli/src/services/FileSystemService.ts`, `packages/cli/src/acp/AcpServiceContext.ts`)

## Decisions
- Blade 的 ApplyPatch 拒绝“前缀已提交、失败返回 delta”语义，选择完整预演和全事务回滚，避免多文件修改留下半完成状态 (`docs/reference/atomic-apply-patch.md`, `git:df17b2eb`)
- 本地发布使用目标同目录的 exclusive stage/backup、文件和目录 fsync，再写 committed journal；这是为了同时覆盖原子 rename 与进程崩溃恢复 (`packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`, `packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts`)
- Edit 保留渐进式匹配但对多处命中要求显式 `replace_all` 或更大上下文，优先让模型修正定位而非猜测目标 (`packages/cli/src/tools/builtin/file/edit.ts`, `git:300cc776`)

## Patterns
- 文件修改成功后 metadata 保留完整 old/new content 或 `changes[]`，模型侧只接收摘要/diff；Session rewind、Web changed-files 和 ACP diff 都复用同一结果事实 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/builtin/file/applyPatch.ts`)
- 多路径 patch 在拿锁前先提取并去重目标，锁键解析已有祖先的 realpath，避免路径别名形成两把独立锁 (`packages/cli/src/tools/builtin/file/applyPatch.ts`, `packages/cli/src/tools/execution/FileLockManager.ts`)
- `ApplyPatch` 限制为 1 MiB 输入、100 个文件操作、1000 个 hunk、50000 行；本地/远端规划再限制单文件 10 MiB和事务预演 32 MiB (`packages/cli/src/tools/builtin/file/applyPatchParser.ts`, `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`)
- Glob 使用递归 `.gitignore` 解析、禁用符号链接跟随并二次应用 negation；结果先文件后目录，再按修改时间降序 (`packages/cli/src/tools/builtin/search/glob.ts`)
- 搜索工具把取消视为失败而不是返回部分结果；Glob 只有达到结果上限才返回成功且标记截断 (`packages/cli/src/tools/builtin/search/glob.ts`, `packages/cli/src/tools/builtin/search/grep.ts`)

## Recovery And Consistency
- Session 初始化会在本地模式恢复未完成的 patch journal；恢复本身也在 workspace 跨进程锁和多路径锁内执行 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts`)
- 本地发布中途失败会删除已发布新文件、逆序恢复 backup、删除 stage 与本次创建的空目录；回滚失败升级为 `AggregateError`，绝不报告成功 (`packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`, `packages/cli/tests/integration/apply-patch-transaction.test.ts`)
- Session rewind 先收集所有文件当前状态，再验证所有 post-edit hash，最后批量恢复；恢复中途失败还会尝试恢复到 rewind 前状态 (`packages/cli/src/tools/builtin/file/SnapshotManager.ts`)
