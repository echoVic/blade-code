# Bounded Weighted Provider Admission Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.41`
- Design commit: `36e84d5d6ae26203c24bce25215d4187c24a5713`
- Runtime and test commit:
  `471f90f02ddfa7df423d8989ba055b396239f5c4`
- Qualified release metadata commit:
  `57b676ea1cfe5f435a77556c1cbe49cf3fd4fc36`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`
- Qualification log SHA-256:
  `d7ff26a50075bbff13851fd5ff47258f3e9fbc0782aca0397d7d3c6cef3717fb`

## Result

Production Qualification ran from a clean
`57b676ea1cfe5f435a77556c1cbe49cf3fd4fc36` worktree and passed all 16
checks.

- Unit: 3,168 passed, 1 skipped
- Integration: 172 passed
- CLI: 8 passed
- Headless runtime: 293 passed
- End-to-end: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 416 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 114 passed across 23 files

The release-blocking real-API suite completed in 2096.20s. The same
qualification type-checked and linted the CLI, VS Code extension, and Web
application, verified formatting, built the production artifacts, launched
the pinned Playwright Chromium binary, and ran the complete real Provider
matrix.

All eight weighted-admission target cells and all 12 positive control cells
passed with zero framework retry. The complete Production Qualification also
used zero framework retry. Its retained log contained no nonzero command
exit, failed test summary, credential literal, Authorization header, or
Bearer token.

## Frozen Bounds

Pending count and retained-footprint bytes are independent hard limits. A
request must satisfy every applicable global, failure-domain, root-owner, and
class limit before it can retain a queue record.

### Pending Count

| Scope | Total | Non-foreground | Internal |
| --- | ---: | ---: | ---: |
| Global | 128 | 96 | 16 |
| Failure domain | 32 | 24 | 4 |
| Root owner | 16 | 12 | 4 |

The count policy reserves 32 global, eight domain, and four owner tickets for
foreground work.

### Pending Bytes

`providerRequestPendingBytes` defaults to 128 MiB, accepts only safe integers
from 64 KiB through 128 MiB, and cannot disable the core memory bound. Active
Sessions use their frozen configuration snapshot.

| Scope | Total | Non-foreground | Internal |
| --- | ---: | ---: | ---: |
| Global | 128 MiB | 96 MiB | 16 MiB |
| Failure domain | 64 MiB | 48 MiB | 16 MiB |
| Root owner | 32 MiB | 16 MiB | 8 MiB |

For a configured global value below the defaults, domain and owner totals are
clamped to the configured value. Non-foreground receives three quarters of
the global and domain totals and one half of the owner total. Internal
receives one eighth of global and one quarter of domain and owner totals.
Priority aging changes scheduling rank only; it never changes the accounting
class or its count and byte limits.

If active capacity is immediately available and the queue is empty, one
request larger than the pending byte budget may run without a pending charge.
If that request would need to wait, it is rejected as
`queue_full/pending_bytes` before a timer, abort listener, failure-domain
record, owner record, or Provider request is created.

## Bounded Footprint Estimator

One logical `streamChat()` computes its retained footprint once across:

```text
messages + normalized pi-ai Context + tool definitions + request options
```

Primary, retry, fallback, and HalfOpen-probe physical requests reuse the same
numeric weight. The scheduler never retains the message, image/base64, tool
schema, request options, or another request graph.

The estimator:

- counts exact UTF-8 bytes for strings and raw lengths for Buffer,
  typed-array, DataView, and ArrayBuffer values;
- uses fixed charges for primitive and container structure;
- counts enumerable own string keys without invoking getters;
- uses object identity to avoid cycles and duplicate shared objects;
- does not traverse functions, symbols, accessors, or weak collections;
- stops after 100,000 nodes or 128 MiB and returns the saturated maximum plus
  one;
- does not stringify or copy the request payload.

## Accounting and Settlement

Every queued record atomically charges global, failure-domain, root-owner,
non-foreground, and internal counters as applicable. Every exit path releases
the exact same count and byte charge:

- queued to active;
- caller abort;
- explicit ticket cancellation;
- admission timeout;
- scheduler close;
- coordinated shutdown rejection.

Queued-to-active settlement removes the queue record, decrements all pending
count and byte accounting, clears its timer and abort listener, acquires the
active permit, and only then resolves the ticket. Idle owner and domain state
is removed synchronously. Caller abort preserves the caller reason, while
queue-full and admission failures use the existing sanitized public error.

## Durable and Surface Contract

The typed admission resource is exactly:

```text
stream | pending_count | pending_bytes
```

It is projected through Headless JSONL, TUI status, Web SSE/store, ACP
metadata, root loop events, and the background-subagent bridge. The public
projection does not expose request footprint, aggregate pending bytes,
configured byte limits, failure-domain identity, owner ID, Session ID,
endpoint, credential, routing headers, or HMAC material.

Headless subscribes only to the current root Session and workspace, validates
every child event field, forwards the same `provider_admission` schema without
the child Session ID, and unsubscribes on both normal and exceptional exit.

A terminal `queue_full` turn remains durably
`turn_aborted(cause=failed)`, but its claimed input is acknowledged. This
prevents Web reload, SSE reconnect, or ACP `session/load` from replaying an
input that was definitively rejected by the resource boundary. Provider
outage, admission timeout, cancellation, and crash retain their existing
recovery semantics.

## Real API Target Matrix

Every target cell called a real DeepSeek Provider through a loopback
recording proxy. Qualification used the legal 64 KiB minimum pending-byte
configuration to force an overweight waiting request. Each rejected marker
produced zero Provider request body, and all proxy, process, terminal,
browser, page, server, port, temporary HOME/storage/workspace, and
credential-bearing configuration resources were reclaimed.

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless background child | 18.139s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI background child | 85.021s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web, two Sessions | 40.981s | 0 | passed |
| DeepSeek V4 Flash | real ACP stdio, two Sessions | 43.629s | 0 | passed |
| DeepSeek V4 Pro | Headless background child | 27.841s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI background child | 82.416s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web, two Sessions | 32.054s | 0 | passed |
| DeepSeek V4 Pro | real ACP stdio, two Sessions | 21.175s | 0 | passed |

Headless emitted the rejected background child's typed event while the real
parent turn remained authoritative. Raw PTY required both the exact
pending-byte sidecar fact and a visible TUI failure summary under one shared
180-second deadline.

Web submitted Session B through the real production composer while Session A
held capacity, observed the terminal rejection in the production Chromium UI,
reloaded, and proved that the unique Session-B marker never reached the
Provider. ACP proved the same terminal result over real stdio metadata,
called `session/load`, and observed no marker replay or assistant-text
pollution.

## Positive Control Matrix

The complete positive controls prove that the weighted byte policy did not
narrow normal background completion or queued-to-admitted progress.

### Background Completion

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless parent wake | 20.113s | 0 | passed |
| DeepSeek V4 Flash | ACP durable parent wake | 5.575s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI parent wake | 36.050s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web reload | 35.004s | 0 | passed |
| DeepSeek V4 Pro | Headless parent wake | 27.758s | 0 | passed |
| DeepSeek V4 Pro | ACP durable parent wake | 5.313s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI parent wake | 44.627s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web reload | 45.181s | 0 | passed |

### Independent Session Serialization

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | production Chromium Web | 29.844s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 29.611s | 0 | passed |
| DeepSeek V4 Flash | real ACP stdio | 23.251s | 0 | passed |
| DeepSeek V4 Pro | real ACP stdio | 26.396s | 0 | passed |

The independent Session controls retained the prior count-admission
trajectory: Session B queued with zero early Provider traffic, started only
after Session A released, and both Sessions received independent real
Provider results.

## Deterministic and Regression Coverage

Deterministic tests prove:

- exact and one-over global, domain, owner, non-foreground, and internal count
  and byte limits;
- foreground count and byte reservation, including configured 64 KiB limits;
- class aging without accounting-class mutation;
- immediate oversized admission and waiting oversized zero-state rejection;
- exact uncharge on activation, abort, cancellation, timeout, close, and
  shutdown;
- UTF-8, typed-array, shared-object, cycle, getter, weak-collection,
  100,000-node, and byte-saturation estimator behavior;
- one estimator call across primary, retry, fallback, and probe paths;
- frozen config propagation through CLI, Web, Headless, ACP, and runtime
  resolution;
- identical typed schemas and terminal cleanup across all surfaces and the
  subagent bridge;
- terminal queue-full input acknowledgement without forged completion;
- source gates against request-graph retention, byte or identity projection,
  unbounded state, production bypasses, and credential leakage.

The complete control suite also kept Provider retry, foreground recovery,
shared circuit breaking, bounded output, tool admission, foreground command
handoff, graceful shutdown, Goal, durable interaction and root-turn recovery,
subagent completion/adoption, permission recovery, structured output, code
review, action stationarity, and production coding trajectories green.

## Failure and Retry Disclosure

Development runs found and fixed harness defects before qualification:

- raw PTY initially gave its sidecar and visible-state checks separate
  deadlines, so the final runner shares one 180-second evidence deadline;
- the visible-state expression required an untruncated English sentence and
  did not accept the mixed Chinese/English terminal summary;
- an initial positive-control filter omitted the Web title, so both Web model
  cells were run explicitly and retained in Production Qualification;
- Web read a request finish timestamp before proxy completion and initially
  relied on an exact assistant marker instead of the durable terminal state;
- the terminal queue-full input originally replayed after Web reload or ACP
  load until claimed-input acknowledgement was added.

The final focused target matrix passed 8/8 with `retry=0`. The complete
Production Qualification passed 16/16 and 114/114 with no `retry xN` marker.
No target, positive control, or unrelated release-blocking trajectory used a
framework retry. Business-level Provider retry and recovery tests remain
present and passed; they are not framework retries.

## Release Boundary

The exact design is
`36e84d5d6ae26203c24bce25215d4187c24a5713`. The exact runtime, tests,
configuration, and documentation qualified by real API are
`471f90f02ddfa7df423d8989ba055b396239f5c4`. The release metadata commit
`57b676ea1cfe5f435a77556c1cbe49cf3fd4fc36` changes only package version,
lockfile version, and changelog and was the clean HEAD used for Production
Qualification.

The next commit may add only this evidence file. The annotated tag must
contain no unqualified runtime, test, configuration, version, or changelog
change.
