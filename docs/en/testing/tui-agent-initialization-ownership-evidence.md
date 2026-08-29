# TUI Agent Initialization Ownership Release Evidence

## 2026-08-30 Qualification (`blade-code@0.10.122`)

- Design commit: `b57511874b8c73ee42c02d7ed28082ecbaaf78be`
- Implementation plan commit: `32cbb3f0254e75f48eaed4fd730f904ea9223f83`
- RED commit: `c721ca9d66f1c829b2d21f86a35185eb480471a2`
- Implementation commit: `f4aae2e2c3e0384beda952c5cae8dd4b891fd9ee`
- Real-model test commit: `2dddc3dee5515350bdbd39cb3335437555b29b96`
- Goal: make the TUI hook own asynchronous Runtime and Agent initialization so
  unmount, graceful shutdown, Session/workspace replacement, and concurrent turns cannot
  publish late resources or leak ownership.

## Reachable races before the fix

- While `SessionRuntime.create()` was pending, cleanup could not see its candidate; the
  old call could publish the Runtime and continue creating an Agent after its owner closed.
- A late `Agent.createWithRuntime()` or standalone `Agent.create()` could overwrite state
  belonging to a newer Session or creation target.
- Identical targets had no single-flight and could construct duplicate Runtime/Agent owners.
- A later turn overwrote the committed Agent without first awaiting its asynchronous destroy.
- Lifecycle `AbortError` reached the command layer as a visible assistant error.

## Deterministic RED/GREEN evidence

The initial Promise-gated RED suite used neither sleeps nor Providers. It reproduced seven
`useAgent()` lifecycle failures and one command cancellation failure: Runtime creation during
unmount and graceful cleanup, Agent creation during unmount, pending Runtime replacement,
old-Agent retention across turns, missing exact-target single-flight, different-target stale
publication, and visible lifecycle cancellation.

Review-driven REDs additionally covered the old-Agent ownership handoff window, stale
candidate cleanup errors, external cleanup crossing, valid reconstruction after reusable
same-owner cleanup, latest-workspace selection while waiting for cleanup, real cleanup
`AbortError` precedence, different-target invalidation before the first Runtime await, and
standalone exact-target single-flight while a Session Runtime remains owned.

Final focused results:

- `useAgent.test.tsx`: 30/30 passed;
- `useCommandHandler.test.tsx`: 18/18 passed;
- combined: 48/48 passed;
- only the existing React `act(...)` environment notice remained, with no assertion failure.

The repaired boundary now provides current-generation Runtime single-flight by
`{sessionId, workspaceRoot}`, exact Agent target identity, pre-await different-target
invalidation, local ownership and cleanup of late candidates, reusable cleanup barriers that
restart through the latest rendered hook options, terminal close through `accepting=false`,
Agent-before-Runtime cleanup ordering, first cleanup-error propagation, and silent handling
only for locally branded lifecycle cancellation.

## Independent review

- Specification review checked exact targets, single-flight, generation fencing, candidate
  ownership, cleanup joining/order/error precedence, Session/workspace replacement, Strict
  Mode, and lifecycle cancellation. Every finding received a deterministic regression and a
  fix; the final verdict was APPROVED.
- Code-quality/concurrency review checked cleanup crossing, old-Agent handoff, stale cleanup
  failure, pre-await different-target fencing, and standalone target identity. It found no
  remaining deterministic deadlock, double cleanup, or ownership leak: APPROVED.
- The real-API test review required proof that asynchronous `destroy()` settled before the
  second factory entered, and a credential assertion that could not print the secret on
  failure. Both were corrected; the final verdict was APPROVED.

## Real DeepSeek and raw PTY qualification

The new TUI hook trajectory fixes `providerForegroundRecoveryMs=0`, model `maxRetries=0`,
Vitest case `retry=0`, and command-line `--retry=0`. Each model completed two exact-marker
turns through one mounted hook, one Session, and one Runtime. The test proves that the first
Agent's asynchronous destroy settled before the second Agent factory entered, and that the
same Session/workspace lease could be acquired after hook cleanup.

| Model | Surface | Result | Duration | Framework retry |
| --- | --- | --- | ---: | ---: |
| `deepseek-v4-flash` | TUI hook, two real turns | passed | 3.073s | 0 |
| `deepseek-v4-pro` | TUI hook, two real turns | passed | 3.710s | 0 |
| `deepseek-v4-flash` | production CLI raw PTY follow-up | passed | 11.447s | 0 |

The raw PTY control used the real `dist/blade.js`, `bun-pty`, nonce-bound composer
readiness, and bracketed paste to complete a normal Provider follow-up after durable Goal
recovery. No computer-use tool is available in this environment, so raw PTY is the
authoritative CLI UI surface. Structured results assert only
`credentialLeakDetected === false`; the secret is never passed as a matcher argument or
written into evidence.

### Real-test harness failure disclosure

- The first command passed a repository-root-relative test path to the package-local Vitest
  config. Vitest reported `No test files found`; no test or Provider request ran.
- The first test revision pointed `BLADE_STORAGE_ROOT` at an empty directory. Both models
  failed fast during Runtime initialization with `model configuration not found`; no Provider
  request ran.
- After storage isolation was corrected, both models completed all four real responses and
  Agent replacement checks, but the post-cleanup probe Runtime re-resolved mutable config and
  reported `model configuration not found`. The final probe reuses the first Runtime's frozen
  model-resource snapshot. The same zero-retry command then passed 2/2.

These were test-harness configuration defects, not product flakes, and no framework retry was
used to hide them.

## Release gates

- `bun run type-check`: CLI, VSCode, and Web all exited 0.
- `bun run lint`: CLI, VSCode, and Web all exited 0.
- `bun run build`: CLI/Web and VSCode builds exited 0. Existing non-blocking warnings remained
  for stale Browserslist data and one Web chunk larger than 500 kB.
- First `bun run test:all` passed:
  - non-performance: 448 files passed, 91 skipped; 4,631 tests passed, 85 skipped;
  - performance: 4 files passed, 1 skipped; 9 tests passed, 1 skipped;
  - overall exit code 0 with zero failures.
- Biome on changed files and `git diff --check` both exited 0.

Qualified source hashes:

```text
7b410e1640c39d8a10a26e972dee3a9e658bf077d5d89b3d7f269281d987b7fc  useAgent.ts
d5401f945c8b87747dbb115d2eb18734484293d3643fa17cd626cc8385d92ca6  useCommandHandler.ts
989397c53e5948fd01f6ea599938c803c54450babd67fd1eb5636aee44fd82e1  useAgent.test.tsx
39b3cf0d3ca6b2c02826ea0b8c2b8054afad86a94f3ff0e1071091d1fa6bfa46  useCommandHandler.test.tsx
07cf1a892d1d55a0b9491ab59382afb3a586d581e2b6c0b0cb9d032a7a38bb90  tui-runtime-lifecycle.test.tsx
```

## Release boundary

`0.10.122` contains only TUI Runtime/Agent initialization ownership, deterministic
regressions, real-model and raw-PTY non-interference qualification, design/plan, this
evidence, bilingual changelogs, and the package version. TUI pending-resume retry, background
child completion dispatch, Web projection residency, ACP filesystem semantics, and
long-task false-progress detection remain separate follow-up patches.
