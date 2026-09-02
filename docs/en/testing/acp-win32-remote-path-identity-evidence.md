# ACP Win32 Remote Path Identity Qualification Evidence

## 2026-09-02 Release Metadata Qualification

- Design spec:
  `docs/superpowers/specs/2026-08-31-acp-win32-remote-path-identity-design.md`
- Implementation plan:
  `docs/superpowers/plans/2026-08-31-acp-win32-remote-path-identity.md`
- Target version: `0.10.128`
- Baseline version: `v0.10.127`
- Current code qualification HEAD: `84cc8d8f0dc5a5bbdbe2d1f9f407ae7638551aa8`
- Implementation and qualification-support range: `80649698` through `84cc8d8f`
- Scope: record the documentation and release-metadata evidence for ACP Win32
  remote path identity hardening, covering the Task 1-8 causal RED / known
  GREEN boundaries, commit responsibilities, bilingual documentation coverage,
  independent-review status, final repository gates, and current limitations.
- Security claim: Blade now enforces a frozen path profile, a case-preserving
  wire path, exact ledger authority, collision fencing, a host-private durable
  state scope, a remote capability boundary, and an ordered pure remote
  `ApplyPatch` preflight for ACP remote Windows paths. Local and ACP-local
  semantics remain unchanged.
- Limitations: this evidence does not claim UNC support, device-namespace
  support, native ACP multi-file transactions, remote parent `mkdir`,
  binary/stat/delete/rename/mkdir operations, cross-process fencing, or full
  detection of arbitrary short-name aliases.

## Prompt-To-Artifact Matrix

| Surface | Prompt / input | Expected artifact | Current evidence |
| --- | --- | --- | --- |
| Remote path parser | Windows or POSIX absolute path with optional expected style | `AcpRemotePath` with frozen style, `wirePath`, `exactIdentity`, `collisionIdentity`, or a redacted `acp_remote_path_invalid` error | Implemented by Task 1 |
| Remote Session durable identity | `session/new`, `session/load`, `session/fork`, `session/list` using an ACP remote `cwd` | protected `hostStateRoot`, immutable remote workspace descriptor, and `cwd` surfaced back as `wirePath` | Implemented; see Task 2-4 commits and the reference document |
| Runtime capability boundary | ACP remote Session with or without read/write/terminal capabilities | only remote-safe tools remain; host-only workspace features stay absent | Implemented; see Task 4-5 commits and the reference document |
| Runtime and terminal policy | ACP remote Session with or without read/write/terminal capabilities | capability-gated Read / Write / Edit / ApplyPatch / Bash and no host fallback | Implemented by Task 5 |
| Remote identity consumers | collision-equivalent and exact-distinct path spellings | exact ledger authority plus collision-keyed lock and quarantine coordination | Implemented by Task 6 |
| Remote single-file tools | Read / Write / Edit with an unsafe remote path | validation before worktree, permission, hook, scheduler, lock, invocation, or ACP request | Implemented by Task 7 |
| Remote ApplyPatch | update-only remote patch | pure remote preflight before lock / lease / transaction state, typed `acp_remote_patch_invalid` on invalid targets | Implemented; see Task 8 commit |
| Release qualification | focused deterministic suites, real paired ACP qualification, GUI/TUI surface suites, whole-patch reviews, final repository gates | exact counts, review verdicts, and final pass/fail totals | Recorded, including intermittent failures in unchanged sources and exact reruns |

## Task 1-8 Causal RED And Committed Implementation Responsibility

### Task 1: Introduce the pure remote path model

- Plan location: Task 1, Step 2 / Step 4.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/remote-path.test.ts
```

- First causal RED: `AcpRemotePath.ts` did not yet exist, so imports/APIs
  failed before the tests could assert style inference, case preservation,
  exact/collision identity separation, and redacted typed errors.
- Committed implementation responsibility: commit
  `80649698 feat(acp): define remote path identities`.

### Task 2: Add the durable remote workspace descriptor and protected state scope

- Plan location: Task 2, Step 2 / Step 7.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/remote-workspace.test.ts \
  tests/unit/agent-runtime/context/storage-path-utils.test.ts
```

- First causal RED: the descriptor, protected scope, direct remote-state
  helpers, and remote namespace-enumeration APIs did not yet exist.
- Committed implementation responsibility: commits
  `6c4235b9 feat(acp): define protected remote state scopes`,
  `aff1755a feat(acp): persist remote workspace identity`,
  `60376429 feat(acp): isolate remote session catalogs`,
  plus documentation commit
  `0e0a162e docs(acp): harden remote state scope contract`.

### Task 3: Route ACP lifecycle through explicit Session roots

- Plan location: Task 3, Step 2 / Step 4.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-session-fork.test.ts
```

- First causal RED: remote `cwd` was still flowing as one untyped root through
  Session and SessionService, without a split among `hostStateRoot`,
  `executionRoot`, and `hostResourceRoot`, and without durable descriptor
  validation.
- Committed implementation responsibility: commits
  `1e668f36 feat(acp): support remote session forks`,
  `09558241 feat(acp): load remote session history`,
  `6c3e8bcf feat(acp): update remote session metadata`,
  `fcf9e928 fix(acp): separate remote session roots`,
  plus documentation commit
  `d0dd740f docs(acp): isolate remote session roots`.

### Task 4: Separate Runtime state from remote execution

- Plan location: Task 4, Step 2 / Step 4.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/prompts/system-prompt.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/apply-patch-tool.test.ts
```

- First causal RED: the Runtime was still treating the remote workspace root as
  host state, a workspace-resource root, a prompt project path, and a host-only
  recovery seam.
- Committed implementation responsibility: commit
  `e6d42241 fix(runtime): isolate ACP remote execution`.

### Task 5: Enforce the remote capability matrix and terminal boundary

- Plan location: Task 5, Step 2 / Step 4.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/tooling/tools/builtin/bash.test.ts \
  tests/unit/tools/execution/workspace-tool-policy.test.ts
```

- First causal RED: a remote Session still exposed host-only workspace
  capabilities, and terminal absence still carried local-fallback risk.
- Committed implementation responsibility: commit
  `b4937af0 fix(acp): fail closed on host-only capabilities`.

### Task 6: Separate exact ledger authority from collision fencing

- Plan location: Task 6, Step 2 / Step 5.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/file-system-service.test.ts \
  tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/file-lock-manager.test.ts
```

- First causal RED: exact read authority and collision lock/quarantine state
  were still sharing one identity, so Windows case aliases could bypass
  fencing or incorrectly reuse authorization.
- Committed implementation responsibility: commit
  `98a2dc88 fix(acp): fence Windows remote path aliases`.

### Task 7: Reject invalid remote single-file tools before side effects

- Plan location: Task 7, Step 2 / Step 4.
- Causal RED command:

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

- First causal RED: unsafe remote paths could still reach lock, lease,
  permission, or RPC boundaries before the final fail-closed parse/validation
  gate.
- Committed implementation responsibility: commit
  `3a7d9b64 fix(acp): reject unsafe remote file paths`.

### Task 8: Add one pure pre-lock remote ApplyPatch preflight

- Plan location: Task 8, Step 2 / Step 4.
- Causal RED command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/acp-remote-file-tools.test.ts
```

- First causal RED: remote `ApplyPatch` was still doing its final pure path
  validation only after entering host-private workspace lock / transaction
  state, so it could not prove that the preflight had completed before side
  effects.
- Committed implementation responsibility: commit
  `d6c8fb45 fix(acp): preflight remote patch paths`.

## Implementation Commit Responsibilities

| Commit | Responsibility |
| --- | --- |
| `39e8837e` | Author the ACP Win32 remote path identity design spec |
| `46ada390` | Author the ACP Win32 remote path hardening implementation plan |
| `80649698` | Add the pure `AcpRemotePath` model, style inference, redacted typed errors, and exact/collision identities |
| `d0dd740f` | Document remote Session root separation and lifecycle requirements |
| `0e0a162e` | Tighten the documented contract for protected remote state scopes |
| `6c4235b9` | Add protected remote state scopes and direct remote storage helpers |
| `aff1755a` | Persist the immutable remote workspace descriptor |
| `60376429` | Separate the remote Session catalog from the local catalog |
| `1e668f36` | Support remote Session forks and descriptor copying |
| `09558241` | Support remote Session load/history recovery |
| `6c3e8bcf` | Update remote Session metadata threading |
| `fcf9e928` | Separate ACP remote Session roots and fix new/load/fork lifecycle ordering |
| `e6d42241` | Separate Runtime host state from ACP remote execution |
| `b4937af0` | Fail closed on host-only capabilities, terminal fallback, and the remote-safe tool surface |
| `98a2dc88` | Separate exact ledger authority from collision fencing and tighten Windows alias handling |
| `3a7d9b64` | Reject unsafe remote paths before single-file tool side effects |
| `d6c8fb45` | Add one pure pre-lock remote `ApplyPatch` preflight |
| `7aa6d996` | Create the real-API fixture storage root with the protected `0700` mode required by the production state-scope boundary |
| `af49ad5a` | Accept same-owner, owner-accessible, non-group/world-writable configured storage roots while retaining strict `0700` remote namespace and leaf scopes |
| `5b87d3da` | Replace two incomplete local file/snapshot `AcpServiceContext` module mocks with typed `importOriginal` partial mocks; no production code changed |
| `2a2eefa9` | Surface allowlisted fixed ACP filesystem failures through the formatter shared by TUI, ACP, Headless, and Web SSE while keeping unknown Client details hidden |
| `f7945c30` | Canonicalize remote Read/Write/Edit result paths and cross-host basenames, and redact not-found and string-not-found failures |
| `84cc8d8f` | Remove raw path metadata from ToolExecutor invalid-path preflight and unknown-session Write/Edit results, closing the reintroduction path at the helper type boundary |

## Review Verdicts

- Specification review: `APPROVED`; Critical `0`, Important `0`, Minor `0`.
- Quality / security / concurrency review: initially found one Important
  production-compatibility issue in the configured storage-root mode rule.
  Commit `af49ad5a` resolved it, and the same reviewer approved the fix with
  Critical `0` and Important `0`.
- A late Task 7 review concern about generic `path` / `affectedPaths()` was
  reproduced and independently adjudicated. It is outside the specified
  `file_path` / `notebook_path` lock-input contract, and no production path was
  found from those generic values into Blade ACP or host filesystem I/O. It is
  retained as a future generic-tool contract hardening idea, not a release
  blocker.
- The tests-only closure in `5b87d3da` received independent specification and
  quality reviews; both returned `APPROVED` with Critical `0` and Important
  `0`. Existing weak assertions and the small test-local mock remain
  non-blocking test debt.
- The first independent review of `2a2eefa9` found that the real `ApplyPatch`
  capability messages were missing from the allowlist. After causal RED coverage
  and correction, the final review reported Critical `0`, Important `0`, Minor `0`.
- The first specification and quality reviews of `f7945c30` found five failure
  branches that still returned the input spelling. Windows noncanonical RED
  coverage was added, every branch was moved to canonical `wirePath`, and both
  final reviews returned `APPROVED` with Critical `0` and Important `0`.
- `84cc8d8f` resolves the two raw-path metadata exposure points found by the
  final whole-patch review. Focused unit `46/46` and integration `83/83` passed;
  independent specification and quality reviews both returned `APPROVED` with
  Critical `0` and Important `0`.

## Focused Verification Status

### Focused deterministic verification

- Candidate baseline:
  - `date +%F` = `2026-09-02`
  - `git rev-parse HEAD` = `84cc8d8f0dc5a5bbdbe2d1f9f407ae7638551aa8`
  - `git log --oneline v0.10.127..84cc8d8f` contains `23` code and
    qualification-support commits, matching the range above
- Current version baseline:
  - `packages/cli/package.json` was `0.10.127` before this Task 9 metadata edit
  - this release-metadata update targets `0.10.128`

- Unit focused suite after the final production fix: `8` files, `381/381`
  tests passed, exit `0`, Vitest duration `9.54s`.
- Integration focused suite: `6` files, `190/190` tests passed, exit `0`,
  Vitest duration `5.78s`.
- Web `FilePreview`: the plan command was first run from `packages/cli` and
  correctly failed with `No test files found` because the Web config root is
  `packages/cli/web`. Running the same target from that root passed `1` file and
  `21/21` tests, exit `0`, Vitest duration `3.51s`.
- Remote result canonicalization and redaction focused integration: `1` file,
  `83/83` tests passed, exit `0`, Vitest duration `1.85s`.
- TUI/shared-surface error formatting: `1` file, `18/18` tests passed, exit `0`.
  With real Ink input/pager and session-selector coverage included, `5` files
  and `39/39` tests passed in `4.41s`. Computer-use browser control was not
  available in this environment, so this evidence does not claim TUI visual
  automation; real stdin/stdout/Ink integration is the TUI evidence.
- The focused GUI/Web suite covered `FilePreview`, `PreviewDiffList`,
  `ChatMessage`, `Layout`, `sessionNavigation`, and `sessionSlice`: `6` files,
  `130/130` tests passed, exit `0`, Vitest duration `3.69s`.

### Real production-Agent qualification

- Required models: `deepseek-v4-flash` and `deepseek-v4-pro`.
- Framework retry budget: `0`; model `maxRetries`: `0`; stop reason:
  `end_turn` for both models.
- Initial causal RED, before any model request: both cases failed in `16ms` and
  `7ms` with the same redacted protected-state error. The test fixture had not
  pre-created its injected `BLADE_STORAGE_ROOT`; a local mode probe showed that
  recursive creation produced `0755`, while the then-current production
  boundary required `0700`.
- Fix: commit `7aa6d996` pre-creates only the isolated fixture storage root with
  `0700`. Independent specification and quality/security reviews approved this
  as a fixture correction that does not relax production validation.
- Whole-patch review then identified that the same strict storage-root rule
  could reject existing Blade installations. Commit `af49ad5a` accepts a
  same-owner storage root only when owner `rwx` is present and group/world write
  bits are absent; namespace and leaf modes remain exactly `0700`. Its TDD RED
  rejected a `0755` root; GREEN passed the `0755` acceptance and `0770`
  rejection cases, then the related suite passed `24/24`.
- Final GREEN on `af49ad5a` with the original release command and `--retry=0`:
  `1` file, `2/2` tests passed, exit `0`; Flash `12.105s`, Pro `7.868s`, total
  Vitest duration `23.56s`.
- On final code candidate `f7945c30`, the first rerun passed Flash while Pro
  returned a retryable `api_error` before output or tool execution; the exact
  Pro rerun did the same. A minimal request to the same endpoint/model then
  returned HTTP `200`. Re-running the complete matrix unchanged with
  `--retry=0` passed `2/2`: Flash `5.263s`, Pro `47.805s`, total Vitest duration
  `57.32s`. The provider failures remain recorded and were not hidden with
  framework or model retries.
- On final code qualification HEAD `84cc8d8f`, the unchanged two-model matrix
  passed `2/2` again with framework retry `0` and model `maxRetries=0`: Flash
  `4.922s`, Pro `6.972s`, total Vitest duration `16.60s`.
- Both models produced the bounded request sequence `read:source`,
  `read:output`, `write:output`, `read:output`, exactly one successful write
  result, preserved the host source canary and absent host output parent, and
  produced remote output containing the final marker without the host canary.
- No credentials, raw remote content, or raw paths are recorded here.

### Final repository verification

- `bun run format:check`: exit `0`; checked `1520` files.
- `bun run lint`: exit `0`; `blade-code` checked `1325` files, `blade-vscode`
  passed, and `blade-web` checked `193` files, with no fixes applied.
- `bun run type-check`: exit `0` for CLI, VSCode, and Web.
- `bun run build`: exit `0` for CLI, Web, and VSCode. Only the existing
  non-fatal Browserslist `caniuse-lite` age warning and Web chunk-size warning
  remained.
- The first `bun run test:all` exposed five missing-export failures in two local
  file/snapshot fixture mocks. Commit `5b87d3da` corrected them, and their
  focused suite passed `5/5`.
- A later full run had one lease assertion failure in unchanged
  `process-tree-lifecycle.test.ts`. The exact retry passed `1/1`, an independent
  repeated run passed `5/5`, and the complete file passed `23/23`. After four
  stale `bun test` processes running for more than two days were terminated
  normally, one complete `bun run test:all` passed: main suite `461` files
  passed / `92` skipped and `5247` tests passed / `84` skipped; performance
  suite `4` files passed / `1` skipped and `9` tests passed / `1` skipped. The
  historical failure is recorded as an `intermittent failure in unchanged
  sources`; this evidence does not claim that causality or a specific root cause
  was proven.
- On final code qualification HEAD `84cc8d8f`, another full run had one
  hard-timeout message
  mismatch in unchanged `mcp-call-lifecycle.test.ts`: `460` files passed / `92`
  skipped and `5262` tests passed / `84` skipped in `519.08s`. Its exact rerun
  passed `1/1`; this is also recorded as an `intermittent failure in unchanged
  sources`.
- The subsequent final `bun run test:all` completed with exit `0`: the main
  suite passed `461` files and `5263` tests with `92` files and `84` tests
  skipped in `432.12s`; the performance suite passed `4` files and `9` tests
  with one file and one test skipped in `7.48s`.
- One `CI=true bun run --filter blade-code test:coverage` wrapper run reached its
  fixed `900000ms` total budget without an assertion-failure summary. The same
  Vitest config and `--project=!performance --coverage` test set was then run
  directly to natural completion with exit `0`: `461` files passed / `92`
  skipped, `5263` tests passed / `84` skipped, duration `712.01s`; total coverage
  was statements `72.54%`, branches `66.11%`, functions `74.28%`, and lines
  `73.81%`.

## Final Verification

The focused deterministic suites, paired real production-Agent qualification,
GUI/TUI surface suites, whole-patch reviews, format, lint, type-check, build,
final `test:all`, and equivalent complete coverage run passed. The two earlier
intermittent failures in unchanged sources and their successful exact reruns
remain explicitly recorded.

- `v0.10.127..84cc8d8f` code and qualification-support commit count: `23`
- current code qualification HEAD:
  `84cc8d8f0dc5a5bbdbe2d1f9f407ae7638551aa8`
- evidence, reference, changelog, and version metadata remain within the seven-file
  Task 9 release boundary

## Limitations

- This patch does not provide a cross-process, cross-host, or cross-reconnect
  global transaction guarantee.
- Windows short-name handling fails closed only for common `~digit` spellings;
  arbitrary short-name identity remains unsolved.
- The remote capability boundary is a fail-closed reduction of available tools;
  it does not mean ACP remote Sessions gain all local tools.
- Full Web remote-session catalog/load/fork support, a remote file browser, and
  an owner-bound remote terminal bridge will be built as a separate patch. This
  release does not expose the host-private state scope to Web.
- GitHub Release creation, annotated tagging, and npm publication have not run;
  they are performed by the tag-triggered `publish.yml` after this evidence gate.
