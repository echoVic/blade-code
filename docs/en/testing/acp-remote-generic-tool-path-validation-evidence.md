# ACP Remote Generic Tool Path Validation Evidence

- Date: 2026-09-04
- Target version: `blade-code@0.10.130`
- Baseline: `v0.10.129` / `0b221cd080274785401f72577c9eed867f4eb6a8`
- Currently qualified code candidate: `6a36896df7eaf8f5c58e1278c91c1c912e72d184`
- Framework retry: `0`
- Provider model retry: `0`

## Result

The generic ACP remote tool-execution boundary now validates every declared remote
file path after schema validation and before hooks, schedulers, file locks, tool
invocation, or ACP filesystem I/O. The same validator runs again after a hook
rewrites an invocation.

Validated sources include:

- `file_path`;
- `notebook_path`;
- the generic `path` field on `ToolKind.Write`;
- every path returned by `ToolInvocation.getAffectedPaths()`.

The builtin `ApplyPatch` keeps its transaction-level relative-path preflight. That
exception is bound to both builtin registry identity and tool name, so a dynamic MCP
tool cannot acquire it through a name collision. A failure while deriving
`affectedPaths()` also fails closed as the fixed, redacted
`acp_remote_path_invalid` result. Local and ACP-local semantics are unchanged.

## TDD Evidence

The initial RED was run before the production change:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts --reporter=dot
```

```text
Test Files  1 failed (1)
Tests       3 failed | 48 passed (51)
```

The three causal failures proved that:

1. a generic `path` on a remote write MCP tool was invoked;
2. an invalid second path declared only through `affectedPaths()` was invoked;
3. a hook-rewritten declared path was invoked.

Review-driven REDs additionally proved that:

- a dynamic MCP tool named `ApplyPatch` could receive a name-only exemption;
- `file_path ?? notebook_path` could hide the second field behind a safe first field;
- a concurrency-safe MCP `file_path` could bypass the gate;
- an exception from `affectedPaths()` could expose a raw remote path to the model.

Each case was observed failing before its production correction.

## Deterministic Verification

Final focused unit result:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/workspace-tool-policy.test.ts \
  --reporter=dot
```

```text
Test Files  2 passed (2)
Tests       62 passed (62)
```

This covers the ToolExecutor remote path boundary, workspace policy, both fixed
fields, multiple paths, hook rewrites, builtin identity, derivation-error
redaction, readonly business `path`, and local parity.

Final focused integration result:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/tool-executor.test.ts \
  tests/integration/acp-remote-file-tools.test.ts \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts \
  --reporter=dot
```

```text
Test Files  5 passed (5)
Tests       190 passed (190)
```

This covers ToolExecutor, paired ACP remote Read/Write/Edit, ApplyPatch planning,
transactions, and crash recovery.

Static and build gates:

```bash
bun run format:check && bun run lint && bun run type-check && bun run build
git diff --check
```

```text
bun run format:check  PASS
bun run lint          PASS
bun run type-check    PASS
bun run build         PASS
git diff --check      PASS
```

Complete repository tests:

```bash
bun run test:all
```

```text
Main test projects: 474 files passed, 94 skipped
Main tests:         5481 passed, 84 skipped
Duration:           319.43s
Performance:        4 files passed, 1 skipped
Performance tests:  9 passed, 1 skipped
Duration:           5.46s
```

## Real API and Surface Non-Interference

Directly relevant paired ACP remote-filesystem real-API trajectory:

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
  bun x vitest run --config vitest.config.ts --project=real-api \
  tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts \
  --retry=0 --reporter=verbose
```

| Model | Result | Duration | Framework retry |
| --- | --- | ---: | ---: |
| `deepseek-v4-flash` | passed | 4.910s | 0 |
| `deepseek-v4-pro` | passed | 5.454s | 0 |

Production-surface non-interference trajectory through the shared runtime:

```bash
cd packages/cli
REAL_API_TEST=1 bun x vitest run --config vitest.config.ts \
  --project=real-api \
  tests/integration/real-api/foreground-bounded-output-trajectory.test.ts \
  --retry=0 -t "× '(pty|web)'" --reporter=verbose
```

| Surface | Model | Result | Duration | Framework retry |
| --- | --- | --- | ---: | ---: |
| raw PTY TUI | `deepseek-v4-flash` | passed | 27.087s | 0 |
| Chromium Web GUI | `deepseek-v4-flash` | passed | 26.877s | 0 |
| raw PTY TUI | `deepseek-v4-pro` | passed | 29.122s | 0 |
| Chromium Web GUI | `deepseek-v4-pro` | passed | 26.318s | 0 |

These four surface cells prove that the shared ToolExecutor change did not break the
existing TUI/Web real execution and recovery paths. The new generic-path branch itself
is proven by the causal RED/GREEN and paired ACP integration above; the surface result
is not overstated as a model-driven dynamic generic-path MCP call.

## Review

Two independent reviewers both returned `APPROVED` for exact candidate
`6a36896df7eaf8f5c58e1278c91c1c912e72d184`:

- specification review: Critical `0`, Important `0`, Minor `0`;
- quality/security/concurrency review: Critical `0`, Important `0`, Minor `0`.

The specification review of the earlier `3725b248` candidate found that a
concurrency-safe MCP `file_path` could bypass validation. The main thread first
reproduced that issue as a RED and closed it in `fd4bbb19`; `6a36896d` then added
redaction for `affectedPaths()` derivation failures. Conclusions for older SHAs were
not used as final evidence.

## Evidence Boundary

- No Provider credential was printed, stored, or committed.
- Rejected raw remote paths do not enter errors, metadata, model results, or user surfaces.
- `executionStarted` and the ToolExecutor in-memory history retain their existing
  internal diagnostic contract; no production consumer currently projects them to logs
  or user surfaces. This patch does not expand that event API.
- This patch adds no remote capability, does not alter builtin `ApplyPatch` transaction
  semantics, and does not change GUI/TUI interactions.

## Current Candidate Source Hashes

```text
ToolExecutor.ts
aa52cfd2cf0f57353248b662a8ad5d4e804412cf825e419913431dca216e4715

tool-executor-filelock.test.ts
6e9a88bc74a16abdc8fd9f954189e7b2a1c65310a5e51f91a74f2e29a2253e47
```

These production/test hashes must remain unchanged after evidence-only and release
metadata edits. Otherwise all qualification results are invalid and must be rerun.
