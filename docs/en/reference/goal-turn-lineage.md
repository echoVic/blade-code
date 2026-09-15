# Durable Goal Turn Lineage

Blade Code durably records a host-generated causal chain for active Goals. Long-running work
can therefore answer which turn created a Goal and which turn the current continuation
directly follows, even after automatic continuations, user follow-ups, and process restarts.
Clients only render the authoritative snapshot; they never infer relationships from time or
message text.

## Data contract

A Goal snapshot may contain:

```ts
interface GoalTurnLineage {
  rootTurnId?: string;
  currentTurnId: string;
  parentTurnId?: string;
}
```

- `rootTurnId` points to the user turn that created the Goal while that origin remains
  provable.
- `currentTurnId` identifies the latest top-level turn bound to the Goal.
- `parentTurnId` is the direct Goal-chain parent of `currentTurnId`.

Every ID is an opaque host identifier bounded to 1..128 characters. Older Goal files and
`turn_started` events without lineage remain readable; Blade does not guess or backfill a
root for them.

## Creation and advancement

When the model calls `CreateGoal` inside an active user turn, the tool can obtain the current
turn ID only from its host-only execution context. The initial `rootTurnId` and
`currentTurnId` both identify that turn. A Goal created outside a turn through `/goal`, Web,
or ACP has no trusted origin and remains rootless.

Each automatic continuation moves the previous `currentTurnId` to `parentTurnId` before
writing the new `currentTurnId`. Direct user turns and durable pending turns while a Goal is
active also join this chain, but do not increment the continuation count. The next
continuation therefore follows the user input it just processed.

`SessionRuntime` coordinates the dual write in a fixed order:

1. acquire the mailbox turn owner;
2. durably append `turn_started` with the proposed lineage;
3. commit the Goal binding through Goal ID, objective, `updatedAt`, and turn-ID fences;
4. allow a Provider request only after the commit succeeds.

A durable-start failure releases the owner. A Goal-commit failure records a failed abort for
the already-started turn. If the process crashes between start and commit, startup recovery
closes the orphan turn while the Goal sidecar retains its previously committed current turn.

## Root invalidation

Blade retains a root only while the origin remains provable:

- editing the Goal objective clears the complete lineage;
- pause/resume preserves lineage because it does not change the objective;
- additional steering, background completion, team messages, interaction recovery, or
  user-shell delivery into the same active turn clears the ambiguous root while preserving
  current/parent;
- late progress from a stale turn, old Goal ID, or old objective cannot overwrite a newer
  Goal or reconstruct an invalidated root;
- clearing the Goal removes lineage with the sidecar.

These rules form an audit boundary, not a permission mechanism. A missing root means the
current host cannot prove the origin; it does not invalidate the Goal or prevent an explicit
resume.

## Pausing and in-flight usage

Pausing a Goal stops subsequent automatic continuations without cancelling the running turn.
When that turn returns usage, tokens and elapsed time are recorded only if its Goal ID,
objective, and current turn ID all match. The paused status, reason, and recovery evidence
remain unchanged. Missing identities, stale turns, and results from before an edit or
clear/recreate cannot update the paused Goal.

If settlement reaches the token budget, the Goal remains paused. An explicit resume then
transitions it to `budget_limited` without starting another model request. Below budget,
resume still restores the existing active or verifying path.

## User interfaces and protocols

- The TUI status bar shows bounded `lineage:<root-or-?>:<current>` text with at most eight
  characters per ID. `/goal status` prints full Origin, Current, and Parent values.
- The expanded Web Goal control shows localized Origin, Current, and Parent rows and exposes
  the same values through `data-blade-goal-*-turn` attributes. Reload restores the
  authoritative Goal snapshot.
- ACP uses camelCase `turnLineage` in `blade/goal` and `blade/goalContinuation` metadata.
- Headless `goal` JSONL events use `root_turn_id`, `current_turn_id`, and `parent_turn_id`.

All four surfaces project the same `GoalSnapshot`. Missing IDs remain absent rather than
becoming fabricated `null` values, and clients keep no local parent counter.

## Privacy and non-goals

Lineage never enters Provider prompts or request metadata. It contains no message text, tool
arguments, commands, paths, output, errors, or credentials. It does not participate in
authorization, permission inheritance, or Goal completion verification and carries no pricing
or cost data. The current turn ID only fences ownership of late usage. The current
contract covers top-level Goal turns only; it is not a general provenance DAG for subagents,
forks, MCP tasks, hooks, or compaction.

See [Durable Goal Turn Lineage Qualification Evidence](../testing/goal-turn-lineage-evidence.md)
for release evidence.
