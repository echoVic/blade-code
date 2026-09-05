# Durable Follow-up Queue Qualification Evidence

- Date: 2026-09-05
- Target version: blade-code@0.10.134
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
format:check  PENDING
lint          PENDING
type-check    PASS — CLI focused; final root gate pending
build         PASS — production CLI/Web
test:all      PENDING
coverage      PENDING
git diff      PASS
~~~

This page never records Provider credentials, raw responses, or complete request bodies.
Final evidence retains only model, surface, request counts, retry budgets, marker order,
deleted-marker absence, cleanup, and secret-scan results.
