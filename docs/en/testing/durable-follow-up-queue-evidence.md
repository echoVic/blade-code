# Durable Follow-up Queue Qualification Evidence

- Date: 2026-09-05
- Target version: blade-code@0.10.136
- Baseline: v0.10.133
- Framework retry: 0
- Provider model retry: 0

## Coverage result

The implementation uses durable inbox V2 as the only queue source of truth and projects
one versioned snapshot through Runtime, HTTP/SSE, TUI, Web, and ACP. Web GUI and TUI both
provide visible ordering, lock state, removal, and reordering. ACP receives only five
count-only fields and advertises no mutation capability.

Deterministic tests cover:

- v1-to-v2 migration, cross-instance concurrent enqueue, atomic replacement, and lock
  failures;
- stale versions, claim/mutation races, acknowledgement, and owner restart;
- the 160-item cap, preview bounds, artifacts, output schemas, and immutable barriers;
- exact HTTP Session identity, archive/history-only rejection, TypeBox validation, and SSE
  reconnect;
- Web keyboard/drag controls, mutation pending state, stale refresh, and focus restoration;
- TUI `/queue` keys, active-turn access, owner fencing, and transcript promotion;
- ACP initial, pending, locked, empty, and reload projection plus metadata privacy scans.

## Production raw PTY

~~~bash
bun run build:cli
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/follow-up-queue-pty.test.ts
~~~

~~~text
Test Files  1 passed
Tests       1 passed
~~~

This trajectory starts production `dist/blade.js` under a real `bun-pty`, holds the
initial turn with a deterministic local streaming Provider, submits A, B, and C through
the TUI, opens `/queue`, moves C before B, and removes B. It then resizes, closes and
reopens the panel, releases the Provider, and verifies from the second upstream request
that only A and C were consumed, once each. Runner output is bounded and teardown uses
`TERM → KILL`.

## Flash / Pro real-API surface matrix

~~~bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/follow-up-queue-trajectory.test.ts
~~~

~~~text
Test Files  1 passed
Tests       6 passed | 1 skipped gate placeholder
Duration    95.36s
Models      deepseek-v4-flash, deepseek-v4-pro
Surfaces    Web, TUI, ACP
~~~

Every trajectory sets `overrides.maxRetries=0` and asserts framework retry 0. The
transparent proxy neither generates nor replaces responses. Each surface records two
upstream requests: one initial request and one queue-consumption request. Web and TUI
prove the mutated A→C order, B absence, and no duplicates. ACP proves durable A→C
application order and the `pending → locked → empty` metadata lifecycle.

All six trajectories report `cleanupComplete: true`, no browser/server faults, and no
credential leaks. The ACP driver uses a real SDK stdio child, verifies that no mutation
capability is advertised, sends only five metadata fields, projects again after reload,
and exits normally through `session/close` and stdin EOF.

## Release gates

These values are refreshed from a clean production build before the release commit:

~~~text
format:check  PASS — 1,588 files
lint          PASS — CLI 1,384 files, Web 202 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS — production CLI/Web and VSCode
test:all      PASS — 487 files passed, 97 skipped; 5,665 tests passed, 87 skipped
performance   PASS — 4 files passed, 1 skipped; 9 tests passed, 1 skipped
coverage      PASS — 487 files passed, 97 skipped; 5,665 tests passed, 87 skipped
                statements 73.64%, branches 67.05%, functions 75.57%, lines 75.01%
git diff      PASS
~~~

The first `test:all` run correctly found that the new runner was not yet in the raw-PTY
inventory. After that fix, the second run had only a cross-process ready timeout in the
unchanged `remote-workspace-reference.test.ts`; its worktree and HEAD hash were both
`d49b21104fc8f825aafb003a59090b8fdf096cd3`, and its exact rerun passed 15/15. A fresh
final `test:all` then passed: 319.82 seconds for the main stage, 5.30 seconds for
performance, and 331.38 seconds total.

## Completion audit

| Requirement | Inspectable implementation or evidence | Result |
| --- | --- | --- |
| Runtime durability | Inbox V2, cross-instance lock, atomic write, restart generation tests | PASS |
| Performance and size bounds | 20 user entries, 160 public items, 8 MiB file cap, bounded previews | PASS |
| Long-running turns | Active enqueue, safe-boundary claim, acknowledgement clearing | PASS |
| TUI | `/queue`, complete key map, resize/reopen raw PTY | PASS |
| Web GUI | Production Chromium, buttons/drag, reload, stale snapshot | PASS |
| ACP | Real SDK stdio, five-field read-only metadata, no mutation capability | PASS |
| Real models | Flash/Pro × Web/TUI/ACP, six trajectories | PASS |
| Retry | Vitest `--retry=0`; each model has `maxRetries=0` | PASS |
| Request count | One setup plus one queue-consumption request per trajectory | PASS |
| Privacy | Metadata allowlist, stream scanning, no credential/deleted marker leaks | PASS |
| Docs and release | Bilingual reference/evidence, source changelogs, CLI-only package bump | PASS |

This page never records Provider credentials, raw responses, or complete request bodies.
Final evidence retains only model, surface, request counts, retry budgets, marker order,
deleted-marker absence, cleanup, and secret-scan results.
