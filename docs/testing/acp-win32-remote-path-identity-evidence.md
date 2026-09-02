# ACP Win32 Remote Path Identity 资格验证证据

## 2026-09-02 Release Metadata Qualification

- 设计规格：`docs/superpowers/specs/2026-08-31-acp-win32-remote-path-identity-design.md`
- 实施计划：`docs/superpowers/plans/2026-08-31-acp-win32-remote-path-identity.md`
- 目标版本：`0.10.128`
- 基线版本：`v0.10.127`
- 当前代码资格验证 HEAD：`84cc8d8f0dc5a5bbdbe2d1f9f407ae7638551aa8`
- 实现与资格验证支撑提交范围：`80649698` 到 `84cc8d8f`
- 范围：记录 ACP Win32 remote path identity hardening 的文档与 release-metadata 证据，覆盖 Task 1-8 的 causal RED / GREEN 责任边界、提交职责、双语文档覆盖范围、独立审查状态、最终仓库门禁与当前限制。
- 安全主张：Blade 对 ACP remote Windows path 采用冻结 path profile、case-preserving wire path、exact ledger authority、collision fencing、host-private durable state scope、remote capability boundary 与 ordered pure remote ApplyPatch preflight；这些边界不改变 local 与 ACP-local 语义。
- 限制：本证据不声称支持 UNC、device namespace、native ACP multi-file transaction、remote parent mkdir、binary/stat/delete/rename/mkdir、cross-process fencing，或 arbitrary short-name 的完整识别。

## Prompt-To-Artifact Matrix

| Surface | Prompt / input | Expected artifact | Current evidence |
| --- | --- | --- | --- |
| Remote path parser | Windows / POSIX absolute path, style expectation | `AcpRemotePath` with frozen style, `wirePath`, `exactIdentity`, `collisionIdentity`, or redacted `acp_remote_path_invalid` | 由 Task 1 实现 |
| Remote Session durable identity | `session/new`, `session/load`, `session/fork`, `session/list` with ACP remote `cwd` | protected `hostStateRoot`, immutable remote workspace descriptor, `cwd` surfaced back as `wirePath` | 已实现；见 Task 2-4 提交与 reference 文档 |
| Runtime capability boundary | ACP remote Session with or without read/write/terminal capabilities | only remote-safe tool surface; host-only workspace features absent | 已实现；见 Task 4-5 提交与 reference 文档 |
| Runtime and terminal policy | ACP remote Session with or without read/write/terminal capabilities | capability-gated Read / Write / Edit / ApplyPatch / Bash，不回退 host | 由 Task 5 实现 |
| Remote identity consumers | collision-equivalent 与 exact-distinct path spelling | exact ledger authority，以及 collision-keyed lock / quarantine coordination | 由 Task 6 实现 |
| Remote single-file tools | unsafe remote path 上的 Read / Write / Edit | 在 worktree、permission、hook、scheduler、lock、invocation 或 ACP request 前拒绝 | 由 Task 7 实现 |
| Remote ApplyPatch | update-only remote patch | pure remote preflight before lock / lease / transaction state, typed `acp_remote_patch_invalid` on invalid target | 已实现；见 Task 8 提交 |
| Release qualification | focused deterministic suite、real paired ACP qualification、GUI/TUI surface suites、whole-patch reviews、final repo gates | exact counts、review verdicts、final pass/fail totals | 已记录，包括未改动测试的间歇失败与精确复跑 |

## Task 1-8 Causal RED 与已提交实现责任

### Task 1: Introduce the pure remote path model

- 计划位置：Task 1，Step 2 / Step 4。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/remote-path.test.ts
```

- 首个因果 RED：`AcpRemotePath.ts` 尚不存在，导入/API 失败，无法断言 style inference、大小写保留、exact/collision identity 分离与 redacted typed errors。
- 已提交实现责任：`80649698 feat(acp): define remote path identities`。

### Task 2: Add the durable remote workspace descriptor and protected state scope

- 计划位置：Task 2，Step 2 / Step 7。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/remote-workspace.test.ts \
  tests/unit/agent-runtime/context/storage-path-utils.test.ts
```

- 首个因果 RED：descriptor、protected scope、direct remote state helper 与 remote namespace enumeration API 尚不存在。
- 已提交实现责任：`6c4235b9 feat(acp): define protected remote state scopes`、`aff1755a feat(acp): persist remote workspace identity`、`60376429 feat(acp): isolate remote session catalogs`，以及文档提交 `0e0a162e docs(acp): harden remote state scope contract`。

### Task 3: Route ACP lifecycle through explicit Session roots

- 计划位置：Task 3，Step 2 / Step 4。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-session-fork.test.ts
```

- 首个因果 RED：当时代码仍把 remote `cwd` 当作单一 root 传入 Session/SessionService，缺少 `hostStateRoot` / `executionRoot` / `hostResourceRoot` 分离与 durable descriptor 校验。
- 已提交实现责任：`1e668f36 feat(acp): support remote session forks`、`09558241 feat(acp): load remote session history`、`6c3e8bcf feat(acp): update remote session metadata`、`fcf9e928 fix(acp): separate remote session roots`，以及文档提交 `d0dd740f docs(acp): isolate remote session roots`。

### Task 4: Separate Runtime state from remote execution

- 计划位置：Task 4，Step 2 / Step 4。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/prompts/system-prompt.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/apply-patch-tool.test.ts
```

- 首个因果 RED：Runtime 仍会把 remote workspace root 误用于 host state、workspace resource loading、prompt project path 与 host-only recovery seam。
- 已提交实现责任：`e6d42241 fix(runtime): isolate ACP remote execution`。

### Task 5: Enforce the remote capability matrix and terminal boundary

- 计划位置：Task 5，Step 2 / Step 4。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/tooling/tools/builtin/bash.test.ts \
  tests/unit/tools/execution/workspace-tool-policy.test.ts
```

- 首个因果 RED：remote Session 仍暴露 host-only workspace capability，且 terminal 缺失时存在 local fallback 风险。
- 已提交实现责任：`b4937af0 fix(acp): fail closed on host-only capabilities`。

### Task 6: Separate exact ledger authority from collision fencing

- 计划位置：Task 6，Step 2 / Step 5。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/file-lock-manager.test.ts
```

- 首个因果 RED：exact read authority 与 collision lock/quarantine 仍然共用一个 identity，Windows 大小写别名可绕过 fencing 或错误复用授权。
- 已提交实现责任：`98a2dc88 fix(acp): fence Windows remote path aliases`。

### Task 7: Reject invalid remote single-file tools before side effects

- 计划位置：Task 7，Step 2 / Step 4。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/file-lock-manager.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/tool-executor.test.ts \
  tests/integration/acp-remote-file-tools.test.ts
```

- 首个因果 RED：unsafe remote path 在最终 fail-closed parse / validation gate 之前就可能进入 lock、lease、permission 或 RPC 路径，无法证明“side effects 之前 fail closed”。
- 已提交实现责任：`3a7d9b64 fix(acp): reject unsafe remote file paths`。

### Task 8: Add one pure pre-lock remote ApplyPatch preflight

- 计划位置：Task 8，Step 2 / Step 4。
- 因果 RED 命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-remote-file-tools.test.ts
```

- 首个因果 RED：remote `ApplyPatch` 仍在 host-private workspace lock / transaction state 之后才统一做 path 纯校验，无法证明 pure preflight 在 side effects 前完成。
- 已提交实现责任：`d6c8fb45 fix(acp): preflight remote patch paths`。

## Implementation Commit Responsibilities

| Commit | Responsibility |
| --- | --- |
| `39e8837e` | 撰写 ACP Win32 remote path identity 设计规格 |
| `46ada390` | 撰写 ACP Win32 remote path hardening 实施计划 |
| `80649698` | 引入纯 `AcpRemotePath` 模型、style inference、redacted typed errors、exact/collision identities |
| `d0dd740f` | 记录 remote Session roots 分离与生命周期要求 |
| `0e0a162e` | 收紧 protected remote state scope 的文档契约 |
| `6c4235b9` | 引入 protected remote state scope 与 direct remote storage helpers |
| `aff1755a` | 持久化 immutable remote workspace descriptor |
| `60376429` | 将 remote Session catalog 与 local catalog 分离 |
| `1e668f36` | 支持 remote Session fork 与 descriptor 复制 |
| `09558241` | 支持 remote Session load/history 恢复 |
| `6c3e8bcf` | 更新 remote Session metadata threading |
| `fcf9e928` | 分离 ACP remote Session roots，修正 new/load/fork 生命周期 |
| `e6d42241` | 将 Runtime host state 与 remote execution 分离 |
| `b4937af0` | 对 host-only capabilities、terminal fallback 与 remote-safe tool surface fail closed |
| `98a2dc88` | 将 exact ledger authority 与 collision fencing 分离，收紧 Windows alias 路径 |
| `3a7d9b64` | 在 single-file remote tools 上提前拒绝 unsafe remote paths |
| `d6c8fb45` | 为 remote `ApplyPatch` 增加 pure pre-lock preflight |
| `7aa6d996` | 以 production protected state scope 要求的 `0700` mode 创建 real-API fixture storage root |
| `af49ad5a` | 兼容 same-owner、owner 可访问、group/world 不可写的 configured storage root，并保持 remote namespace 与 leaf 严格 `0700` |
| `5b87d3da` | 将两个 local file/snapshot unit fixture 的不完整 `AcpServiceContext` 整模块 mock 改为 typed `importOriginal` partial mocks；未修改 production code |
| `2a2eefa9` | 让 TUI、ACP、Headless 与 Web SSE 共用的 formatter 展示 allowlist 内的固定 ACP filesystem 错误，同时继续隐藏未知 Client detail |
| `f7945c30` | 统一 remote Read/Write/Edit 的 canonical `wirePath` metadata、成功文本与跨 host basename，并脱敏 not-found / string-not-found 失败 |
| `84cc8d8f` | 从 ToolExecutor invalid-path preflight 与 unknown-session Write/Edit 结果中移除 raw path metadata，并从 helper 类型层关闭重新引入入口 |

## Review Verdicts

- Specification review：`APPROVED`；Critical `0`、Important `0`、Minor `0`。
- Quality / security / concurrency review：最初发现 configured storage-root mode
  规则存在一个 Important 生产兼容性问题；提交 `af49ad5a` 修复后，同一审查员复审为
  APPROVED，Critical `0`、Important `0`。
- 一条晚到的 Task 7 generic `path` / `affectedPaths()` 意见已经复现并经独立裁决。
  它不属于规格限定的 `file_path` / `notebook_path` lock-input contract，也未找到从这些
  generic value 进入 Blade ACP 或 host filesystem I/O 的生产链。因此它保留为未来的
  generic-tool contract hardening 建议，不阻塞本次发布。
- `5b87d3da` 的 tests-only closure 经独立规格与质量复审，均为 `APPROVED`，
  Critical `0`、Important `0`；审查中仅保留既有弱断言和小型测试 mock 作为
  non-blocking test debt。
- `2a2eefa9` 首轮独立复审发现真实 `ApplyPatch` capability 文案未进入 allowlist；补充
  causal RED 后修复，最终复审为 Critical `0`、Important `0`、Minor `0`。
- `f7945c30` 首轮独立规格与质量复审发现五个 failure branch 仍返回原始输入路径；
  补充 Windows noncanonical RED 后统一为 canonical `wirePath`，最终两轮复审均为
  `APPROVED`，Critical `0`、Important `0`。
- `84cc8d8f` 修复最终 whole-patch review 发现的两个 raw-path metadata 泄露入口；
  focused unit `46/46`、integration `83/83` 通过，独立规格与质量复审均为
  `APPROVED`，Critical `0`、Important `0`。

## Focused Verification Status

### Focused deterministic verification

- candidate 基线：
  - `date +%F` = `2026-09-02`
  - `git rev-parse HEAD` = `84cc8d8f0dc5a5bbdbe2d1f9f407ae7638551aa8`
  - `git log --oneline v0.10.127..84cc8d8f` 共 `23` 个代码与资格支撑提交，
    范围与上表一致
- 当前版本基线：
  - `packages/cli/package.json` 在写入前为 `0.10.127`
  - 本轮 release metadata 目标是 `0.10.128`

- 最终 production fix 后的 unit focused suite：`8` 个文件，`381/381` tests passed，
  exit `0`，Vitest duration `9.54s`。
- integration focused suite：`6` 个文件，`190/190` tests passed，exit `0`，
  Vitest duration `5.78s`。
- Web `FilePreview`：计划命令首次从 `packages/cli` 执行时因 Web config root
  实际位于 `packages/cli/web`，正确返回 `No test files found`；从该 root 对同一目标
  重跑后，`1` 个文件、`21/21` tests passed，exit `0`，Vitest duration `3.51s`。
- remote result canonicalization 与 redaction focused integration：`1` 个文件、
  `83/83` tests passed，exit `0`，Vitest duration `1.85s`。
- TUI / shared surface error formatting：`1` 个文件、`18/18` tests passed，exit `0`；
  加上真实 Ink input/pager 与 session selector 后，`5` 个文件、`39/39` tests passed，
  Vitest duration `4.41s`。当前环境没有 computer-use 浏览器控制能力，因此没有声称
  执行 TUI 视觉自动化；真实 stdin/stdout/Ink integration 是本轮 TUI 证据。
- GUI/Web focused suite 覆盖 `FilePreview`、`PreviewDiffList`、`ChatMessage`、
  `Layout`、`sessionNavigation` 与 `sessionSlice`：`6` 个文件、`130/130` tests passed，
  exit `0`，Vitest duration `3.69s`。

### Real production-Agent qualification

- required models：`deepseek-v4-flash` 与 `deepseek-v4-pro`。
- framework retry budget：`0`；model `maxRetries`：`0`；两模型 stop reason 均为
  `end_turn`。
- 首个 causal RED 发生在任何 model request 之前：两条 case 分别在 `16ms` 与 `7ms`
  以同一个脱敏 protected-state error 失败。测试 fixture 未预建注入的
  `BLADE_STORAGE_ROOT`；本地 mode probe 证明递归创建会得到 `0755`，而当时的
  production boundary 要求 `0700`。
- 修复：提交 `7aa6d996` 只以 `0700` 预建隔离 fixture 的 storage root。独立规格与
  quality/security 审查均确认这是 fixture correction，没有放宽 production validation。
- 随后的 whole-patch review 发现同样严格的 storage-root 规则可能拒绝既有 Blade
  安装。提交 `af49ad5a` 只在 storage root 由当前用户拥有、owner 有 `rwx` 且
  group/world 不可写时接受它；namespace 与 leaf 继续严格为 `0700`。对应 TDD RED
  拒绝 `0755` root；GREEN 通过 `0755` accept 与 `0770` reject，相关 suite 通过
  `24/24`。
- 在 `af49ad5a` 上使用原 release command 和 `--retry=0` 的最终 GREEN：`1` 个文件，
  `2/2` tests passed，exit `0`；Flash `12.105s`，Pro `7.868s`，Vitest 总 duration
  `23.56s`。
- 在最终 code candidate `f7945c30` 上重跑时，Flash 首轮通过，Pro 连续两次在
  `outputStarted=false`、`toolExecutionStarted=false`、`toolCallsCount=0` 的首个 provider
  请求阶段返回 retryable `api_error`。同 endpoint/model 的最小请求随后返回 HTTP `200`；
  原样双模型矩阵再次以 `--retry=0` 执行后 `2/2` 通过：Flash `5.263s`、Pro
  `47.805s`，Vitest 总 duration `57.32s`。这些失败按外部 provider 瞬态如实保留，
  没有用 framework 或 model retry 隐藏。
- 在最终代码资格验证 HEAD `84cc8d8f` 上，原样双模型矩阵再次以 framework retry
  `0`、model `maxRetries=0` 执行并通过 `2/2`：Flash `4.922s`、Pro `6.972s`，
  Vitest 总 duration `16.60s`。
- 两个模型都得到有界序列 `read:source`、`read:output`、`write:output`、
  `read:output`，恰好一个 successful write result；host source canary 保持不变、host
  output parent 不存在，remote output 包含 final marker 且不含 host canary。
- 本文不记录 credential、raw remote content 或 raw path。

### Final repository verification

- `bun run format:check`：exit `0`；检查 `1520` 个文件。
- `bun run lint`：exit `0`；`blade-code` 检查 `1325` 个文件，`blade-vscode`
  通过，`blade-web` 检查 `193` 个文件，均未应用修复。
- `bun run type-check`：CLI、VSCode 与 Web 均 exit `0`。
- `bun run build`：CLI、Web 与 VSCode 均 exit `0`；仅保留既有 Browserslist
  `caniuse-lite` 数据过期警告与 Web chunk-size 警告。
- 首次 `bun run test:all` 暴露两个 local file/snapshot fixture 的 5 个 mock export
  failure；`5b87d3da` 修复后对应 focused suite `5/5` 通过。
- 后续一次 full suite 在未改动的 `process-tree-lifecycle.test.ts` 出现单个 lease
  断言失败；目标原样复跑 `1/1`、独立连续复跑 `5/5`、完整文件 `23/23` 均通过。
  发现并正常终止四个运行超过两天的遗留 `bun test` 后，一次完整
  `bun run test:all` 通过：主套件 `461` files passed / `92` skipped、`5247` tests
  passed / `84` skipped；performance `4` files passed / `1` skipped、`9` tests
  passed / `1` skipped。该历史失败记录为 `intermittent failure in unchanged
  sources`，不声称已证明与变更无关或已确认具体根因。
- 最终代码资格验证 HEAD `84cc8d8f` 上的一次 `bun run test:all` 出现另一条未改动
  `mcp-call-lifecycle.test.ts` hard-timeout message mismatch：`460` files passed /
  `92` skipped、`5262` tests passed / `84` skipped，duration `519.08s`；原样精确
  复跑 `1/1` 通过。该项同样记录为 `intermittent failure in unchanged sources`。
- 随后的最终 `bun run test:all` 完整通过，exit `0`：主套件 `461` files passed /
  `92` skipped、`5263` tests passed / `84` skipped，duration `432.12s`；performance
  suite `4` files passed / `1` skipped、`9` tests passed / `1` skipped，duration
  `7.48s`。
- `CI=true bun run --filter blade-code test:coverage` 的一次 wrapper 运行因其固定
  `900000ms` 总预算终止，没有断言失败汇总。随后以同一 Vitest config、同一
  `--project=!performance --coverage` 测试集合直接运行至自然结束，exit `0`：
  `461` files passed / `92` skipped，`5263` tests passed / `84` skipped，duration
  `712.01s`；总覆盖率 statements `72.54%`、branches `66.11%`、functions
  `74.28%`、lines `73.81%`。

## Final Verification

focused deterministic、双模型 real production-Agent qualification、GUI/TUI surface
suites、whole-patch reviews、format、lint、type-check、build、最终 `test:all` 与等价完整
coverage 均已通过。先前全量测试中的两条未改动 source 间歇失败及其成功复跑已如实
记录。

- `v0.10.127..84cc8d8f` 代码与资格支撑提交数：`23`
- 当前代码资格验证 HEAD：`84cc8d8f0dc5a5bbdbe2d1f9f407ae7638551aa8`
- 当前 evidence / reference / changelog / version metadata 保持 Task 9 的 7 文件发布边界

## Limitations

- 本轮不提供 cross-process、cross-host、cross reconnect 的全局事务保证。
- Windows short-name 只对常见 `~digit` spelling fail closed；arbitrary short-name identity 仍未完全解决。
- remote capability boundary 是 fail-closed 的可用性收紧，不等价于“ACP 远端支持所有本地工具”。
- 完整 Web remote-session catalog/load/fork、remote file browser 与 owner-bound remote
  terminal bridge 将作为后续独立 patch 建设；本版本不把 host-private state scope 暴露
  给 Web。
- GitHub Release、annotated tag 与 npm publish 尚未执行；它们由本证据通过后的
  tag-triggered `publish.yml` 完成。
