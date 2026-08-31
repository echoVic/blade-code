# ACP Filesystem Request Lifecycle Qualification Evidence

## 2026-08-31 Release Metadata Qualification

- Design spec:
  `docs/superpowers/specs/2026-08-31-acp-filesystem-request-lifecycle-design.md`
- Implementation plan:
  `docs/superpowers/plans/2026-08-31-acp-filesystem-request-lifecycle.md`
- Implementation commit range: `d94afa48` through `5cc23972`
- Release-candidate closure commit: `1f13637a`, a Biome format-only fix across
  13 PTY helper/test files to close the first tag CI format gate. It does not
  change ACP runtime behavior.
- Release-candidate closure commits:
  `059e9930` is the coverage-only budget fix that keeps ordinary all at `600s`,
  raises coverage to `900s`, and preserves the fallback;
  `1626bf48` restores managed Git `GIT_CONFIG_PARAMETERS` isolation;
  `53af7c59` is a tests-only fix that makes `startPagerHarness` use
  `debug: true` for Ink render, eliminating CI dynamic-frame stdout
  suppression.
- Scope: record the release-metadata evidence for ACP filesystem request
  lifecycle, covering the causal REDs for Tasks 1-5, implementation
  responsibilities, focused fresh results, real qualification, independent
  review verdicts, and the final repository-verification results.
- Security claim: without changing local or ACP-local filesystem semantics,
  Blade adds public typed requests, absolute deadlines, 31+1 slot accounting,
  a 1024 retained-path cap, generation-safe mutation quarantine, and bounded
  ApplyPatch recovery to ACP remote text requests.
- Limitations: this evidence does not claim cross-process fencing, native
  multi-file transactions, remote parent `mkdir`, or support for
  binary/stat/delete/rename/mkdir operations. Connection close is also not
  described as revoking remote side effects from a non-cooperative client.

## First Causal REDs For Tasks 1-5

### Task 1: coordinator

Command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-request-coordinator.test.ts
```

First causal RED: `AcpFileRequestCoordinator`, the connection-reused WeakMap
factory, and `createPairedAcpAppHarness()` did not yet exist, so the tests
could not reach the intended assertions for the public request API, 31+1 slot
accounting, 1024 path cap, late settlement, and close cleanup.

### Task 2: bounded remote Read

Command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-remote-file-tools.test.ts -t 'remote Read'
```

First causal RED: `AcpFileSystemService` still used the legacy
`readTextFile()` path, with no local deadline, no recovery lane, no
generation-bound reconciliation API, and `ToolExecutor` still skipped the
opaque lock for remote-owned reads.

### Task 3: bounded Write / Edit

Command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-remote-file-tools.test.ts -t 'remote Write|remote Edit'
```

First causal RED: `AcpFileSystemService` still lacked bounded write/edit service
methods that carried a lease, and `service-context` had not yet tightened the
same request lifecycle across service rebuild and dispose. Remote `Write` /
`Edit` therefore still reached the lease path only after preflight, and the
existing service/tool integration could not yet prove same-path cross-session
fencing or the `pending-write -> needs-read` progression.

### Task 4: update-only remote ApplyPatch

Command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-filesystem-request-lifecycle.test.ts -t 'ApplyPatch'
```

First causal RED: `apply-patch-tool`, `transaction`, and `recovery` still did
not connect remote precheck, workspace lock, sorted opaque locks, atomic
leases, and per-request / per-transaction budgets into one lifecycle. The
precheck/lock ordering, `120s` forward budget, `60s` compensation lane, and
ledger barrier were therefore still incomplete.

### Task 5: paired protocol qualification and projection boundary

Command:

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

First causal RED: the integration side still lacked controlled observations
through a modern `ClientApp`, so standard cancellation, late settlement,
recovery-lane behavior, and connection lifecycle could not yet be proven. The
Web characterization was not the causal RED for this stage, and the real-API
test was not used merely to manufacture RED.

## Implementation Commit Responsibilities

| Commit | Responsibility |
| --- | --- |
| `d94afa48` | Add the connection-scoped coordinator, public typed request flow, 31+1 slots, and 1024 retained-path cap |
| `8828107f` | Close gaps in close cleanup, listener/timer cleanup, and boundary state handling |
| `2693a465` | Harden cleanup races, late settlement, and stale mutation-generation paths |
| `eac70f7a` | Add bounded request lifecycle and the opaque remote Read lock |
| `2fa2e0e9` | Close bounded-read integration gaps and reconciliation API behavior |
| `99decd32` | Correct read edge cases around not-found, late reads, and ledger updates |
| `06bff546` | Preserve pending compatibility writes so no-options writes cannot bypass mutation fencing |
| `9cee9758` | Acquire the lease before preflight for Write/Edit and fence same-path cross-session mutation |
| `1831a561` | Close mutation quarantine gaps and fix the `pending-write -> needs-read` progression |
| `bd0509c9` | Preserve owned mutation commits so verified outcomes are not released too early |
| `c3b31881` | Harden mutation-lease ownership and generation checks |
| `c9eb2d5f` | Add bounded compensation and a recovery lane for remote ApplyPatch |
| `ac652f78` | Close patch lifecycle ordering, forward-budget, and rollback-barrier gaps |
| `fa1c19f5` | Add forward-deadline-stop coverage for patch lifecycle |
| `3d306016` | Gate tag publishing on full checks |
| `41c17196` | Add end-to-end paired transport lifecycle coverage |
| `50dc737a` | Preserve Web FilePreview behavior for generic uncertainty metadata |
| `9320ec66` | Harden remote qualification evidence and keep it canonical and field-only |
| `686578f9` | Tighten the exact recovery-lease fence and complete pending rollback settlement |
| `17c28954` | Fix the reject-first cancel-listener and unhandled regression |
| `5cc23972` | Close the patch with a lint-compatible no-op helper |
| `1f13637a` | Apply a Biome format-only fix across 13 PTY helper/test files to close the first tag CI format gate without changing ACP behavior |
| `059e9930` | Release-candidate closure: apply the coverage-only budget fix, keeping ordinary all at `600s`, coverage at `900s`, and the fallback without changing ACP behavior |
| `1626bf48` | Release-candidate closure: restore managed Git `GIT_CONFIG_PARAMETERS` isolation without changing ACP behavior |
| `53af7c59` | Release-candidate closure: tests-only, enable `debug: true` for Ink render in `startPagerHarness` to fix CI dynamic-frame stdout suppression without changing ACP behavior |

## What This Implementation Proves

### Coordinator and bounded requests

- One `AgentSideConnection` shares one coordinator; closing the old connection
  ends that generation, and only a new connection creates a fresh generation.
- The coordinator retains only opaque path identity and never raw path.
- Request tokens are separated from mutation-path state, with 31 ordinary
  requests and 1 recovery lane counted independently.
- Each request is bound to an absolute deadline, a parent signal, and the
  connection signal, and all timers/listeners are released after local
  settlement.
- Late fulfill and late reject remain observed after the local boundary, but do
  not mutate a closed generation or leak unhandled rejections.

### Read and mutation quarantine

- A detached normal read only deduplicates another read on the same path; it
  does not block mutation-lease acquisition.
- The same connection and same normalized path share one fail-closed fence
  across Sessions.
- A dispatched write crossing the local boundary enters `pending-write` and
  moves to `needs-read` only after SDK settlement.
- Only the originating Session plus matching generation and a fresh user read
  can clear the fence; stale reads, other Sessions, and late settlements cannot
  overrule it.
- Explicit not-found reconciliation obeys the same generation and ownership
  constraint.

### ApplyPatch ordering and rollback

- Remote `ApplyPatch` performs lifecycle precheck before host-private state,
  then runs workspace lock, sorted opaque locks, and atomic mutation leases.
- The forward phase uses a `120_000ms` budget; independent compensation uses
  `60_000ms`; read-back uses `5_000ms`; workspace lock keeps the existing
  `10_000ms` budget.
- A pending current write is never misreported as safely rolled back; only the
  verified prefix may enter reverse compensation.
- Ledger state commits only after the whole-transaction barrier passes, so
  host-private orchestration is not misdescribed as a native ACP transaction.

### Web/UI non-goal

- Web `FilePreview` continues to render only the generic diff and uncertainty
  metadata.
- ACP receipt UI projection remains an explicit non-goal; this patch does not
  add ACP-specific receipt controls or badges to the Web surface.

## Focused Fresh Verification

The focused deterministic results below, the pre-release real qualification,
and the post-release-metadata final verification are all completed fresh
evidence for this round. `Final Repository Verification` records only the
release-metadata verification that is already complete and has no failed
commands in the runs listed there, including both diff checks after the
current documentation edit.

### CLI unit

Command:

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

Result: `7 files`, `146 tests passed`, exit code `0`, duration `9.55s`.

### CLI integration

Command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-filesystem-request-lifecycle.test.ts \
  tests/integration/acp-remote-file-tools.test.ts \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts
```

Result: `5 files`, `126 tests passed`, exit code `0`, duration `5.59s`.

### Web characterization

Command:

```bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/components/preview/FilePreview.test.tsx
```

Result: `1 file`, `21 tests passed`, exit code `0`, duration `3.58s`.

### Repo-root type-check / lint / build / test:all

- `bun run format:check`: exit code `0`. It checked `1509` files.
- `bun run type-check`: exit code `0`. CLI, VSCode, and Web all exited `0`.
- `bun run lint`: exit code `0`. CLI checked `1314` files with no fixes;
  VSCode exited `0`; Web checked `193` files with no fixes.
- `bun run build`: exit code `0`. Backend, Web, and VSCode builds succeeded.
  The only retained non-fatal warnings were the Browserslist
  `caniuse-lite` age warning at `7 months old` and the Web chunk-size warning
  for assets larger than `500 kB` after minification.
- `bun run test:all`: exit code `0`.
  non-performance: `Test Files 456 passed | 92 skipped (548)`,
  `Tests 4990 passed | 84 skipped (5074)`, duration `403.94s`.
  performance: `Test Files 4 passed | 1 skipped (5)`,
  `Tests 9 passed | 1 skipped (10)`, duration `6.02s`.

### Task4 reviewer fresh rerun

- Task4 focused reviewer rerun record: unit `33`, integration `116`, verdict
  remained passing.

## Real ACP Qualification

### Pre-release deterministic qualification

Command:

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
  --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts
```

Result:

- `2 passed`
- `deepseek:deepseek-v4-flash`: `14.285s`
- `deepseek:deepseek-v4-pro`: `6.253s`
- overall: `24.86s`
- framework retry: `0`
- selected model `overrides.maxRetries`: `0`

The real qualification asserts:

- request sequence is exactly controlled;
- only canonical, field-only, SHA-256 evidence is retained;
- no raw path, raw content, content hash, credential, secret, prompt, or
  client-private error is recorded;
- successful `Write` count plus the four booleans form the canonical evidence;
- the paired transport still proves host source preserved, host output parent
  absent, final marker present, and host canary absent.

Canonical evidence fields:

- `qualificationId`
- `frameworkRetryBudget`
- `requestSequence`
- `requestMethodOrder`
- `requestPathIdentities`
- `writeResultCount`
- the four booleans

`requestPathIdentities` uses only the form `sha256:<64 lowercase hex>` and does
not echo any raw path.

Current canonical digests:

| Model | Digest |
| --- | --- |
| `deepseek:deepseek-v4-flash` | `6e72ee51e47734379eff001c40811ad57f7d15e58e07c49e9715fd79636ffb28` |
| `deepseek:deepseek-v4-pro` | `c79639de143de27a3f6856aaef5f89f78089436b7345078f0b38ad215d00691f` |

These digests come from SHA-256 over canonical fields after fixed-order JSON
serialization. They are fresh outputs of this qualification round, but they are
not values printed directly by real-API stdout. The evidence retains no raw
path, raw content, or other client-private material.

This real `2/2` qualification still corresponds to the ACP runtime's final
behavioral change set. After it, only the format-only `1f13637a` closure, the
coverage-only `059e9930` budget fix, the managed Git isolation restore in
`1626bf48`, the tests-only stdout-suppression fix in `53af7c59`, and the
current bilingual documentation/release-metadata updates were added.

## Release-candidate closure TDD

- `1f13637a`: after the first tag CI failed its format gate, the closure was a
  Biome format-only fix. It introduced no ACP behavioral change.
- `059e9930`: the TDD RED was the second tag CI coverage run timing out at
  `600s` with no new assertion failure in the logs. The GREEN change raised the
  dedicated coverage budget to `900s` while keeping ordinary all at `600s` and
  preserving the fallback.
- `1626bf48`: restores managed Git `GIT_CONFIG_PARAMETERS` isolation so the
  release-candidate environment returns to the managed boundary. It does not
  change the ACP contract.
- `53af7c59`: the TDD RED was a `CI=true` coverage failure where stdout no
  longer contained the Transcript. The failing assertions were target `1/1` and
  whole file `4/4`. The same failure was reproduced on unchanged sources in the
  third tag run and the failed-job rerun before the GREEN fix changed
  `startPagerHarness` to use Ink render `debug: true` as a tests-only closure.

### Final real rerun after release metadata

Command:

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
  --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts
```

Result:

- exit code `0`
- `1 file`
- `2 tests passed`
- `deepseek:deepseek-v4-flash`: `6.015s`
- `deepseek:deepseek-v4-pro`: `4.380s`
- overall: `13.35s`
- framework retry: `0`
- selected model `overrides.maxRetries`: `0`

## Independent Review Verdicts

- Task1: `spec compliant` / `quality approved`
- Task2: `spec compliant` / `quality approved`
- Task3: after three rounds of review gaps and fixes, final
  `spec compliant` / `approved`
- Task4: after review-gap closure, final `spec compliant` / `approved`
- Task5: `spec compliant` / `quality approved`

Together these reviews confirm:

- the public SDK request API, 31+1 slot accounting, 1024 retained-path cap,
  and generation fence did not regress;
- cancellation uncertainty, late settlement, listener/timer cleanup,
  lock/lease ordering, and typed fixture integrity converged to the intended
  patch contract;
- the Web projection non-goal stayed explicit, and ACP receipts were not turned
  into a new UI contract.

## Final Repository Verification

<!-- FINAL_REPOSITORY_VERIFICATION_BEGIN -->
Release-metadata verification completed with no failed commands in the recorded
runs:

- `bun run format:check`: exit `0`; checked `1509` files.
- `bun run type-check`: exit `0` for CLI, VSCode, and Web.
- `bun run lint`: exit `0`; CLI checked `1314` files with no fixes, VSCode
  exit `0`, Web checked `193` files with no fixes.
- `bun run build`: exit `0`; backend, Web, and VSCode builds succeeded. Only
  the existing non-fatal Browserslist `caniuse-lite` age warning and Web
  chunk-size warning remained.
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

- `git diff --check`: exit code `0`.
- `git diff --check 39b23105..HEAD`: exit code `0`.
<!-- FINAL_REPOSITORY_VERIFICATION_END -->
