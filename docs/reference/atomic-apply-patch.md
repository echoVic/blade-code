# Atomic ApplyPatch

`ApplyPatch` 是 Blade 的原子多文件文本修改工具。它使用 Codex 风格的 file-oriented
patch grammar，但不接受 Codex 的“前缀已提交、失败返回 delta”语义：Blade 在提交前
完成整个 patch 的解析、路径验证和上下文预演，提交失败时回滚全部文件。

## Patch 格式

```text
*** Begin Patch
*** Add File: src/new.ts
+export const added = true;
*** Update File: src/app.ts
@@ function run()
-const ready = false;
+const ready = true;
*** Delete File: src/obsolete.ts
*** End Patch
```

更新文件可在 header 后立即使用 `*** Move to: src/new-name.ts`。每个 hunk 以 `@@`
开始，正文行必须以空格、`-` 或 `+` 开头。`*** End of File` 可将匹配优先限制在
文件末尾。

限制：

- 路径只能是相对 POSIX 路径；拒绝绝对路径、反斜杠、空 segment、`.` 和 `..`。
- patch 最大 1 MiB、100 个文件操作、1000 个 hunk、50000 行。
- 单文件最大 10 MiB，单事务预演数据最大 32 MiB。
- 仅支持 UTF-8 文本文件。
- 同一 patch 的 source/destination 不可重叠。
- 拒绝 `.git`、`.claude`、`node_modules` 和环境凭据文件。
- existing local files 必须先由当前 Session 的 `Read` 读取。

## 本地事务

本地执行使用以下协议：

1. 解析全部操作并解析 canonical workspace identity。
2. 验证 symlink containment、文件类型、编码、大小和所有 hunk context。
3. 按 canonical path 排序获取多路径锁。
4. 将所有新内容写入目标目录内的 exclusive stage file，并 `fsync`。
5. 再次验证原文件内容没有在 preflight 后变化。
6. 将旧文件 rename 到同目录 backup，再 rename 发布全部 stage。
7. `fsync` 所有受影响目录，将 0600 crash journal 标记为 committed，最后清理 backup。

任何阶段失败都会删除已发布文件、按逆序恢复 backup、清理 stage 和本次创建的空目录。
若 rollback 本身失败，工具返回 `AggregateError`，不会把不确定状态报告为成功。

`FileLockManager` 在等待前先登记 reservation，避免三个以上调用同时等待同一路径时
绕过队列；多路径锁按稳定顺序嵌套，避免事务死锁。

每个 canonical workspace 还持有独立的 0600 跨进程 lock。两个 Blade 进程不能并发
发布同一 workspace。事务在修改 source 前写入 storage-root journal：

- `preparing` journal 在 Session 重建时按逆序恢复 backup，并移除已发布 Add。
- `committed` journal 保留目标内容，只清理遗留 stage/backup。
- journal 路径、owner、mode、workspace identity 和 sibling 命名都严格验证。
- malformed、symlink 或跨 workspace journal fail closed，不执行恢复。

## ACP

ACP Session 的 text filesystem owner 按 capability matrix 选择：

- `fs` capability 缺失，或 `readTextFile=false && writeTextFile=false` 时，继续使用
  Session-local backend。
- 只要 `readTextFile===true` 或 `writeTextFile===true` 任一项为真，text filesystem
  owner 就在 Session 初始化时冻结为 remote。
- 远端 mutation 仍要求 `readTextFile=true && writeTextFile=true` 同时成立；缺少任一项
  都会 fail closed。

标准 ACP 没有 delete、rename 或 multi-file transaction API，因此 remote-owned
`ApplyPatch` 具有以下边界：

- Session 只要在初始化时协商出任一 text fs capability，就冻结 remote owner；后续
  reconnect 不会切回本地，capability 变化必须重建 Session。
- 多文件 `Update File` 可用；提交前对每个目标做完整 preflight compare，每次写入后都
  read-back 验证。
- 任一写入失败时，所有已尝试文件按逆序写回旧内容并再次 read-back。
- Add、Delete 和 Move fail closed，不会错误写到 Blade 宿主机。
- Client 已声明远端 fs 后，ACP request 失败不再 fallback 到同名本地路径。
- remote 协调状态只保留 Session-bound opaque hash/token/timing，不记录 remote path、
  remote content 或 remote digest，也不能作为远端存在性或权限证据。
- `sideEffectsUncertain=true` 表示最终 remote 状态无法证明；调用方必须重新 `Read`
  再决定是否重试。`false` 只表示当前路径无未分类副作用，或补偿回滚已验证。

未声明远端 fs，或两项 capability 都为 `false` 的 ACP Client，继续使用共享本地
workspace，可使用完整本地事务与完整 patch grammar。

## Session 集成

- 一个 ApplyPatch 生成每文件 Snapshot，并可通过同一 message checkpoint 整体 rewind。
- Snapshot 支持“文件缺失”post-state，因此 Add、Delete 和 Move 都可回退。
- Hook matcher 接收全部 affected paths；`ApplyPatch(src/**)` 会匹配任一目标文件。
- LSP 对新增/更新文件发送 didOpen/didChange/didSave，对删除或 move source 发送 didClose。
- 未配置 LSP 时，trusted+YOLO AutoVerify 对整个 patch 只运行一次项目 type-check。
- CLI/TUI、Web 和 ACP 使用同一 metadata `changes[]`，Web changed-files 与 diff preview
  展示每个文件，ACP 输出一个标准 diff content item/file。

## 资格验证

确定性测试覆盖 grammar、CRLF、locator、EOF、上下文失败零副作用、symlink escape、
多路径并发、发布中途故障、远端模糊失败补偿回滚、Snapshot 整体 rewind、LSP 和
Hook 多文件事件。

### 本地 backend / ACP-local 资格

旧的真实 API 资格要求模型先 Read 两个 existing files，再仅调用一次 ApplyPatch 更新
两个文件并新增第三个文件；不得退回 Edit、Write 或 Bash。该资格用于证明本地 backend
与 ACP-local backend 的完整 patch grammar、事务发布和三文件 GUI 展示语义。生产
Web GUI 还必须展示三个 changed files、每文件 diff、Auto Edit 权限语义和 fresh-tab
零 console error。

### ACP remote filesystem 资格

ACP remote ownership 的 release qualification 单独记录在
[ACP Remote Filesystem Ownership 资格验证证据](../testing/acp-remote-filesystem-ownership-evidence.md)。
该资格只证明 remote-owned `ApplyPatch` 的多文件 `Update File`、逐写 read-back、
补偿回滚与 fail-closed 边界；`Add File`、`Delete File`、`Move to` 仍不属于 ACP
remote qualification 范围。
