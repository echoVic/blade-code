# Durable Goal Finalization Handoff

## Problem

Goal completion currently crosses two durable stores:

1. the final assistant message and `turnFinalization` receipt are committed to the
   Session JSONL;
2. `GoalStore.finalizeVerifiedCompletion()` atomically changes the Goal sidecar
   from `verifying/pass` to `complete`;
3. `finishTurn()` commits `inbox_acknowledged + turn_completed`.

A process exit between steps 1 and 2 leaves authoritative final output in JSONL,
but the Goal remains `verifying/pass`. The existing restart rule deliberately
invalidates every persisted PASS and starts a fresh verifier. That rule is correct
when only the Goal sidecar exists, but it is unnecessarily destructive after the
host has committed the final assistant receipt. It can repeat an expensive
verifier, produce a second final answer, and keep an already completed long task
active.

The adjacent noninteractive gap is that startup recovery can close a final-ready
turn before Headless or Print dispatches. Bare `--resume` then reports
`No unfinished turn or active goal to resume` even though that process just
recovered a final response.

## Reference Behavior

- Codex treats durable item completion and `TurnComplete` as authoritative replay
  boundaries. Clients rebuild final output from completed items instead of
  submitting the completed turn again.
- Claude Code re-enqueues only conversations classified as interrupted. A terminal
  assistant tail is treated as normal completion.
- Grok Build exposes a durable `turn_completed` lifecycle record to reconnecting
  leader clients.
- Neovate keeps queued input behind task completion, but does not provide a
  stronger cross-store completion contract to copy.

Blade keeps its JSONL event-sourced model and adds a host-owned handoff receipt
rather than inferring completion from message shape.

## Durable Receipt

`SessionTurnFinalizationInfo` gains an optional `goalFinalization` object:

```ts
interface SessionGoalFinalizationInfo {
  goalId: string;
  verificationAttempt: number;
  verifierSessionId: string;
  evidenceSha256: string;
  goalUpdatedAt: string;
}
```

The loop may create this object only when the current persisted Goal has all of:

- `status === "verifying"`;
- `completionVerification.status === "pass"`;
- a non-empty verifier Session identity;
- a valid 64-character lowercase SHA-256 digest;
- the same Goal identity and verification attempt as the current host run.

The object is nested inside the same final assistant `turnFinalization` metadata.
It is not model-controlled and is committed before Goal finalization.

## Commit Order

Normal completion uses this order:

```text
fresh verifier PASS persisted in GoalStore
  -> final assistant + turnFinalization(goalFinalization) JSONL commit
  -> GoalStore finalize with exact receipt match
  -> inbox_acknowledged + turn_completed JSONL batch
  -> surface completion publication
```

No surface may publish successful completion before the final assistant commit.

## Startup Reconciliation

After Session lease acquisition and process/workspace reconciliation:

1. repair an interrupted final-ready turn from its JSONL receipt;
2. locate the latest effective `goalFinalization` receipt, including a receipt
   whose turn was completed by an earlier recovery attempt;
3. read the current Goal sidecar;
4. finalize only when Goal ID, verifying PASS, attempt, verifier identity,
   evidence digest, and `updatedAt` exactly match;
5. persist `complete` atomically and emit the committed Goal snapshot;
6. reload the durable inbox after a recovered turn completion.

Reconciliation is idempotent:

- the same receipt against the same completed Goal is a no-op;
- no Goal, a different Goal ID, edited Goal state, paused/blocked state, or any
  verification mismatch is ignored as stale;
- malformed receipt data invalidates final-ready recovery and follows the normal
  interrupted-turn path;
- Goal sidecar I/O failure aborts Runtime initialization. A later startup scans
  the JSONL receipt again even if the turn terminal was already repaired.

Without an exact receipt match, the existing fresh-host rule remains unchanged:
a persisted PASS is invalidated and a new independent verifier is required.

## Startup Result Projection

`SessionRuntime` retains only the recovery performed by the current initialization.
When it recovered a completed turn, it can return the exact assistant message
carrying that turn's receipt.

- Headless bare resume emits the recovered assistant and successful completion
  without a Provider request.
- Print bare resume renders the same response in text, JSON, or stream-json form.
- TUI and Web render the already persisted history after Runtime reconciliation.
- ACP `session/load` replays the already persisted assistant and completed Goal.

Ordinary resume with no pending work and no startup recovery continues to fail
closed. A historical completed turn is never replayed as a new result.

## Verification

Deterministic tests must cover:

- strict receipt parsing and malformed nested receipt rejection;
- exact-match Goal finalization, idempotence, stale/mismatched receipt rejection,
  and Goal sidecar write failure;
- recovery after final assistant commit but before Goal finalize;
- recovery after turn completion but before Goal finalize;
- no fresh-host PASS invalidation after an exact final receipt;
- ordinary persisted PASS without a receipt still requires fresh verification;
- Headless and Print zero-input recovered-result projection;
- Web, TUI, and ACP history replay without a duplicate Provider request.

The release-blocking real API matrix uses DeepSeek Flash and Pro across Headless,
raw PTY TUI, production Chromium Web GUI, and real ACP `session/load`. Each cell:

1. starts from the same final-assistant/Goal-sidecar crash fixture;
2. proves startup performs zero Provider requests while completing the Goal;
3. proves the final answer appears exactly once and the inbox is removed;
4. sends one new follow-up through the same surface and receives a real Provider
   response, proving the surface remains usable;
5. verifies no duplicate verifier, mutation, credential exposure, process, port,
   PTY, or browser residue.
