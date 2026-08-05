# Session Discovery and Durable Fork Qualification Evidence

## Build identity

- Integration base: `20c3de2e` (`v0.7.6`)
- Integrated source: `f2e79333` (`feat/session-discovery-fork`)
- Candidate branch: `integrate/session-discovery-fork`
- Qualification date: 2026-08-05

The integration excludes the previously removed session discovery plan and spec:

- `docs/superpowers/plans/2026-08-03-session-discovery-durable-fork.md`
- `docs/superpowers/specs/2026-08-03-session-discovery-durable-fork-design.md`

## Result

| Surface | Deterministic evidence | Real API evidence | Status |
|---|---|---|---|
| Runtime | catalog, JSONL, fork, lineage, lease tests | Flash and Pro runtime fork trajectories | PASS |
| CLI/TUI | `/fork`, selector, activation, stale closure tests | Flash and Pro CLI/TUI trajectories | PASS |
| Web | exact SessionRef routes, atomic navigation, SSE tests | Flash and Pro HTTP/SSE fork trajectories | PASS |
| ACP | list/fork lifecycle and NDJSON integration tests | Flash and Pro paired SDK trajectories | PASS |
| Goal integration | exact-workspace Goal route/store/TUI tests | Flash and Pro Core/Web/ACP Goal trajectories | PASS |
| Parent immutability | stable JSONL snapshot and fork tests | verified by every fork trajectory | PASS |
| Secret handling | request/evidence scanners | no key in structured evidence | PASS |

## Local gate

From the repository root:

```bash
bun run qualify:local
```

Final result:

- qualification: 14/14 checks passed;
- unit: 150 files, 1821 passed, 1 skipped;
- integration: 8 files, 56 passed;
- CLI: 3 files, 8 passed;
- headless/runtime: 9 files, 131 passed;
- E2E: 2 files, 14 passed;
- snapshot: 1 file, 9 passed;
- security: 3 files, 38 passed;
- Web: 14 files, 97 passed;
- performance: 2 files passed, 1 skipped; 15 passed, 1 skipped;
- CLI/Web/VS Code production builds: passed;
- `git diff --check`: passed.

## Focused real API gate

Credentials were injected only into test subprocess environments. The evidence
contains no API key, raw request headers, or full environment dump.

Required model matrix:

- `deepseek-v4-flash`
- `deepseek-v4-pro`

Production entrypoint results:

| Trajectory | Result |
|---|---|
| CLI durable fork | 2/2 |
| Runtime durable fork | 2/2 |
| TUI durable fork | 2/2 |
| Web regressions and durable fork | 8/8 |
| ACP lifecycle and durable fork | 11/11 |
| Goal Core/Web/ACP | Flash 3/3, Pro 3/3 |

The fork trajectories prove exact file effects, parent transcript byte
immutability, root/parent lineage, child-only appends, compound
`sessionId + projectPath` routing, runtime cleanup, and secret absence.

## Failure and rerun evidence

1. The first TUI fork run was blocked before the model workflow by an `EPERM`
   write to `~/.blade/logs/stream-debug.log`. `StreamDebugLogger` now resolves
   its path from `BLADE_STORAGE_ROOT` and cannot interrupt the agent loop when
   debug logging is unavailable. Two focused logger tests and both TUI model
   trajectories passed after the fix.
2. The first Flash Web Goal trajectory reached `budget_limited`. The isolated
   rerun passed. The test now reports terminal status, continuation count,
   token usage, and tool sequence instead of waiting until timeout without
   diagnostics.
3. The ACP Goal test fixture lacked the SDK connection `signal`. The shared
   mock now implements `AbortSignal`; 86 ACP unit tests and the Flash/Pro ACP
   Goal trajectories passed after the fix.

## Scope audit

- No conflict markers remain.
- No deleted plan/spec document was restored.
- The pre-integration local documentation commits remain available at
  `backup/local-main-docs-20260805`.
- This evidence covers the controlled local integration. It does not claim
  that the integration branch was pushed or released.
