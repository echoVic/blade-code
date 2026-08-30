# Background Subagent Completion Dispatcher Release Evidence

## 2026-08-30 Qualification (`blade-code@0.10.124`)

- Design commit: `2f2fad23`
- Implementation-plan commit: `13a0964b`
- Owner-scoped dispatcher commits: `0418bf8c`, `9ac9b1ee`, `a6834e72`
- `SessionRuntime` handoff commits: `1ac82541`, `3cbafde5`, `9cde4218`
- Task/Team compatibility-test commits: `1a94970b`, `8aef024d`
- Real Runtime-replacement qualification commits: `bd8a72b5`, `d5e8c64e`, `23bcf44d`
- Goal: when a background child completes after its parent `SessionRuntime` has been replaced
  in the same process, the stale completion callback must route the durable completion to the
  current Runtime without losing the parent wake, reviving the old Runtime, or duplicating the
  receipt.

## Release boundary

- The process-wide dispatcher stores only an ephemeral route from `{projectPath, sessionId}`
  to the current Runtime sink. It owns no completion payload and does not replace
  `SessionLease` or the durable child sidecar.
- Attach, initial full reconciliation, dispatch, and detach are serialized per owner; unrelated
  owners remain parallel.
- Runtime attach completes its full reconciliation before `SessionRuntime.create()` returns. A
  dispatch with no live sink returns `deferred`; the next Runtime repairs from the terminal child
  sidecar.
- Detach is token-checked and idempotent, and joins earlier dispatches. Runtime disposal is
  single-flight and detaches/joins before clearing mailbox, engine, and child state and before
  releasing the Session lease.
- An async-context guard rejects direct, indirect, and fire-and-forget same-owner sink
  reentrancy while allowing nested dispatch for unrelated owners.
- The Runtime sink preserves the existing order: validate child/owner/committed Task provenance,
  write the transcript receipt and terminal `subtask_ref`, write the durable inbox, mark local
  settlement, publish the Bus wake, and finally release waiters. ACK remains the exactly-once
  authority.

## Deterministic RED/GREEN evidence

Implementation was test-first. The initial RED reproduced this failure: Runtime A exited and
Runtime B completed its startup scan while the child was still running; after the child became
terminal, invoking A's captured callback left B's mailbox empty. The GREEN routes that stale
callback through the owner dispatcher to B. Review-driven regressions additionally cover:

- no-sink deferral, attach-time reconciliation, dispatch/attach races, detach join, duplicate
  attach, stale-token detach, unrelated-owner parallelism, and zero leaked owner operations;
- fail-closed same-owner reentrancy, including indirect and fire-and-forget cases, while nested
  dispatch across owners completes;
- one receipt/inbox/Bus result when a stale callback races the current full scan;
- repair on the next attach after no live Runtime, and no injection after rewind removes Task;
- typed admission and lineage for failed, cancelled, and resumed children;
- successor waiter wake, a false result for disposed-Runtime waiters, attach rollback with lease
  release, and single cleanup after concurrent dispose joins in-flight dispatch;
- finalized worktree/terminal sidecar persistence before the completion observer, and stable
  Task notification before UI progress and `subagent.complete`;
- Team task-unblock/member/team-completion events before parent notification; and no receipt,
  inbox item, or Bus wake for a terminal Team member without a matching committed background
  `Task`.

Final focused results:

- dispatcher: 17/17 passed;
- SessionRuntime, BackgroundAgentManager, Task bridge, and Team tools: 134/134 passed;
- deterministic cross-surface gate: 6 files and 384/384 passed. The TUI hook retained its known
  React `act(...)` environment warnings, with no assertion failure.

## Independent review

- The dispatcher and Runtime integration each passed specification review followed by
  code-quality/concurrency review. Every Critical or Important finding received a focused
  RED/GREEN regression and an approved re-review.
- Task 3 specification review required direct proof that Runtime B saw the running child during
  startup. The trajectory now uses `runtimeB.listSubagents()` to lock the exact child, parent
  Session, canonical workspace, `background=true`, and `status=running`, and verifies unchanged
  sidecar bytes across attach. The re-review verdict was `APPROVED`.
- Task 3 quality review found that the terminal-sidecar ordering test could not distinguish the
  prepare and finalize `updateSession` calls. The repaired fixture uses distinct valid payloads
  and asserts `persistFinalizedWorktree -> markCompleted -> onCompleted`; the re-review verdict
  was `APPROVED`.

## Real DeepSeek Runtime-replacement qualification

The test gates the child Provider request with a Promise and permits the parent and child request
to run concurrently. Parent A uses the real model to start exactly one background `Task`, receive
its running result, perform an independent `Read`, and emit
`WAITING_FOR_BACKGROUND_COMPLETION`. The test pauses only at A's production waiter seam, proves
the child sidecar remains running, lets A commit a normal `turn_completed`, then destroys Agent A,
disposes Runtime A, and creates Runtime B for the same owner. B lists the same running child at
startup. Releasing the child causes the stale callback to publish exactly one
`subagent.completion.queued` into B and place exactly one hidden completion in B's live mailbox.
Agent B finally consumes it with `pendingInputOnly` and emits the sole
`BACKGROUND_PARENT_FINAL:<child-marker>`.

All model, framework, and command retries are disabled: model `maxRetries=0`,
`providerForegroundRecoveryMs=0`, Vitest case `retry=0`, command `--retry=0`, and
`--maxWorkers=1 --no-file-parallelism`.

| Model | Surface | Result | Duration | Framework retry |
| --- | --- | --- | ---: | ---: |
| `deepseek-v4-flash` | production Runtime A→B | passed | 8.129s | 0 |
| `deepseek-v4-pro` | production Runtime A→B | passed | 10.969s | 0 |

Each cell also proves exactly one parent `Task` call, zero `TaskOutput`, one hidden receipt, one
completion ACK, no pseudo-user message in UI-safe messages, final inbox deletion, byte-stable
child sidecar during B attach, and exactly one child run. The child run uses its expected two
Provider-request tool protocol: one request emits the sole `Read`, and the next consumes its result
to produce the terminal response.

The existing Flash/Pro × Headless/ACP/raw PTY/Web normal-completion trajectories remain intact.
A raw PTY, Web reload, or ACP close cannot precisely express “Runtime A is replaced in-process by
B while the child continues,” so this patch does not duplicate a brittle replacement case across
those transports.

### Real-test harness failure disclosure

- The first body-text matcher also occurred in the parent prompt, so it held the parent request
  instead of the child. It was replaced with a marker present only in the child system prompt.
- The first direct-Runtime run was not created under the workspace cwd. `ConfigManager` therefore
  followed the external-workspace merge path and, before any request, reported
  `Provider is not configured: deepseek` against the isolated credential store. Creating the
  Runtime inside the existing `runWithCwdOverride(workspace)` boundary fixed the harness.
- A normal child tool exchange uses two Provider requests: the first emits the sole `Read`, and
  the second consumes that result to produce the terminal response. The initial final assertion
  incorrectly treated both requests as a rerun. It now requires exactly one request before
  replacement and exactly two at terminal, while retaining the unique child sidecar and parent
  Task-call assertions.

These were harness orchestration or evidence-definition defects, not product flakes. The final
Flash/Pro cells passed at the same commit with zero retry. Diagnostics contain only bounded
lifecycle entries, counters, event kinds, and redacted error summaries; they never record headers,
API keys, or raw Provider request content.

## Release gates

- `bun run type-check`: CLI, VSCode, and Web all exited 0.
- `bun run lint`: CLI, VSCode, and Web all exited 0; CLI checked 1,296 files and Web checked
  193 files.
- `bun run build`: CLI/Web and VSCode builds exited 0. The existing non-blocking warnings
  remained for stale Browserslist data and one Web chunk larger than 500 kB.
- `bun run test:all`:
  - non-performance: 449 files passed, 91 skipped; 4,739 tests passed, 84 skipped;
  - performance: 4 files passed, 1 skipped; 9 tests passed, 1 skipped;
  - the overall command exited 0 with zero failures.
- Biome on changed files and `git diff --check`: passed.

Qualified source hashes:

```text
4dcfa6be5cb0fc8b50680cd51773fb2f3b6bc80af12abd2d03e9d711662ff48a  BackgroundSubagentCompletionDispatcher.ts
7dd1cdea8cea5bbccd25a87a40e0c3f61d098963e31307ca360115426a7470de  SessionRuntime.ts
86aaa5b2e9a9f90838c3fce961f3c1880fef6a839e7097a845af300e8b22a8de  background-subagent-completion-dispatcher.test.ts
8de3ef4ac4d098e42a88a1a21c7ba7decf2d82a2edcfef45b02b4737b2b1cf1c  session-runtime.test.ts
0c70f8b77cf36d28b5501a135429aebfb9e968dad638dc4bc1095b40d2497f69  background-agent-manager.test.ts
81eafe90f673e4f6eb9a374ebe235865e244fd80709947f2a119d26208ffafef  subagent-event-forwarding.test.ts
50dee90f0adb0cbd6120718bcf4cbafbafcb6fff226e9e0cf45ac21b12baf342  team-tools.test.ts
9eed75ab125c78d1c06eafe3541d8e71c1f7c28fd5a4917a07fd44d027fff43f  background-subagent-completion-trajectory.test.ts
```

## Excluded scope

`0.10.124` only fixes background-completion dispatch after in-process parent Runtime replacement
and adds Task/Team plus existing-surface compatibility evidence. A cross-process message bus, Web
Session projection residency, ACP remote-filesystem semantics, and long-task false-progress
detection remain separate follow-up P1 work.
