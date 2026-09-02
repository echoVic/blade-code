# ACP Filesystem Request Lifecycle

Blade 现在把 ACP remote text filesystem 视为一个带冻结 path profile 的独立执行面。
它保留大小写敏感的 remote wire path 作为 RPC 输入，同时把 exact ledger authority、
collision fencing、durable remote workspace identity、capability-aware runtime
boundary 与 ordered remote `ApplyPatch` preflight 统一到一条 fail-closed 生命周期里。
local 与 ACP-local 文件语义保持不变。

## Frozen Path Profile

- 每个 ACP remote filesystem Session 在创建时都会从 authoritative workspace root
  冻结一个 `AcpRemotePathProfile`；之后同一个 Session 内不再重新猜测 path style。
- frozen profile 只接受一种 style：`posix` 或 `win32`。
- 对 remote ownership 而言，Session 会分离三种 root：
  - `executionRoot`：remote wire root，只用于 ACP 文件 RPC 和显式 ACP terminal。
  - `hostStateRoot`：配置的 Blade storage root（默认 `~/.blade`）下的 host-private
    durable state scope，只用于 transcript、inbox、goal、lease、browser artifacts 等私有状态。
  - `hostResourceRoot`：进程构造时捕获的可信 host cwd，只用于显式 Client-supplied
    stdio MCP server 的 host cwd；它不是 remote project root。
- duplicate `initializeSession()` 仍然是早期 no-op，不会替换已冻结 profile。
- 在 POSIX host 上，既有 configured storage root 必须由当前用户拥有、为 owner 提供
  `rwx`，且禁止 group/world 写入；remote namespace 与 digest leaf 继续使用更严格的
  private `0700` mode。
- local 与 ACP-local Session 不进入这套 remote path/profile 规则，继续保留既有本地行为。

## Case-Preserving Wire Paths

- `wirePath` 是真正发给 ACP Client 的 remote path。
- Windows remote path 会把 drive letter 规范为大写并统一输出反斜杠，但保留其余路径组件的原始大小写。
- POSIX remote path 保持既有大小写与普通字符语义，不做 Unicode 规范化。
- `wirePath` 仅承担 remote RPC path 的职责，不承担 host path、Git path 或配置根路径的职责。

## Exact Authority And Collision Fencing

- 每个已解析 remote path 都派生两种 identity：
  - `exactIdentity`：基于 `style + NUL + wirePath` 的 SHA-256；它是 read-before-write
    ledger authority，不能被 collision-only match 替代。
  - `collisionIdentity`：基于 `style + NUL + collision-form` 的 SHA-256；它只用于保守的
    coordination、lock、quarantine 和 host-private durable state bucket。
- 对 Windows，collision form 使用确定性的 `toUpperCase()` 形式；它可能保守合并更多
  spelling，但不会获得 exact ledger authority。
- 同一 `AgentSideConnection` 内，same collision identity 会共享 fail-closed fencing；
  这能阻止 uncertain write 被大小写别名绕过。
- 这不是跨进程、跨 reconnect、跨 host 的全局事务协议，只保证当前进程内、当前连接内的保守 fencing。

## Windows Path Validation

Blade 对 Windows remote path 采用 fail-closed 词法校验，不访问宿主文件系统，也不试图猜测远端真实物理文件标识。

### Accepted shape

- 仅接受 drive-absolute 路径：`X:\\...` 或 `X:/...`。
- 远端 workspace root 与单文件路径必须与 frozen style 一致。

### Rejected spellings

- UNC 路径：`\\\\server\\share\\...`
- device namespace：如 `\\\\?\\`、`\\\\.\\`
- drive-relative：如 `C:foo`
- root-relative：如 `\\foo`、`/foo`
- alternate data streams：如 `file.txt:stream`、`file.txt::$DATA`
- trailing dot / trailing space 组件：如 `file.ts.`、`file.ts `
- reserved device names，包括扩展名与 superscript 变体：
  `CON`、`PRN`、`AUX`、`NUL`、`CONIN$`、`CONOUT$`、`COM1..COM9`、`LPT1..LPT9`、
  `COM¹/²/³`、`LPT¹/²/³`
- 常见 `~digit` 短文件名拼写：如 `FOO~1.TXT`
- 非法字符：`< > " | ? *`、U+0000..U+001F

这些拒绝项发生在任何 host-private state、lock、lease 或 RPC 之前。

## Typed Error Codes

远端路径与 patch preflight 只暴露稳定、脱敏的错误。ACP setup/request failure 包含
typed code 与 reason；single-file ToolResult 的路径语法失败只暴露
`acp_remote_path_invalid` 和固定 message，而 session/capability failure 保留各自的稳定
错误。patch preflight ToolResult 还会暴露下列 typed reason。这些错误都不会回显 raw
path、basename、digest、remote 内容或 host path。
对已成功解析的 remote single-file 请求，RPC、成功文本与 `metadata.file_path` 统一使用
canonical `wirePath`；summary 的 basename 按 remote path style 提取，不依赖 Blade host
的 path separator。remote Read/Edit 的 not-found 与 Edit string-not-found 结果使用固定
脱敏文案；共享 tool-display formatter 只提升 allowlist 中的固定 ACP 错误，其他失败继续
显示通用错误，避免把 Client 私有 detail 带到 TUI、ACP、Headless 或 Web SSE。

### Path syntax

- `acp_remote_path_invalid`
  - `not-absolute`
  - `style-mismatch`
  - `drive-relative`
  - `root-relative`
  - `unc-not-supported`
  - `device-namespace-not-supported`
  - `trailing-dot-or-space`
  - `alternate-data-stream`
  - `reserved-device-name`
  - `short-name-alias`
  - `invalid-character`

### ApplyPatch preflight

- `acp_remote_patch_invalid`
  - `unsupported-operation`
  - `workspace-escape`
  - `restricted-path`
  - `duplicate-target`

`ApplyPatch` 的 pure preflight 在 lock、lease、transaction journal 与远端 RPC 之前完成；它只允许 update-only remote patch，并继续遵守 `MAX_PATCH_OPERATIONS = 100`。

### Remote workspace and session lifecycle

- `acp_remote_tool_unavailable`
  - reason：`host-only`、`read-required`、`read-write-required` 或
    `terminal-required`
- `acp_remote_task_isolation_unsupported`
  - reason: `remote task isolation is not supported`
- `acp_remote_workspace_mismatch`
  - reason: `exact-identity-mismatch`
- `acp_remote_workspace_state_invalid`
  - 用于 durable remote workspace descriptor / protected scope 损坏或不一致；它属于 durable-state failure，不回退为 host workspace。
- `acp_session_unavailable`
  - 表示 ACP Session filesystem 不可用；remote mutation 结果保持 fail-closed。

只有请求参数或 setup 期的确定性失败投影为 redacted `invalidParams`。runtime capacity、持久化 I/O、fork/load 失败与 runtime 初始化错误仍保持各自的内部失败分类。

## Request Lifecycle, Leases, And Reconciliation

- remote text request 统一走公开
  `AgentSideConnection.request(method, params, { cancellationSignal })`。
- cancellation 继续通过标准 ACP `$/cancel_request` 传播；这是 cooperative local boundary，不是“远端一定未写入”的证明。
- `AcpRemoteFileBoundaryError` 只记录 boundary reason、操作类型，以及请求是否已
  dispatch / 仍 pending；不包含 raw path、content、digest、credential 或 Client 私有错误。
- 默认 request budget 仍为：
  - ordinary remote read/write：`30_000ms`
  - mutation read-back：`5_000ms`
  - remote `ApplyPatch` forward phase：`120_000ms`
  - compensation / rollback recovery：`60_000ms`
- host-private workspace lock 仍使用 `10_000ms` acquisition budget。
- coordinator 保留 `31` 个 ordinary slot 与 `1` 个 recovery lane，共 `32` 个 remote request slot；retained mutation path 上限仍是 `1024`。
- request token 与 mutation state 相互独立。同一 collision identity 最多允许一个
  ordinary user `Read`；detached Read 会保留 token 直到 SDK request settle，但不会阻止
  mutation lease 获取。
- mutation state 只会是 `active-mutation`、`pending-write`、`needs-read` 或
  `reconciling`；lease 分为 `active` 与 `recovery`。
- remote `Write` / `Edit` 仍要求 prior matching user `Read` digest；本轮没有削弱 read-before-write barrier。
- dispatched write 跨过 local boundary 时仍保持
  `pending-write -> settle -> needs-read`；
  只有 originating Session 且 generation 匹配的 fresh user `Read` 才能清掉 fence。
- reconciliation 使用保留的 recovery lane。明确的 not-found 结果也可清掉匹配的
  fence；其他 Session、stale generation、内部 preflight/read-back 或 late settlement
  都不能清除它。
- 新 ACP connection 拥有新的 coordinator generation。关闭 connection 只结束本地
  generation，不能撤销协议边界之外的远端副作用。

## Remote ApplyPatch Ordering

remote `ApplyPatch` 继续只支持 `Update File`，并要求 ordered pure preflight：

1. 先做 remote path parse、workspace containment、restricted target、duplicate target 检查；
2. 只有 preflight 通过后，才进入 host-private workspace lock；
3. 再获取排序后的 opaque path locks；
4. 再原子获取 coordinator mutation leases；
5. 最后才执行 remote preflight read、forward writes、read-back 与必要的 compensation。

重要边界：

- pure preflight 不创建 host-private transaction state；
- pending current write 不进入 rollback；
- 只有 verified prefix 能进入逆序 compensation；
- 已 settle 但仍 unverifiable 的 current write 只能由产生该 uncertainty 的同一个
  transaction generation 恢复；
- ledger outcome 只会在最终 whole-transaction barrier 完成后提交；
- 这不是 ACP 原生 multi-file transaction，而是 Blade 在 host-private state 中实现的 bounded orchestration。

## Stable Uncertainty Metadata

边界结果继续使用脱敏字段 `write_acknowledged`、`write_verified`、
`sideEffectsUncertain` 与 `requiresRead`。

- `sideEffectsUncertain: true` 只表示最终远端状态未经证明；调用方必须先重新 `Read`
  再重试。
- `write_acknowledged: false` 不证明远端一定未写入，`write_verified: false` 也不证明
  写入一定失败。
- `requiresRead: true` 表示必须由匹配的 fresh user `Read` 清理 `pending-write` 或
  `needs-read` fence 后，重试才安全；它不是通用 retry 信号。
- 这些字段不会投影 raw ACP receipt、response body 或 remote-private evidence。

## Runtime Capability Boundary

- ACP remote ownership 会禁用没有 ACP 等价能力的 host-only workspace 功能。
- remote `Read` 只在 remote read capability 存在时注册。
- remote `Write` / `Edit` / `ApplyPatch` 要求同时具备 remote read 与 write capability。
- `Bash` 仅在 terminal capability 存在时注册；没有 terminal capability 时不会回退到 `LocalTerminalService`。
- Background Bash、WriteStdin、KillShell、host workspace config / hooks / LSP /
  plugin / skill / command discovery、Git / code review / AutoVerify、本地 patch recovery、
  attachment expansion 等 host-only 能力都不会因为 remote `cwd` 被重新开启。
- remote task isolation 明确不支持；ACP 远端 workspace 不会被传给 host-native `SessionTaskService`、Git 或 worktree 流程。

## Arbitrary Short-Name Limitation

- Blade 当前会拒绝常见 `~digit` 8.3 spelling，以防常见短文件名别名绕过 fencing。
- 但纯词法校验无法识别所有管理员手工配置或远端文件系统自定义的 short-name alias。
- 因此本轮只提供“常见短文件名 fail closed”，不声称彻底解决所有 Windows short-name identity 问题。
- 要完整解决 arbitrary short-name identity，需要未来 ACP 或 Client 提供稳定 file identity / canonical path 能力；这不在本轮范围内。

## Local And ACP-local Compatibility

- local backend 继续使用既有本地文件、锁、Git、runtime 与 workspace 资源语义。
- ACP-local Session 继续沿用 host-native lifecycle，不会因为本轮 remote path hardening 被强制切换到 remote state scope。
- Web `FilePreview` 继续呈现通用 uncertainty metadata，本轮不会新增 ACP 专属 receipt UI。
- 完整 Web remote-session catalog/load/fork、remote file browser 与 owner-bound remote
  terminal bridge 不在本版本范围内；Web 的 local catalog 不会把 remote `hostStateRoot`
  当成可浏览 workspace。

## Explicit Non-Goals

- UNC / device namespace 支持
- host filesystem canonicalization
- native ACP multi-file transaction
- remote parent directory creation
- binary filesystem operations
- `stat`
- `mkdir`
- `delete`
- `rename`
- non-cooperative client 在 connection close 后继续越权写入时的撤销保证

## Related Evidence

- [ACP Win32 Remote Path Identity Evidence](../testing/acp-win32-remote-path-identity-evidence.md)
- [ACP Filesystem Request Lifecycle Evidence](../testing/acp-filesystem-request-lifecycle-evidence.md)
- [Atomic ApplyPatch](atomic-apply-patch.md)
- [MCP Session Isolation](mcp-session-isolation.md)
