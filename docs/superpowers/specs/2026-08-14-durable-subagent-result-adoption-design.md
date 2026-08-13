# Durable Completed-Subagent Result Adoption

## Problem

A foreground `Task` crosses two durable stores:

1. the child Session JSONL and Agent sidecar reach a terminal result;
2. the Task executor returns that result to the parent loop;
3. the parent commits the `tool_result` and `subtask_ref` to its Session JSONL.

If the Blade process exits between steps 1 and 3, the child result is durable and
authoritative, but the parent has an orphan `Task` tool call. Generic parent-turn
recovery currently writes `PROCESS_RESTART_TOOL_RESULT` with
`sideEffectsUncertain=true`. The resumed model must guess whether to repeat the
delegation or call `TaskOutput`, which can duplicate expensive work and loses the
normal completed-subagent card.

This is a result handoff gap, not a child execution recovery gap. Child Session,
worktree, process, and immutable resume lineage already have independent durable
reconciliation.

## Reference Behavior

- Codex delivers a completed child status into the parent context as a durable
  subagent notification. The parent consumes the known result instead of spawning
  equivalent work again.
- Claude Code marks the task terminal before unblocking result consumers and
  persists task output separately from the foreground renderer.
- Grok Build retains completed child snapshots in its coordinator and suppresses
  duplicate completion reminders after a result consumer has observed them.
- Neovate returns a structured `agent_result` containing stable child identity.

Blade keeps the original Task tool call/result protocol. It adopts only a
strictly matched host-owned child sidecar and writes the same canonical result
shape the normal Task path would have produced.

## Recovery Contract

After acquiring the parent Session lease, Runtime performs:

```text
process/workspace reconciliation
  -> orphan child Session reconciliation
  -> inspect active parent turn orphan tool calls
  -> validate completed child against each orphan Task
  -> parent JSONL recovery batch
  -> canonical context reload
```

The parent turn remains `turn_aborted(cause=process_restart)`. Adoption repairs
the missing tool result; it does not pretend the parent model turn completed.
The pending durable input then auto-resumes with the completed child result in
canonical context.

## Admission

An orphan tool call is adoptable only when all conditions hold:

- tool name is exactly `Task`;
- `input.subagent_session_id` is a valid child Session ID;
- the Agent sidecar belongs to the exact compound owner:
  `parent sessionId + canonical projectPath`;
- child status is `completed` or `failed` and a terminal result exists;
- result fields are structurally valid and bounded;
- child `description` equals the original Task description;
- an explicit `subagent_type` equals the child type;
- an explicit `resume_from`/legacy `resume` equals `child.resumedFrom`;
- a fresh Task has no unexpected `resumedFrom`;
- child identity, root identity, depth, isolation, worktree and verification
  metadata pass normal sidecar normalization.

Running, cancelled, missing, cross-workspace, type-conflicting, stale-resume,
malformed, oversized, or otherwise mismatched children are not adopted. Their
orphan calls keep the existing process-restart error and
`sideEffectsUncertain=true`.

## Canonical Result

Normal foreground Task completion and restart adoption share one result builder.
The adopted result preserves:

- success/error semantics and model-visible message;
- child Session ID, type, description and immutable lineage;
- bounded summary, stats, verification evidence and modified files;
- worktree path/branch and isolation;
- resume hint.

Recovery adds host metadata:

```text
processRestartRecovery = true
subagentResultAdopted = true
sideEffectsUncertain = false
```

The parent recovery commits these events in one validated JSONL batch:

```text
tool_result(original toolCallId)
subtask_ref(completed|failed child)
turn_aborted(process_restart)
```

A crash during that batch leaves no committed prefix. The next Runtime repeats
validation. Once committed, the original tool call is no longer orphaned and
adoption is idempotent.

## Surface Projection

All surfaces consume the canonical parent JSONL:

- Headless JSONL emits one recovered completed/failed Task result and child card;
- TUI restores keyed subagent progress without launching a second child;
- Web SSE/replay/fresh load renders the completed child card;
- ACP emits the original `tool_call_update` terminal status and child metadata.

No surface-specific adoption logic is allowed.

## Verification

Deterministic tests cover:

- orphan Task input projection with stable message identity;
- successful and failed child result adoption;
- atomic result, subtask and parent abort batch;
- idempotent second startup;
- strict compound owner, child ID, description, type and resume matching;
- running/cancelled/malformed/oversized/missing child fallback;
- non-Task orphan fallback remains unchanged;
- normal Task completion and adopted completion use the same result builder;
- Headless/TUI/Web/ACP replay from the same parent transcript.

Release-blocking real API qualification uses DeepSeek Flash and Pro across
Headless, raw PTY TUI, production Chromium Web GUI, and real ACP `session/load`.
Each cell starts with one model-authored completed child and a parent crash before
the Task result commit. A transparent proxy proves the resumed parent request
contains the child-only marker, while no second child Session is created. The
surface must complete a new follow-up, retain exactly one child lineage, expose no
credentials, and reclaim every process, PTY, port, browser, and proxy.
