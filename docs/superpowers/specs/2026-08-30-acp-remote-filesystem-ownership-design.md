# ACP Remote Filesystem Ownership Design

> 状态：批准实施
> 日期：2026-08-30

## 背景

Blade 的 ACP Session 已能通过标准 `fs/read_text_file` 与 `fs/write_text_file` 在 Client
持有的 workspace 中读写文本。已声明的远端请求失败时不会回退本地，这一层已有正确的
fail-closed 行为；问题出在未协商操作：`AcpFileSystemService` 会把缺失的 text capability、
`stat`、`mkdir` 和 binary read 直接转发到 Blade 宿主文件系统。

因此一个只声明部分 filesystem capability 的 Client，或者一个完整 remote text Client，
都可能让同一次 `Read`、`Write` 或 `Edit` 同时观察两个不同机器上的同名绝对路径。
例如 `Write` 可在 Client 写入正文，却在 host 创建父目录、读取 mtime 并记录 read-before-write
状态。这既破坏正确性，也跨越了 remote workspace 的所有权边界。

标准 ACP 1.3.0 只提供 `readTextFile` 与 `writeTextFile` 两项 capability。本设计不虚构
`stat`、`mkdir`、delete、rename 或 binary RPC。

## 目标与非目标

目标：

1. 为每个 ACP Session 在初始化时确定唯一 filesystem backend：local 或 remote。
2. remote owner 下，任何未协商或协议不支持的 workspace 操作都 fail closed，绝不访问 host
   同名路径。
3. 让 remote `Read`、`Write`、`Edit` 与 update-only `ApplyPatch` 只依赖标准 ACP text RPC。
4. 用 SHA-256 内容指纹维持 remote read-before-write 和外部修改检测，不保存额外文件内容。
5. 对 remote 写入执行 read-back；无法确认最终状态时返回带
   `sideEffectsUncertain: true` 的稳定失败。
6. 保持无 remote fs capability 的 ACP Client 使用 Session cwd 对应的本地 filesystem。

非目标：

- 不扩展或 fork ACP 协议。
- 不为 remote workspace 实现 binary read/write、目录枚举、delete、rename、watch 或真正的
  跨进程远端事务。
- 不改变 CLI、Web、本地 ACP 的文件语义。
- 不让 Browser、LSP、AutoVerify 或宿主内部 durable state 访问远端 workspace。
- 不把 Client 的 `writeTextFile` 成功解释为创建了哪些父目录；这是 Client 实现细节。

## Backend 判定

`AcpServiceContext.initializeSession()` 在 Session 创建时冻结 filesystem ownership：

- `clientCapabilities.fs.readTextFile === true` 或
  `clientCapabilities.fs.writeTextFile === true`：创建 remote-owned
  `AcpFileSystemService`。
- `fs` 缺失，或 `readTextFile` 与 `writeTextFile` 均不是 `true`：创建绑定 Session cwd 的
  `LocalFileSystemService`。

新增 `isAcpRemoteFileSystem(sessionId)` 查询实际 backend。`isAcpMode(sessionId)` 仍表示
ACP surface，用于凭据、artifact、LSP 与 AutoVerify 的既有安全策略；两者不能互换。

这是一种 backend selection，不是错误 fallback。remote owner 一旦选定，生命周期内不会
因为 RPC 失败或 capability 不完整而切换到 host。

remote-owned 不表示所有文件工具都可用。read-only Client 只能执行 remote text Read；
write-only Client 的底层 adapter 可以发送显式 write RPC，但 Blade 的 `Write`、`Edit` 与
`ApplyPatch` 因无法执行读取、read-before-write 和 read-back 而必须在任何 I/O 前失败。

## Remote service 契约

`AcpFileSystemService` 只表示 remote owner，不再接收或调用 local fallback：

- `readTextFile`：没有 `readTextFile` capability 时抛
  `AcpFileSystemCapabilityError('readTextFile')`；RPC 失败原样 fail closed。
- `writeTextFile`：没有 `writeTextFile` capability 时抛
  `AcpFileSystemCapabilityError('writeTextFile')`；RPC 失败原样 fail closed。
- `exists`：必须通过 remote read 判断。标准 ACP `ResourceNotFound` (`-32002`) 返回 false；
  兼容常见 not-found 文案，但权限、超时、断连和未知错误继续抛出，不能假定 exists。
  没有 `readTextFile` capability 时明确抛
  `AcpFileSystemCapabilityError('readTextFile')`。
- `readBinaryFile`、`stat`、`mkdir`：抛带 operation 的
  `AcpFileSystemCapabilityError`，不触碰 host。

错误消息是稳定的控制面文本，不包含文件内容、credential 或底层 Client 私有数据。既有
tool result、durable transcript 与结构化日志可以保留用户请求的 remote path 和有界 diff；
不得记录完整 remote 内容、digest、credential、原始 RPC payload 或 Client 私有 error data。

## Remote read-before-write

`AcpFileSystemService` 实例内维护一个有界、Session-scoped 的 remote access ledger，保存：

```ts
interface RemoteFileAccessRecord {
  filePath: string;
  accessTime: number;
  contentSha256: string;
  sessionId: string;
  lastOperation: 'read' | 'edit' | 'write';
  source: 'remote';
}
```

remote path 使用独立 lexical normalization：盘符绝对路径用 `path.win32.normalize` 并统一
盘符大小写，`/` 开头的路径用 `path.posix.normalize`；相对路径和 UNC 路径继续由现有 schema
拒绝。规范化会折叠分隔符、`.` 与 `..`，但保留其余大小写，不猜测 remote filesystem 的
case sensitivity。它不调用 host `realpath` 或 `stat`。ledger
只属于一个 `AcpFileSystemService`/Session，按 normalized path 命中，并设固定 entry cap；LRU
淘汰只会要求 Agent 重新 Read，不会改变文件内容。Session 销毁即丢弃整个 ledger。全局
`FileAccessTracker` 继续只负责 local workspace。

`Read` 成功取得 remote text 后记录内容 SHA-256。`Write` 与 `Edit` 在执行前重新读取 current
remote content，并要求：

- existing file 已有当前 Session 的 remote Read record；
- record 的 SHA-256 与 current content 一致。

不一致时返回现有的 `File modified externally` validation failure。成功写入并 read-back验证后，
remote ledger 更新为新内容摘要。内部 `exists`、write preflight 或 ApplyPatch preflight 不得自动
记为用户 Read；只有 `Read` 工具成功或已验证完成的 mutation 才更新 ledger。

新文件是 read-before-write 的明确例外：remote preflight 得到标准 not-found 后可调用
`writeTextFile`，但成功仍必须 read-back。`create_directories` 不触发 host mkdir，也不承诺父目录
由 Blade 创建；Client 可自行创建父目录，或拒绝请求并返回确定错误。

`ApplyPatch` 的 preflight 已读取每个 current remote file，commit 前也再次比较 old content；
成功后将每个新内容记录为 remote edit。它不要求独立的先前 `Read`，维持现有 remote
transaction contract。

## 工具行为

### Read

- local backend 保持现状。
- remote backend 仅支持 UTF-8 text。已知 binary extension 或显式 `base64` / `binary`
  encoding 返回 capability failure。
- remote text 直接调用一次 `readTextFile`；不先 `exists`，不调用 `stat`。
- `file_size` 使用 UTF-8 byte length，`last_modified` 省略，`acp_fallback` 删除。
- not-found 仍映射为现有 `File not found` 工具错误。

### Write

- local backend 保持 mkdir、stat、snapshot、mtime 与现有 read-before-write。
- remote backend 要求 read + write 两项 capability；缺一项时在任何 I/O 前返回 validation error。
- remote backend 不调用 `mkdir` 或 `stat`。它读取 old content（not found 表示新文件），验证
  remote Read digest，写入后再次读取并逐字节比较。
- metadata 使用已知内容计算 `file_size`；无法从标准 ACP 获知的
  `created_directories`/`last_modified` 均省略，snapshot 保持 false。

### Edit

- local backend 保持现状。
- remote backend要求 read + write，使用 current remote content 做匹配，并用 stored digest 做
  read-before-write/并发修改检查。
- 写入后 read-back 必须等于 expected content，再更新 remote digest。

### ApplyPatch

- 保持仅允许 remote `Update File` 的限制以及逆序补偿回滚。
- `Update File` 的目标在 preflight 时不存在就返回 not-found，不得降级为 Add。
- remote path 不调用 local workspace recovery、snapshot、stat、mkdir、realpath。
- host 私有 storage 下的协调 lock 可以保留；它不是用户 workspace 内容。in-process path lock
  使用 remote lexical identity，不解析 host symlink。
- host lock 只保存 opaque hash、PID/token 和时序，不保存 remote 内容；操作结束即清理，stale
  lock 只按现有有界规则回收。它可跨 Session/进程协调同一 remote workspace identity，但
  不能被当作 remote file 存在性或权限证据。
- commit 成功后按 new content 更新 remote access digest。

## 写入失败与副作用不确定性

remote write RPC 抛错时，Client 可能在响应丢失前已经写入。`Write` 与 `Edit` 应执行一次
有界 read-back：

- 内容仍等于 old content：返回确定失败，`sideEffectsUncertain: false`。
- 内容等于 intended content：返回普通成功结果，并记录
  `write_acknowledged: false`、`write_verified: true` 与新 digest。
- existing file 内容为其他值、read-back 失败，或 new file read-back 既不是 intended content
  也不是明确 not-found：返回失败并设置
  `sideEffectsUncertain: true`，提示先重新 Read，不自动重放。
- new file 在写后仍得到明确 not-found：返回确定失败，`sideEffectsUncertain: false`。

`ApplyPatch` 继续使用它已有的补偿回滚与 `AggregateError` 语义；若 rollback 无法完全验证，
结果必须同样携带 `sideEffectsUncertain: true`。

## 并发与生命周期

- backend capability 在 Session 初始化时冻结，不随全局当前 Session 改变。
- ACP transport 断线/恢复不改变已建立 Session 的 filesystem owner 或 capability snapshot；
  需要改变 capability 时必须销毁旧 Session context 并重新初始化，旧 ledger 随之丢弃。
- remote access records 由 Session-scoped `AcpFileSystemService` 持有；
  `AcpServiceContext.destroySession()` 删除 service 后自动清理。
- Write/Edit/ApplyPatch 继续使用现有 per-path in-process locks；remote key 由 path style lexical
  normalization 与 ACP Session ID 组成 opaque identity，不读取 host filesystem。
- cancellation 在每个 remote await 前后检查。已发送 write 后的 cancellation必须先 read-back，
  再决定成功、确定失败或 side-effect-uncertain。
- 不缓存 remote file content；ledger 默认最多保留 1024 个路径，使用 LRU，只保存
  SHA-256、时间和操作类型。

## 跨端影响

- CLI 与 Web 不改变文件 backend 或 UI。
- 本地 ACP Client（不声明 fs 或两项均 false）保持使用 Session cwd 的本地 filesystem。
- remote ACP Client 获得唯一、明确的 remote ownership；错误通过标准 tool result 投影，
  不增加私有 ACP notification。
- Web GUI 回归只需证明共享工具 metadata/diff 渲染未改变；本 patch 不新增 Web 控件。

## 测试与准出

确定性测试必须覆盖：

- no-fs 和 all-false capability 选择 local backend；任一 true 选择 remote backend；
- partial capability 的 Read/Write/Edit/ApplyPatch 在 I/O 前 fail closed；
- remote text Read/Write/Edit 不调用 host `exists/stat/mkdir/readBinaryFile/read/write`；
- remote missing、permission、timeout 与 unknown error 分类；
- remote read-before-write digest：未读、同内容、外部变化、跨 Session 隔离；
- write success、ack-lost-but-applied、definite no-op 和 uncertain mismatch/read-back failure；
- ApplyPatch update-only、content race、rollback success/failure、remote lock identity；
- remote ledger 的 1024-entry LRU、Windows/POSIX normalization、跨 Session 隔离与 dispose 清理；
- CLI/Web 文件工具既有测试不回归。

真实 API 资格使用现有 DeepSeek 配置和 paired ACP transport：

1. Client 提供只存在于内存 remote map 的源码和测试文件，同时在 host 放置同路径 canary。
2. Agent 通过标准 ACP `Read` 与 `Edit`/`Write` 修复任务。
3. Client 记录每个 `fs/read_text_file` / `fs/write_text_file` request；断言 session ID、绝对路径、
   调用顺序、最终内容与 hash。
4. 断言 host canary 未变化，且未创建 remote 路径的 host 父目录。
5. 使用 read-only 与 write-only capability 分别运行 deterministic protocol test，证明缺失能力
   不产生 ACP 请求或 host I/O。
6. production ACP result 必须 `end_turn`，只出现一次预期文件 mutation，零 framework retry，
   输出与日志通过 credential/path canary scan。

发布前运行 `bun run build`、`bun run type-check`、`bun run lint`、`bun run test:all`，并将真实
ACP qualification 的命令、模型、通过数、结构化证据摘要和日志 SHA-256 写入中英文 evidence。

## 参考实现与取舍

- Neovate 的 ACP 工具在 RPC 失败后回退 host filesystem；该行为会混淆 remote 与 host
  identity，本设计明确不采用。
- Grok Build 把 ACP filesystem 注入为独立 backend，并对 delete 返回 unsupported；本设计采用
  其 backend 隔离和 fail-closed 原则，同时补齐 Blade 的 remote read-before-write。
- Codex app-server 暴露更完整的自有 `fs/*` RPC（metadata、directory、remove、copy、watch）；
  这不是标准 ACP 1.3.0 capability，Blade 本 patch 不要求第三方 ACP Client 实现这些扩展。
