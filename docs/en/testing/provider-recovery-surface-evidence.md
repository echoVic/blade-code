# Provider Recovery Surface Qualification Evidence

- Date: 2026-09-05
- Target version: `blade-code@0.10.137`
- Design baseline: `09286d1b72eec3cef1795f487668df8dc6bf1afc`
- Qualified implementation HEAD: `9c5e70666565efb647673b05502f882a266e4a27`
- Complete local gates: `build`, `type-check`, `lint`, and `test:all` passed
- Real API command:
  `REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=0 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts`
- Cross-provider fallback command:
  `REAL_API_TEST=1 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/cross-provider-fallback-trajectory.test.ts`

## Result

The unified recovery state implementation, deterministic tests, and production-surface
real API trajectories are complete. The final release HEAD results for `build`,
`type-check`, `lint`, and `test:all` will be recorded here after release metadata is
ready. This document does not claim complete release qualification until those
commands have actually passed.

Current real Provider results:

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 10.510s | passed |
| DeepSeek V4 Flash | ACP stdio + child-backed terminal | 10.773s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 11.210s | passed |
| DeepSeek V4 Flash | production Chromium Web | 15.929s | passed |
| DeepSeek V4 Pro | Headless JSONL | 11.191s | passed |
| DeepSeek V4 Pro | ACP stdio + child-backed terminal | 13.904s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 13.126s | passed |
| DeepSeek V4 Pro | production Chromium Web | 21.292s | passed |

The eight-cell matrix passed `8/8` in 108.99s. A real Claude-to-GPT pre-output
fallback trajectory also passed `1/1` in 9.00s, proving typed source/target
identity, independent credential channels, and secret isolation. These results came
from explicit runs at the feature implementation HEAD and do not stand in for the
still-pending final repository gates.

## Runtime and Protocol Contract

Deterministic verification locks the following behavior:

- `SessionRuntime` is the sole authority for the Session-scoped, in-memory Provider
  recovery projection;
- every top-level run starts a new generation at revision `0`; old generations and
  old revisions cannot overwrite new state;
- clearing invalidates the generation. Even when a run never creates a visible
  snapshot, terminal cleanup and disposal leave no generation that a late event can
  revive;
- the reducer combines admission, retry, circuit, stall, and fallback, selecting the
  primary activity in stall > circuit > retry > admission > fallback order;
- retry heartbeats retain the waiting phase, and countdowns use the Runtime's
  absolute `nextActionAt` rather than recomputing a deadline at receipt time;
- non-empty content, thinking, tool start, structured output, and stream end clear
  visible state, while a per-turn `stream_end` does not invalidate the generation for
  the remaining multi-turn Agent run;
- completion, failure, cancellation, early consumer close, Session replacement,
  rewind, abort, and Runtime disposal clear state; the wrapper generator propagates
  `return()` to its underlying stream;
- schema failure is fail-closed and can leave only `snapshot: null`; an unvalidated
  object is never forwarded to a surface.

## Surface Evidence

### TUI

- `LoadingIndicator` renders the current recovery reason, absolute-deadline
  countdown, attempt/budget/queue details, and Esc stop guidance; `ChatStatusBar`
  renders a compact summary.
- The raw PTY runner must observe recovery in real terminal capture rather than only
  inspecting an internal store.
- typed `model_fallback` discards stale stream buffers from the failed candidate but
  does not clear the authoritative Runtime recovery snapshot.

### Web GUI

- `ProviderRecoveryBanner` sits above the composer with `role=status` and
  `aria-live=polite`; Stop reuses the existing abort API, while StatusBar reads the
  same projection.
- `connected.providerRecovery` is projected as an authoritative `provider.recovery`
  event before subscription readiness. The production Chromium trajectory reloads
  during recovery, verifies the banner is restored, then verifies terminal clear and
  preservation of the final assistant result.
- live updates accept only a new generation anchored by revision `0` and larger
  revisions within that generation. A late unanchored revision is rejected after
  terminal clear. The legacy `model.fallback` event cannot overwrite the unified
  snapshot.

### ACP and Headless

- ACP initial and live `session_info_update` messages use
  `_meta['blade/providerRecovery']`; fallback uses `_meta['blade/modelFallback']`;
- Headless JSONL uses closed-schema `provider_recovery` and `model_fallback` events,
  with an explicit `snapshot: null` clear;
- because SessionRuntime already publishes the unified event through the Session Bus,
  Web and ACP direct-stream adapters do not duplicate it.

## Privacy and Replay Boundary

- projection and fallback contain only bounded numbers, closed enums, and sanitized
  catalog provider/model identities; unknown fields, control characters, URLs, and
  oversized identities are rejected;
- API keys, base URLs, headers, request/response bodies, raw errors, credential HMACs,
  Session IDs, and internal owner identity do not enter JSONL, SSE, ACP, DOM, PTY,
  transcript, or evidence;
- fallback remains legal only before real output. Text, reasoning, tool call, usage,
  or finish prevents automatic replay or another model switch;
- the UI exposes only the existing Stop/Esc path. A recovery payload cannot supply a
  URL, command, purchase action, or forced replay.

## Test Scope

Focused deterministic coverage includes TypeBox schema/privacy, reducer transitions,
SessionRuntime Bus lifecycle, Agent terminal and early-close paths, PiAI typed
fallback, TUI presentation and loading state, Web banner/StatusBar/store/SSE
hydration, ACP metadata, Headless JSONL, and the production source-search gate. The
most recent implementation-phase focused CLI run passed 724 tests across 17 files;
the Web run passed 220 tests across 5 files, followed by a 101-test core Web
regression across 4 files.

During development the real matrix exposed three incorrect test assumptions: the
first zero-delay retries are `retry_attempt`, not `retry_wait`; circuit state outranks
retry during the wait; and the Web aggregate initially omitted reconnect-probe events.
After correcting assertions and evidence collection, the matrix passed `8/8`. The
final audit also used RED/GREEN tests to fix a retained generation after an empty
snapshot clear and Web acceptance of an unanchored late live revision.

## Final Gates

Evidence collected at `9c5e70666565efb647673b05502f882a266e4a27`:

- `bun run build`: passed;
- `bun run type-check`: passed;
- `bun run lint`: passed across 1,391 CLI files and 205 Web files;
- `bun run test:all`: passed; the non-performance stage passed 490 files with 97
  skipped and 5,705 tests with 87 skipped; the performance stage passed 4 files with
  1 skipped and 9 tests with 1 skipped; total duration was 337.36s;
- real Provider recovery matrix: 8/8 passed in 108.99s;
- real Claude-to-GPT fallback: 1/1 passed in 9.00s.

The first `test:all` attempt was terminated by a Node/V8
`EXC_BAD_ACCESS`/`SIGSEGV` inside `rolldown-binding.darwin-arm64.node`. The second run
exposed and fixed one deterministic missing `ChatStatusBar` selector mock. In that
same run, one Chromium cross-origin coordinate assertion returned
`browser_snapshot_stale`; the unchanged source test then passed 3/3 in isolation. The
complete suite was run again from the beginning after the fix and passed.

## Release Boundary

The implementation HEAD above is the qualification baseline before version metadata.
Only version metadata, the bilingual source changelogs, and this evidence metadata may
change afterward, and build plus test:all must run again before tagging. The tag must be
annotated `v0.10.137` and consumed by `publish.yml`; do not run `npm publish` manually
and do not move or rewrite an existing tag.
