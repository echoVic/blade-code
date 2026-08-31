# ACP Filesystem Request Lifecycle 资格验证证据

## 2026-08-31 Release Metadata Qualification

- 设计规格：`docs/superpowers/specs/2026-08-31-acp-filesystem-request-lifecycle-design.md`
- 实施计划：`docs/superpowers/plans/2026-08-31-acp-filesystem-request-lifecycle.md`
- 实现提交范围：`d94afa48` 到 `5cc23972`
- release-candidate closure commit：`1f13637a`，对 13 个 PTY helper / test 文件做
  Biome 纯格式修复，用于关闭首次 tag CI 的 format gate；不改变 ACP runtime 行为。
- release-candidate closure commits：
  `059e9930` 为 coverage-only budget 修复，保持 ordinary all `600s`，把 coverage
  提升到 `900s`，并保留 fallback；
  `1626bf48` 恢复 managed Git 的 `GIT_CONFIG_PARAMETERS` 隔离；
  `53af7c59` 为 tests-only 修复，让 `startPagerHarness` 对 Ink render 使用
  `debug: true`，根治 CI 动态帧导致的 stdout suppression。
- 范围：记录 ACP filesystem request lifecycle 的 release-metadata 证据，
  覆盖 Tasks 1-5 的因果 RED、实现职责、focused fresh 结果、真实 qualification、
  独立审查结论，以及最终仓库级验证结果。
- 安全主张：Blade 在不改变 local / ACP-local 文件语义的前提下，为 ACP remote text
  requests 增加公开 typed request、绝对 deadline、31+1 slot、1024 retained path cap、
  generation-safe mutation quarantine，以及 bounded ApplyPatch recovery。
- 限制：本证据不声称 cross-process fencing、native multi-file transaction、
  remote parent mkdir、binary/stat/delete/rename/mkdir 支持，也不把 connection close
  解释成已撤销 non-cooperative client 的远端副作用。

## Tasks 1-5 的 first causal RED

### Task 1: coordinator

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-request-coordinator.test.ts
```

首个因果 RED：`AcpFileRequestCoordinator`、按 connection 复用的 WeakMap factory、
以及 `createPairedAcpAppHarness()` 尚不存在，测试无法进入 public request API、
31+1 slot、1024 path cap、late settle 和 close cleanup 的断言路径。

### Task 2: bounded remote Read

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-remote-file-tools.test.ts -t 'remote Read'
```

首个因果 RED：`AcpFileSystemService` 仍走 legacy `readTextFile()` 路径，没有本地
deadline、recovery lane、generation-bound reconciliation API，`ToolExecutor`
也尚未把 remote-owned Read 接入 opaque lock。

### Task 3: bounded Write / Edit

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-remote-file-tools.test.ts -t 'remote Write|remote Edit'
```

首个因果 RED：`AcpFileSystemService` 还缺少带 lease 的 bounded write/edit service
methods，`service-context` 也还没有围绕 service rebuild / dispose 收紧这些 request
lifecycle；因此 remote Write / Edit 仍会在 preflight 之后才进入 lease path，且无法通过
现有 service / tool integration 证明 same-path cross-session fence 和
`pending-write -> needs-read` 语义。

### Task 4: update-only remote ApplyPatch

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-filesystem-request-lifecycle.test.ts -t 'ApplyPatch'
```

首个因果 RED：`apply-patch-tool` / `transaction` / `recovery` 侧还没有把 remote
precheck、workspace lock、sorted opaque locks、atomic leases 与 per-request /
per-transaction budgets 接到同一 lifecycle 上；因此 precheck/lock ordering、
`120s` forward budget、`60s` compensation lane 和 ledger barrier 仍未闭合。

### Task 5: paired protocol qualification and projection boundary

命令：

```bash
(cd packages/cli && \
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-filesystem-request-lifecycle.test.ts \
    tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts \
    --retry=0)
(cd packages/cli/web && \
  bun x vitest run --config vitest.config.ts \
    tests/components/preview/FilePreview.test.tsx)
```

首个因果 RED：integration 侧缺少基于 modern `ClientApp` 的 controlled observation，
无法验证标准取消、late settlement、recovery lane 与 connection lifecycle；Web
characterization 不是这一阶段的因果 RED，真实 real-api 也不用于“制造” RED。

## 实现提交职责

| 提交 | 职责 |
| --- | --- |
| `d94afa48` | 新增 connection-scoped coordinator、public typed request、31+1 slot、1024 retained path cap |
| `8828107f` | 修复 close cleanup、listener/timer 清理与 boundary state 缺口 |
| `2693a465` | 收紧 cleanup race、late settlement 和 stale mutation generation 路径 |
| `eac70f7a` | 为 remote Read 增加 bounded request lifecycle 与 opaque remote Read lock |
| `2fa2e0e9` | 补齐 bounded read integration gap 与 reconciliation API 行为 |
| `99decd32` | 修正 read edge case，包括 not-found、late read、ledger 更新边界 |
| `06bff546` | 保留 pending compatibility write，不让 no-options write 绕过 mutation fence |
| `9cee9758` | 为 Write / Edit 增加 preflight 前 lease 与 same-path cross-session fence |
| `1831a561` | 补齐 mutation quarantine gap，固化 `pending-write -> needs-read` 语义 |
| `bd0509c9` | 保留 owned mutation commit，防止 verified outcome 被过早释放 |
| `c3b31881` | 收紧 mutation lease ownership 与 generation 校验 |
| `c9eb2d5f` | 为 remote ApplyPatch 增加 bounded compensation 与 recovery lane |
| `ac652f78` | 补齐 patch lifecycle ordering、forward budget、rollback barrier 缺口 |
| `fa1c19f5` | 新增 patch forward deadline stop 覆盖 |
| `3d306016` | 将 tag publishing 收紧到 full checks 之后 |
| `41c17196` | 增加 paired transport lifecycle 的端到端覆盖 |
| `50dc737a` | 保持 Web FilePreview 对 generic uncertainty metadata 的渲染边界 |
| `9320ec66` | 强化 remote qualification evidence，保留 canonical field-only proof |
| `686578f9` | 收紧 exact recovery lease fence，并补齐 pending rollback settlement |
| `17c28954` | 修复 reject-first cancel listener 与 unhandled regression |
| `5cc23972` | 以 lint-compatible no-op helper 收口实现细节 |
| `1f13637a` | 对 13 个 PTY helper / test 文件做 Biome format-only 修复，关闭首次 tag CI format gate，不改变 ACP 行为 |
| `059e9930` | release-candidate closure：coverage-only budget 修复，保持 ordinary all `600s`、coverage `900s` 与 fallback，不改变 ACP 行为 |
| `1626bf48` | release-candidate closure：恢复 managed Git 的 `GIT_CONFIG_PARAMETERS` 隔离，不改变 ACP 行为 |
| `53af7c59` | release-candidate closure：tests-only，`startPagerHarness` 对 Ink render 启用 `debug: true`，修复 CI 动态帧 stdout suppression，不改变 ACP 行为 |

## 这轮实现证明了什么

### Coordinator 与 bounded request

- 同一 `AgentSideConnection` 共享一个 coordinator；旧 connection close 会终结旧
  generation，新 connection 才会创建新的 generation。
- coordinator 只保留 opaque path identity，不保留 raw path。
- request token 与 mutation path state 分离，31 个 ordinary request 与 1 个 recovery
  lane 独立计数。
- 每个 request 都绑定绝对 deadline、父 signal 与 connection signal，且本地 settle 后
  timer/listener 全部释放。
- late fulfill / late reject 在本地边界后仍会被观察，但不会错误改写已关闭 generation
  或留下 unhandled rejection。

### Read / mutation quarantine

- detached normal Read 只 dedupe 同路径 Read，不阻止 mutation lease 获取。
- same connection + same normalized path 会跨 Session 共用 fail-closed fence。
- dispatched write 在本地边界后进入 `pending-write`，只有 SDK settle 后才转成
  `needs-read`。
- 只有 originating Session + matching generation 的 fresh user Read 才能清除 fence；
  stale Read、other Session 和 late settlement 都不能越权清理。
- 明确 not-found reconciliation 同样受 generation 和 ownership 限制。

### ApplyPatch ordering 与 rollback

- remote ApplyPatch 先做 lifecycle precheck，再进入 host-private state，
  然后依次执行 workspace lock、sorted opaque locks、atomic mutation leases。
- forward phase 使用 `120_000ms` 总预算；独立 compensation 使用 `60_000ms`，
  read-back 使用 `5_000ms`，workspace lock 仍保留既有 `10_000ms`。
- pending current write 不会被错误回滚；只有 verified prefix 才能进入逆序补偿。
- ledger 直到 whole-transaction barrier 通过后才提交，不把 host-private state
  误表述成 ACP 原生多文件事务。

### Web/UI non-goal

- Web `FilePreview` 继续只渲染 generic diff 与 uncertainty metadata。
- ACP receipt UI projection 明确保持为 non-goal；本 patch 不向 Web 注入 ACP 专属
  receipt 控件或 badge。

## Focused fresh verification

以下 focused deterministic、pre-release real qualification，以及 release-metadata 之后的
final verification 都是本轮已经完成的 fresh evidence。文末
`Final Repository Verification` 只记录当前已完成且无失败的 release-metadata 后验证，
并包含当前文档编辑后的两个 diff 检查。

### CLI unit

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
  tests/unit/tooling/tools/builtin/file/apply-patch-parser.test.ts \
  tests/unit/platform/ui/utils/tool-formatters.test.ts
```

结果：`7 files`，`146 tests passed`，退出码 `0`，时长 `9.55s`。

### CLI integration

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-filesystem-request-lifecycle.test.ts \
  tests/integration/acp-remote-file-tools.test.ts \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts
```

结果：`5 files`，`126 tests passed`，退出码 `0`，时长 `5.59s`。

### Web characterization

命令：

```bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/components/preview/FilePreview.test.tsx
```

结果：`1 file`，`21 tests passed`，退出码 `0`，时长 `3.58s`。

### Repo-root type-check / lint / build / test:all

- `bun run format:check`：退出码 `0`。共检查 `1509` 个文件。
- `bun run type-check`：退出码 `0`。CLI、VSCode 与 Web 均退出 `0`。
- `bun run lint`：退出码 `0`。CLI 检查 `1314` 个文件、无自动修复；VSCode 退出 `0`；
  Web 检查 `193` 个文件、无自动修复。
- `bun run build`：退出码 `0`。backend、Web 与 VSCode 构建成功；仅保留既有非 fatal
  警告：Browserslist `caniuse-lite` 已有 `7 months old`，以及 Web minification 后
  chunk 大于 `500 kB`。
- `bun run test:all`：退出码 `0`。
  non-performance：`Test Files 456 passed | 92 skipped (548)`，
  `Tests 4990 passed | 84 skipped (5074)`，时长 `403.94s`。
  performance：`Test Files 4 passed | 1 skipped (5)`，
  `Tests 9 passed | 1 skipped (10)`，时长 `6.02s`。

### Task4 reviewer fresh rerun

- Task4 focused reviewer rerun 记录：unit `33`、integration `116`，结论保持通过。

## Real ACP qualification

### Pre-release deterministic qualification

命令：

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
  --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts
```

结果：

- `2 passed`
- `deepseek:deepseek-v4-flash`：`14.285s`
- `deepseek:deepseek-v4-pro`：`6.253s`
- overall：`24.86s`
- framework retry：`0`
- selected model `overrides.maxRetries`：`0`

真实 qualification 断言：

- request sequence 精确受控；
- 只记录 canonical、field-only、SHA-256 证据；
- 不记录 raw path、raw content、content hash、credential、secret、prompt、
  client-private error；
- `Write` 成功数与四个布尔断言一起构成最终 canonical evidence；
- 真实 paired transport 仍验证 host source preserved、host output parent absent、
  final marker present、host canary absent。

canonical evidence fields：

- `qualificationId`
- `frameworkRetryBudget`
- `requestSequence`
- `requestMethodOrder`
- `requestPathIdentities`
- `writeResultCount`
- 四个布尔值

`requestPathIdentities` 仅使用 `sha256:<64 lowercase hex>` 形式，不回显 raw path。

当前 canonical digest：

| 模型 | digest |
| --- | --- |
| `deepseek:deepseek-v4-flash` | `6e72ee51e47734379eff001c40811ad57f7d15e58e07c49e9715fd79636ffb28` |
| `deepseek:deepseek-v4-pro` | `c79639de143de27a3f6856aaef5f89f78089436b7345078f0b38ad215d00691f` |

这些 digest 来自 canonical 字段按固定顺序 JSON serialization 后计算的 SHA-256。
它们是本轮 fresh qualification 产物，但不是 real stdout 直接打印值；证据页不保留
raw path、raw content 或其他 client-private material。

这组 real `2/2` qualification 仍然对应 ACP runtime 最终行为变更后的资格验证；
其后新增的仅有 `1f13637a` 的 format-only 修复、`059e9930` 的 coverage-only budget
修复、`1626bf48` 的 managed Git 环境隔离恢复、`53af7c59` 的 tests-only stdout
suppression 修复，以及当前双语文档 / release metadata 更新。

## Release-candidate closure TDD

- `1f13637a`：首次 tag CI 在 format gate 失败后，以 Biome 纯格式修复闭环；
  不引入 ACP 行为变化。
- `059e9930`：TDD RED 是第二次 tag CI 的 coverage 在 `600s` 超时退出，且日志中没有
  新的 assertion failure；GREEN 是把 coverage 独立预算提升到 `900s`，同时保留
  ordinary all `600s` 与 fallback，关闭该类 release-candidate 失败。
- `1626bf48`：恢复 managed Git 的 `GIT_CONFIG_PARAMETERS` 隔离，确保 release
  candidate 环境回到受管边界；该修复不改变 ACP contract。
- `53af7c59`：TDD RED 是 `CI=true` 的 coverage 测试里 stdout 没有 Transcript，
  具体表现为 target `1/1` 与 whole file `4/4` 断言都失败；第三次 tag run 和 failed-job
  rerun 都在 unchanged source 上重现同一失败后，GREEN 才以 tests-only 方式把
  `startPagerHarness` 的 Ink render 改为 `debug: true`，根治动态帧 stdout suppression。

### Final real rerun after release metadata

命令：

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
  --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts
```

结果：

- 退出码 `0`
- `1 file`
- `2 tests passed`
- `deepseek:deepseek-v4-flash`：`6.015s`
- `deepseek:deepseek-v4-pro`：`4.380s`
- overall：`13.35s`
- framework retry：`0`
- selected model `overrides.maxRetries`：`0`

## Independent review verdicts

- Task1：`spec compliant` / `quality approved`
- Task2：`spec compliant` / `quality approved`
- Task3：经过三轮 review gap 与修复后，最终 `spec compliant` / `approved`
- Task4：在 review gap closure 后最终 `spec compliant` / `approved`
- Task5：`spec compliant` / `quality approved`

这些审查共同确认：

- public SDK request API、31+1 slot、1024 retained path cap 与 generation fence
  没有回退；
- cancellation uncertainty、late settlement、listener/timer cleanup、lock/lease
  ordering 与 typed fixture integrity 已收敛到当前 patch 约束；
- Web projection non-goal 保持明确，未把 ACP receipt 渲染成新的 UI contract。

## Final Repository Verification

<!-- FINAL_REPOSITORY_VERIFICATION_BEGIN -->
Release-metadata verification completed with no failed commands in the recorded runs:

- `bun run format:check`: exit `0`; checked `1509` files.
- `bun run type-check`: exit `0` for CLI, VSCode, and Web.
- `bun run lint`: exit `0`; CLI checked `1314` files with no fixes, VSCode exit `0`,
  Web checked `193` files with no fixes.
- `bun run build`: exit `0`; backend, Web, and VSCode builds succeeded. Only the
  existing non-fatal Browserslist `caniuse-lite` age warning and Web chunk-size
  warning remained.
- `CI=true bun run --filter blade-code test:coverage`: exit `0`; all tests
  completed, duration `458.84s`.
- `bun run test:all`: exit `0`.
  non-performance: `Test Files 456 passed | 92 skipped (548)`,
  `Tests 4990 passed | 84 skipped (5074)`, duration `403.94s`.
  performance: `Test Files 4 passed | 1 skipped (5)`,
  `Tests 9 passed | 1 skipped (10)`, duration `6.02s`.
- Final real qualification rerun: exit `0`, `1 file`, `2 tests passed`,
  Flash `6.015s`, Pro `4.380s`, overall `13.35s`, framework retry `0`,
  model override retry `0`.
- The second tag CI coverage run timed out at `600s` without a new assertion
  failure; `059e9930` closed that release-candidate issue by separating the
  coverage budget from ordinary all. The first format failure was already
  closed by `1f13637a`.
- The later `CI=true` coverage regression around pager stdout also completed
  green locally after `53af7c59`: target assertions `1/1`, whole-file
  assertions `4/4`.

- `git diff --check`：退出码 `0`。
- `git diff --check 39b23105..HEAD`：退出码 `0`。
<!-- FINAL_REPOSITORY_VERIFICATION_END -->
