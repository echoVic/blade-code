# Host-Authoritative Goal Completion Verification

Goal mode is used to continuously advance a long-term objective across multiple model turns. Blade no longer allows the executing Agent to directly mark a Goal as `complete`: `UpdateGoal({ status: "complete" })` only submits a completion candidate; the final state is determined by an independent verification flow controlled by the host.

## State Machine

```text
active
  -> verifying        UpdateGoal complete
  -> paused/blocked   User action or genuine blockage

verifying
  -> complete         fresh goal-verification PASS
  -> verifying        FAIL/PARTIAL, malformed verification, subsequent mutation/steering
  -> paused/blocked   User action or genuine blockage
```

`verifying` is a durable state. It is written to the Goal state file together with the objective, attempt, verdict, verifier Session ID, security summary, and SHA-256 evidence digest. Only when all of the following exist simultaneously:

- `status === "verifying"`;
- `completionVerification.status === "pass"`;
- A non-empty verifier child Session ID;
- A 64-character hexadecimal SHA-256 evidence digest;

will the host allow an atomic transition to `complete`.

## Independent Verifier

Blade uses the reserved built-in `goal-verification` subagent. Users, projects, plugins, and command-line overrides cannot replace this definition.

The verifier has the following boundaries:

- Only Read, Glob, Grep, and read-only Bash are permitted;
- The workspace is exposed through a read-only sandbox;
- Write tools, secondary Task delegation, networking, and provider credentials are forbidden;
- The prompt is rewritten by the host to contain the full persisted objective and current changed-file scope;
- The verdict uses a turn-scoped JSON Schema:

```json
{
  "verdict": "pass | fail | partial",
  "summary": "requirement-by-requirement conclusion",
  "findings": ["concrete gap with locator"]
}
```

`subagent_type`, background, resume, or worktree parameters passed by the model have no control. The Goal completion gate force-normalizes the next Task to be fresh, foreground, `goal-verification`, with `isolation="none"`.

## Failure and Continuation

- `PASS`: The host persists verifier evidence first, then finalizes the Goal.
- `FAIL`: The Goal remains `verifying`; the executing Agent receives findings and continues fixing.
- `PARTIAL`: Missing or indirect evidence does not count as completion; the executing Agent continues to fill gaps.
- Missing verdict / invalid schema: after bounded corrections still fail, completion is rejected.
- Verifier runtime failure: no PASS is forged; the Goal remains incomplete.
- Model changes to `blocked`: the completion candidate is cancelled, and finalization is no longer attempted.

The Goal verifier is not affected by "do not delegate" or "one Task" constraints in user prompts, because it is a host security control plane, not work delegation requested by the user.

## Evidence Invalidation

After a completion candidate, the old verdict is immediately invalidated when any of the following events occur:

- Edit, Write, ApplyPatch, NotebookEdit, or Bash that changes the workspace;
- A Stop hook requests continuation;
- User steering arrives;
- A process restart recovers a Goal still in `verifying` without an exact host finalization receipt.

On restart, even if an old PASS already exists on disk, the host reruns a fresh verifier. This covers windows where "verdict was persisted but the final response had not yet been committed" and external workspace changes.

The sole exception is when the final assistant already carries a host-owned `turnFinalization.goalFinalization` receipt durable commit. The Runtime only idempotently finalizes to `complete` when the receipt's goal ID, attempt, verifier Session ID, evidence SHA-256, and Goal `updatedAt` all match the current `verifying/pass` sidecar. When the receipt is missing, corrupted, or mismatched, the old PASS is not trusted.

## Premature-Stop Recovery

While a Goal remains `active` or `verifying`, the host checks whether the final non-empty paragraph of a successful turn begins with a conservative self-deferral or handoff phrase, such as waiting for an internal worker, retrying later, stopping here, or declaring the work ready for review. On a match:

- The Goal sidecar persists only a stable pattern, consecutive count, and detection time; it does not store the model's original text;
- The next continuation explicitly requires reading durable task state, retrieving completed work, and taking the next concrete action immediately;
- After the second consecutive match, the prompt requires a strategy change, inspection or restart of stalled workers, and validation of current assumptions;
- On the third consecutive match of the same pattern, the host atomically changes the Goal to `blocked`, preventing unbounded token consumption;
- Ordinary progress, explicit user resume, Goal editing, or submission of a completion candidate clears the consecutive count.

This mechanism has no global continuation limit. The liveness breaker only trips after three consecutive matches of the same auditable pattern; a different pattern restarts the count at one. The user can explicitly resume after inspecting the evidence. A genuine external blocker should still be reported by the executing Agent through `UpdateGoal blocked` with concrete evidence. Full completion still requires the independent verifier.

## Cross-Platform Projection

### CLI / TUI

The status bar displays `goal:verifying`. Headless JSONL uses a stable `goal` event:

```json
{
  "event_version": 1,
  "type": "goal",
  "state": "updated",
  "goal_id": "goal_...",
  "status": "verifying",
  "verification_attempt": 1,
  "verification_status": "pass",
  "verifier_session_id": "agent_...",
  "verification_evidence_sha256": "...",
  "premature_stop_pattern": "internal_wait",
  "premature_stop_count": 2
}
```

Text output writes the lifecycle to stderr, avoiding pollution of final stdout. During recovery, the TUI status bar displays `recovery:N`.

### Web

The Goal control bar displays `Verifying completion / 正在验证完成声明`. When expanded, it shows the attempt, stable verdict, opaque verifier Session ID, security summary, and SHA-256 prefix. A fresh tab recovers the same evidence from GoalSnapshot. Automation can inspect durable recovery state through `data-blade-goal-recovery` and `data-blade-goal-recovery-pattern`.

### ACP

Goal lifecycle and verifier Task use standard session updates. On synchronous prompt completion, it can additionally return:

```json
{
  "_meta": {
    "goalCompletion": {
      "verified": true,
      "verdict": "pass",
      "verifierSessionId": "agent_...",
      "evidenceSha256": "..."
    }
  }
}
```

ACP projection does not include verifier transcripts, host paths, or credentials.
Each continuation additionally projects its continuation number, premature-stop pattern, and consecutive count through `blade/goalContinuation` metadata.

## Qualification

Deterministic tests cover:

- Candidates cannot directly complete;
- Only a fresh PASS can finalize;
- FAIL/PARTIAL, missing Task, wrong schema, and retry exhaustion fail closed;
- Mutation, steering, restart, and Stop continuation invalidate evidence;
- Reserved agent, read-only sandbox, permission boundaries, and structured verdict;
- GoalStore `0600` atomic persistence;
- Conservative premature-stop matching, false-positive controls, consecutive-count reset, and graded recovery prompts;
- Crash handoff, idempotent retry, and stale receipt rejection between the final assistant and Goal sidecar;
- CLI JSONL, TUI, Web bilingual/fresh-tab, and ACP `_meta`.

Real API qualification uses DeepSeek Flash to go through Runtime, Web REST/SSE, and ACP slash respectively: after the executing Agent completes the objective, an independent `goal-verification` child Session must appear, a host-verified PASS payload and persisted evidence digest must exist before `complete` is allowed. The Production Web GUI must additionally verify live `verifying` state, completion evidence, fresh-tab recovery, and zero application console errors. An independent crash matrix also uses Flash/Pro to cover Headless, raw PTY, Web GUI, and ACP: the recovery phase must not initiate Provider requests, the original final answer must be replayed exactly once, and afterward the same surface must complete a new real API follow-up.
