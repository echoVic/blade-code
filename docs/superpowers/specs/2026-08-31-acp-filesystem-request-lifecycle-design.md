# ACP Filesystem Request Lifecycle Design

> 状态：批准实施
> 日期：2026-08-31

## 背景

`v0.10.126` 已经为 ACP Session 建立唯一的 local/remote filesystem owner、远端
read-before-write ledger、verified mutation、opaque lock 与 update-only ApplyPatch。当前剩余的
最高优先级风险是 RPC lifecycle：`AcpFileSystemService` 通过标准 ACP
`fs/read_text_file` / `fs/write_text_file` 发出的请求没有携带 cancellation signal，也没有本地
hard deadline。

`RemoteTextMutation` 只给 write 后的 read-back 加了 5 秒 `Promise.race`。原始 write 可以永久
pending；read-back 超时后底层 request 也仍留在 SDK pending map。工具 invocation 因而可能永久
持有 opaque path lock，remote ApplyPatch 还会持有 workspace lock 和多路径锁。

ACP SDK 1.3.0 的 legacy `AgentSideConnection.readTextFile()` / `writeTextFile()` helper 没有
options 参数，但同一公开 class 的 typed `request(method, params, options)` 支持标准
`SendRequestOptions.cancellationSignal`，abort 时发送 `$/cancel_request`。该取消是 cooperative：
本地 Promise 仍等待 Client 的最终 response，所以只传 signal 不能提供 hard liveness guarantee。

## 目标

1. 每个 remote filesystem request 都有本地 hard deadline，并把取消通过标准
   `$/cancel_request` 传给 ACP Client。
2. 用户取消或 deadline 到达后，工具在有界时间内返回并释放 ToolExecutor path lock、
   ApplyPatch workspace lock 与 multi-path locks。
3. 对可能已经送达 Client 的 write 保持 `sideEffectsUncertain: true`；不能把 cooperative cancel
   解释为“远端一定未写”。
4. 防止已经本地结束的旧 write 晚到后覆盖同一路径的新 mutation。
5. 限制未终结 SDK request 的数量，避免故障 Client 造成无界 pending-request 增长。
6. 允许在旧 request 真正终结后，通过一次新的用户 `Read` 恢复该路径，而无需永久封死整个
   ACP connection。
7. 保持 `v0.10.126` 的 owner、ledger、metadata、local/ACP-local 与协议边界。

## 非目标

- 不增加 ACP 私有 RPC，不实现 stat、mkdir、binary、delete、rename 或 watch。
- 不把 `$/cancel_request` 当作远端未执行的证明。
- 不自动重放 timed-out write，不自动选择“最后一次写赢”。
- 不在本 patch 改 ACP tool-result receipt/UI 投影；该可诊断性改进单独发布。
- 不升级 ACP SDK，除非实现阶段证明 1.3.0 的公开 typed `request()` 无法满足契约。
- 不改变本地 CLI、Web 或无 remote fs capability 的 ACP Session 文件行为。

## 方案比较

### 方案 A：只在 Blade 外层 `Promise.race`

优点是改动最小，工具能按时返回。缺点是 Client 不会收到取消，SDK pending request 会继续
增长；释放锁后旧 write 可以晚到并覆盖新 write。该方案只改善表面延迟，会破坏数据安全，拒绝。

### 方案 B：deadline 后关闭整条 ACP connection

强制关闭会让 SDK 的 pending requests 结束，liveness 最强，但一条文件请求会中断同 connection
上的所有 Session、terminal、permission 与 update egress。它适合 connection shutdown 的最终兜底，
不适合作为单文件超时的常规路径。

### 方案 C：标准取消、本地 deadline 与 quarantine fencing

每个请求用公开 `AgentSideConnection.request()` 发送标准 method literal 与
`cancellationSignal`；Blade 同时用本地 deadline 提前结束调用。若 write 已 dispatch 但没有权威
response，该路径进入 quarantine。旧 request 真正 settle 前，同一路径的新 read/write 均 fail fast；
settle 后允许一次用户 `Read` 取得权威状态并解除 quarantine。该方案既释放工具锁，也不允许晚到
旧写和后续 mutation 交错。

本设计采用方案 C。

## 连接级协调器

新增 `AcpFileRequestCoordinator`，由 `WeakMap<AgentSideConnection, ...>` 按 ACP connection
共享。每个状态条目只保存：

- Session ID；
- 由现有 `createOpaqueLockKey()` 产生的 opaque path identity；
- request token / generation；
- request kind（read/write）；
- lifecycle state 与时间；
- 是否需要 fresh user Read。

它不保存 remote path、文件内容、content digest、credential 或 Client error。所有 path state
只用现有 `createOpaqueLockKey()` 的结果索引。connection 的
`signal` abort 后，协调器关闭并释放自己的内存状态。

同一 connection 下，Session destroy/reload 可创建新的 `AcpFileSystemService`，但会复用同一
coordinator。因此同一 `sessionId + normalized path` 的 timed-out write 不会因为 service 重建就
失去 fence。全新 ACP connection 是新的 generation；旧 connection 关闭是该 generation 的终止
边界。

协调器同时限制 connection 上未终结 filesystem requests 的数量为 32，并限制 active /
quarantined path state 为 1024。达到任一上限后，新 mutation 在发送前 fail closed；read 仍只能
占用剩余 request slot，不能通过淘汰 quarantine 来换取容量。底层 request settle 或 connection
close 时释放 pending-request 计数；`clean` path state 立即删除。

## Request lifecycle

`AcpFileSystemService` 为 remote-only 操作接受可选 request options：

```ts
interface AcpRemoteFileRequestOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  purpose?: 'user-read' | 'preflight' | 'readback' | 'mutation' | 'rollback';
}
```

默认 read/write hard deadline 为 30 秒；mutation read-back 保持 5 秒。deadline 使用绝对时间，
嵌套调用不会重置预算。ApplyPatch 在取得现有 workspace/path locks 后创建共享 request-phase
绝对 deadline，防止最多 100 个 operation 把 per-request 上限串联成无意义的超长锁持有时间。
现有 workspace-lock acquisition 仍使用自己的 10 秒上限，不在本 patch 重写 lock manager。具体
request-phase 预算：

- remote ApplyPatch 总预算 120 秒；
- 为 compensation 预留最后 30 秒；
- 每个普通 request 最多 30 秒；
- 每个 read-back 最多 5 秒；
- 实际 timeout 总是这些上限与剩余 transaction budget 的较小值。

请求流程：

1. 校验 capability、connection 状态、request cap 和 path fence。
2. 若 parent signal 已 abort 或 deadline 已到，在发 request 前失败。
3. 注册 request token；write 同时注册 active mutation generation。
4. 用公开的 `connection.request(CLIENT_METHODS.fs_*, params, { cancellationSignal })` 发送标准 ACP
   request。
5. response 先到则清理 timer/listener/token，并按现有逻辑处理。
6. user abort 或 deadline 先到则 abort child controller，发送 `$/cancel_request`，本地调用立即
   以 typed boundary error 结束。底层 Promise 必须安装 resolve/reject observer，避免 unhandled
   rejection，并在最终 settle 时清理 active token。
7. write 在 dispatch 后跨过本地 boundary 时，path 转为 quarantined；不能报告确定未写。

所有 timer 在 success、error、abort、timeout 路径都清理并 `unref()`；late response 只能改变
coordinator 的 pending 状态，不能更新 ledger、旧 ToolResult 或当前 generation。

## Path state machine

| 状态 | 允许 user Read | 允许 mutation | 退出条件 |
| --- | --- | --- | --- |
| `clean` | 是 | 是 | mutation lease 开始后进入 `active-mutation` |
| `active-mutation` | 否，fail fast | 否；同一 lease 的 read-back/rollback 除外 | verified/definite completion 回到 `clean`；boundary 或 unverifiable read-back 转入下述状态 |
| `pending-write` | 否，fail fast | 否，fail fast | 底层 write request settle 后进入 `needs-read` |
| `needs-read` | 是，单次 reconciliation | 否；持有匹配 generation 的 compensation lease 除外 | 匹配 generation 的 fresh user Read 成功或明确 not-found 后回到 `clean` |

ToolExecutor 让 remote-owned `Read` 与 `Write` / `Edit` 一样使用同一个 opaque path lock；
local 与 ACP-local Read 仍保持 concurrency-safe。ApplyPatch 继续在工具内部取得同一组 opaque path
locks。这样同 Session、同 normalized path 的 user Read 不会与 mutation preflight、write、read-back
或 compensation 并发。

mutation lease 为每次操作分配单调 generation。reconciliation Read 开始时捕获 generation，完成时
只有在 path 仍处于同一 `needs-read` generation 才能原子更新/清除 ledger 与 quarantine；若期间
rollback 或其他内部 recovery 推进 generation，该 Read 返回稳定的 stale-reconciliation 失败，不能
把新一代 fence 清掉。

普通 timed-out read 不改变文件状态，但仍占一个有界 pending request slot；其 late response 不写
ledger。只有 `Read` 工具在本地 boundary 内得到的成功内容，或明确 not-found，才能执行
reconcile。内部 preflight、exists、read-back 不能解除 quarantine。

任何 `AcpRemoteMutationError` 若最终是 `sideEffectsUncertain: true`，即使 write request 已 settle，
也要把该 path 标为 `needs-read`。普通 `Write` / `Edit` 在 quarantine 上返回稳定失败，提示先
`Read`，且不发新的 ACP request。ApplyPatch compensation 只能凭产生 uncertainty 的同一
transaction generation 获取一次 recovery lease；它不能绕过另一个 transaction 或未知旧 write
留下的 `pending-write` fence。

## Mutation 与 ApplyPatch

`commitVerifiedRemoteTextMutation()` 保持一 write、一 read-back：

- write 使用 user signal 与 30 秒 request deadline，并由 mutation lease 保持 path generation；
- write 在 dispatch 后被 abort/timeout 时直接返回 uncertain，不立即 read-back，因为旧 write 仍
  可能执行；
- write 已 settle 后，无论 ack 成功或普通 error，仍按现有规则执行一次 5 秒 read-back；
- read-back timeout 会发送标准 cancel，并按现有内容矩阵分类；uncertain 结果 quarantine path；
- verified success 更新 ledger 并结束 lease；definite old/missing 不污染 ledger并清理 active state。

ApplyPatch 在获取 workspace/path locks 和执行任何 I/O 前检查所有 target path 的 quarantine。
transaction 使用绝对 deadline；forward budget 到达后停止发布新 change，并进入 compensation。

若当前 write 跨 boundary 且底层仍 pending：

- 不对该 path 立即发送 rollback write，避免 rollback 与旧 forward write 竞态；
- 继续逆序补偿此前已验证的 changes；
- transaction 必须返回 `sideEffectsUncertain: true`，current path 保持 quarantine。

若 forward write 已 settle、只有 read-back 无法验证，持有匹配 transaction generation 的
compensation 可以在 path lock 内尝试恢复；它会推进 generation，任何更早开始的 user Read 都不能
解除这次 recovery fence。

若 rollback write/read-back 自身超时或无法验证，对应 path 保持 quarantine，AggregateError 仍以
原始 forward error 为第一项，rollback errors 按逆序随后排列。所有可验证 rollback 成功后才可清理
对应 path 的 quarantine；整个事务失败时 ledger 不推进。

## Tool 与 UI 语义

- remote `Read` 的 timeout/abort/busy error 使用稳定脱敏文本，不携 Client payload。
- preflight read timeout 没有 write side effect，`sideEffectsUncertain: false`。
- write boundary 或 quarantined mutation 返回
  `write_acknowledged: false`、`write_verified: false`、
  `sideEffectsUncertain: true`，并明确要求 fresh `Read` 后再重试。
- ToolExecutor 在 tool Promise 本地 settle 后释放现有 lock；安全性由 generation-bound quarantine
  fence 保证，
  不让旧 RPC 晚到与新 mutation 交错。
- 现有 generic uncertainty formatter 继续使用；本 patch 不增加 ACP 专属控件。Web GUI 只增加
  regression，证明该 metadata 不改变现有 diff/error 呈现。

## Session lifecycle

- `AcpFileSystemService.dispose()` abort 自身尚在本地等待的 requests，使 Session teardown 有界；
  已跨 boundary 的 SDK Promise 仍由 connection coordinator 观察到最终 settle。
- 同 connection、同 sessionId 的 service 重建继承 path quarantine。
- connection close 清理该 connection generation 的 coordinator；新 connection 不继承内存
  quarantine。跨进程/跨 connection 的安全依赖 ACP transport closure 终止旧 generation，以及
  durable `sideEffectsUncertain` receipt 强制恢复流程重新读取。非合作 Client 在 connection close 后仍
  继续写入属于协议违约，本 patch 不承诺撤销。

## 测试与准出

确定性测试必须覆盖：

- `AgentSideConnection.request()` 收到标准 fs method 和 `cancellationSignal`；
- read/write success、error、abort、timeout 均清理 timer/listener；late fulfill/reject 无 unhandled；
- blocked read/write 在 deadline 后本地 settle，且 request cap 阻止无界积累；
- active/quarantined path cap 阻止对无限多唯一路径制造常驻 fence，且绝不通过 eviction 丢安全状态；
- pending write 期间同 path Read/Write/Edit/ApplyPatch 均在发 request/获取 host-private lock 前失败；
- remote-owned Read 与同 path mutation 共用 opaque lock；不同 path 和 local Read 保持并发；
- late write settle 只把 path 从 `pending-write` 推到 `needs-read`；不会更新 ledger；
- generation-matched fresh user Read success 或明确 not-found 才解除 quarantine；并发旧 Read、internal
  preflight/read-back 不解除；
- quarantine 解除后同 path mutation 可重新执行，其他 path 保持可用；
- ToolExecutor opaque lock 与 ApplyPatch workspace/path locks 在 local deadline 后释放；
- ApplyPatch 不与 pending forward write 并发 rollback，但仍逆序补偿此前 verified files；
- rollback deadline/mismatch/read error 保持 uncertainty 与 AggregateError ordering；
- Session dispose/reload 与 connection close 的 coordinator lifecycle；
- local/ACP-local 行为与 remote metadata/UI projection不回归。

真实资格继续用 `deepseek-v4-flash` 与 `deepseek-v4-pro`、framework retry 0。Provider 轨迹证明
正常 production paired ACP Read/Write 路径与 teardown 不回归；blocked/cancel/late-response 故障矩阵
留在 deterministic paired protocol tests，避免用付费模型制造非确定性 transport 故障。

发布前必须运行 focused lifecycle/ownership/lock/ApplyPatch/UI suites、type-check、lint、build、
完整 `test:all` 和双模型 real ACP qualification，并在中英文 evidence 中记录 hash-only 结果。

## 后续独立 patch

ACP `tool_call_update` 对 file diff 的 receipt 投影是下一项独立可诊断性工作。它会让 IDE 用户
直接看到 `write_acknowledged` / `write_verified` / `sideEffectsUncertain` 与 re-read guidance，
但不与本次 request lifecycle correctness patch 混合。
