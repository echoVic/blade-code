# ACP Filesystem Request Lifecycle

Blade 为 ACP remote text filesystem 引入了 connection-scoped request coordinator。
它把每个远端文本请求统一收敛到公开 ACP SDK 1.3.0 typed request API、
本地绝对 deadline、有限并发槽位，以及 generation-safe path quarantine，
同时保持 local 与 ACP-local 文件语义不变。

## Public API And Cancellation

- 远端文本请求统一通过公开的
  `AgentSideConnection.request(method, params, { cancellationSignal })` 发起。
- Blade 使用 ACP 标准 `$/cancel_request` 传播取消；实现依赖 SDK 的
  `cancellationSignal`，不访问私有字段，也不引入额外协议方法。
- 取消是 cooperative 的本地边界，不是远端未写入的证明。
  如果本地边界发生在 request 已 dispatch 且仍 pending 时，Blade 只能把该路径留在
  quarantine 中，直到后续结算或显式 reconciliation。
- `AcpRemoteFileBoundaryError` 只暴露边界原因、读写类型，以及 request 是否已经
  dispatch / pending；不会暴露 raw path、content、digest、credential 或 client-private
  error。

## Deadlines, Slots, And Retained Paths

- 普通 remote text read/write 默认 deadline 为 `30_000ms`。
- mutation read-back 验证 deadline 为 `5_000ms`。
- remote `ApplyPatch` forward phase 总预算为 `120_000ms`。
- 独立 compensation / rollback recovery budget 为 `60_000ms`。
- host-private workspace lock acquisition 继续沿用既有 `10_000ms` 预算；
  本轮没有改变该锁的本地语义。
- coordinator 最多保留 `32` 个 remote request slot：
  `31` 个 ordinary request 加 `1` 个 serialized recovery lane。
- retained mutation path 上限是 `1024`。达到上限时直接以容量边界失败；
  不做 eviction，也不会为了新请求移除已有 fence。

## Request State And Mutation State

coordinator 明确分离 request token 与 mutation path state。

### Request token

- ordinary request 与 recovery request 分开计数；
- 普通 user Read 对同一 normalized path 只允许一个 active normal Read；
- 一个已经跨过本地边界但底层 request 仍 pending 的 normal Read 会继续占用自己的
  request token，直到 SDK settle；
- 这种 detached normal Read 只阻止同路径重复 Read，不阻止 mutation lease 获取。

### Mutation path state

每个 opaque path 只保留以下状态之一：

- `active-mutation`
- `pending-write`
- `needs-read`
- `reconciling`

lease 还区分：

- `active`
- `recovery`

语义如下：

- `active-mutation` 表示当前 connection generation 已取得 mutation lease，
  preflight / write / read-back 仍在该 generation 内推进。
- `pending-write` 表示某次 write 已 dispatch，但本地边界先返回，
  Blade 不能证明远端未写入。
- `needs-read` 表示该 generation 留下 fail-closed fence，必须由后续 fresh user Read
  清除。
- `reconciling` 表示 recovery lane 上的 originating-session user Read 正在尝试清除
  `needs-read`。

状态迁移重点：

- 已 dispatch 的 write 若先跨本地边界，不会直接回到 clean，而是
  `pending-write -> settle -> needs-read`。
- 只有 originating Session 的 fresh user Read 且 generation 匹配时，才能把
  `needs-read` 清除。
- generation 匹配的 successful reconciliation，或 explicit-not-found
  reconciliation，都会把该路径恢复到 clean。
- 如果 reconciliation 自身先跨过 local boundary，则该 recovery-lane request 直到
  底层 settle 前都不能清 ledger；一旦它以同 generation 的 pending 边界返回，
  settle 后会重新回到 `needs-read`。
- 其他 Session 的 Read、过期 generation 的 Read，或内部 preflight/read-back，
  都不能清除该 fence。

## Path Identity, Sessions, And Generations

- coordinator 只保留 opaque path identity：
  `acp-remote-connection-path:<sha256(normalizedPath)>`。
- identity 基于已规范化的绝对路径，但 retained state 与日志里都不保留 raw path。
- 同一 `AgentSideConnection` 内，same normalized path 会跨 Session 共享同一个 fence。
  这意味着一个 Session 留下的 `pending-write` / `needs-read` 会阻止同 connection 上
  其他 Session 对同路径做不安全读写。
- 新的 ACP connection 会创建新的 coordinator generation；旧 connection close 时，
  其 generation 一并结束。
- 因为当前保证只在 in-process、per connection 范围内成立，所以这不是跨进程、
  跨 transport 重连、跨 host 的全局事务协议。

## Read Reconciliation Rules

- 普通 user Read 使用 normal lane。
- 当同路径处于 `needs-read`，且请求来自 originating Session、generation 匹配时，
  coordinator 会把这次 user Read 提升为 recovery lane。
- recovery lane 仍然是标准 ACP text read，不改变 `readTextFile` 协议面；
  它只是占用保留的第 32 个 slot，并在本地完成 generation 检查后决定是否更新 ledger。
- 明确的 not-found reconciliation 也能清除 originating generation 的 fence；
  但 late settle、stale generation、other Session 都不能越权清理。
- late settle 或 stale generation 也不能回写 ledger；ledger 只允许由 generation-matched
  user reconciliation 在本地边界内完成更新。

## Write, Edit, And Lease Ordering

- remote `Write` / `Edit` 在 preflight 前先获取 mutation lease。
- lease 以 normalized path 为粒度，确保同 connection 内对同一路径的跨 Session
  mutation fail closed。
- 对现有文件，Write / Edit 仍要求 prior matching user Read digest；
  本轮没有改变 read-before-write barrier，只是把 request lifecycle 收紧为有界、
  可取消、带 generation fence 的流程。
- local / ACP-local backend 继续使用既有本地语义；本轮收紧仅作用于 remote-owned
  text filesystem。

## Remote ApplyPatch Ordering

remote `ApplyPatch` 继续只支持 `Update File`，并遵守现有 parser 的
`MAX_PATCH_OPERATIONS = 100` 上限。

顺序约束如下：

1. 先做 remote lifecycle precheck 与 normalized-path quarantine 预检查，
   这一步在 host-private transaction state 创建前完成；
2. 再获取 workspace lock；
3. 再按排序后的 opaque path locks 串行进入；
4. 然后原子获取 coordinator mutation leases；
5. 最后才执行 remote preflight、forward writes、逐写 read-back 和必要的 compensation。

补偿与 ledger 规则：

- 已知仍处于 `pending current` 的写入绝不进入 rollback。
- 只有 verified prefix 可以进入逆序 compensation。
- 对已经 settled 但仍 unverifiable 的 current write，只允许由产生该 uncertainty 的
  同一 transaction generation 尝试 recovery。
- 另一 transaction generation，或仍处于 `pending-write` 的旧状态，都不能绕过这条
  recovery ownership 约束。
- 整个 transaction 只有在 forward / compensation 全部完成并通过最终 barrier 后，
  才会提交对应 ledger 结果。
- 这不是 ACP 原生 multi-file transaction；它只是 Blade 在本地 host-private state 上
  实现的 bounded orchestration。

## Stable Uncertainty Metadata

当边界发生时，Blade 继续输出稳定、脱敏的 uncertainty metadata 与 guidance：

- `write_acknowledged`
- `write_verified`
- `sideEffectsUncertain`
- `requiresRead`

含义是：

- `sideEffectsUncertain: true` 只表示最终远端状态未被证明；
  调用方应先重新 `Read`，而不是盲目重放。
- `write_acknowledged: false` 不等于“远端一定没写”。
- `write_verified: false` 不等于“远端一定失败”。
- `requiresRead: true` 表示同一 connection / normalized path 上仍存在
  `pending-write` 或 `needs-read` fence，必须由 originating Session 的 fresh user
  Read 完成 generation-matched reconciliation 后，才能安全重试。
- `requiresRead` 不是通用 UI retry 按钮，也不证明该写入已经成功或已经失败。

这些字段保持 generic、sanitized 表达，不投影 raw ACP receipt、raw response body、
或 remote-private evidence。

## UI And Explicit Non-Goals

- Web `FilePreview` 继续渲染通用 diff / uncertainty metadata；
  本轮没有新增 ACP 专属 receipt UI projection。
- ACP-local 与 local backend 的工具输出、锁语义、fallback 语义保持不变。
- 本轮不声称支持以下能力：
  - binary filesystem operations
  - `stat`
  - `mkdir`
  - `delete`
  - `rename`
  - remote parent directory creation
  - native ACP multi-file transaction
- 本轮也不承诺处理 non-cooperative client 在 connection close 后继续违约写入的情形；
  connection close 只能结束本地 generation，不能撤销协议面外的远端副作用。

## Related Evidence

- [ACP Filesystem Request Lifecycle Evidence](../testing/acp-filesystem-request-lifecycle-evidence.md)
- [Atomic ApplyPatch](atomic-apply-patch.md)
- [MCP Session Isolation](mcp-session-isolation.md)
