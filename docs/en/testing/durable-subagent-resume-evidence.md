# Durable Subagent Resume Qualification Evidence

## Scope

- durable foreground and background Task sessions;
- immutable root, child and grandchild lineage;
- source transcript and frozen execution identity restoration;
- compound `sessionId + projectPath` ownership;
- process restart and worktree lease restoration;
- Runtime, TUI, Web, ACP and headless JSONL integration;
- Web GUI resume, polling, retry, disabled state and refresh reconstruction.

## v0.10.22 Crash Reconciliation Evidence

- `qualify:local`: 14/14 checks, exit 0;
- `qualify:production`: 15/15 checks, exit 0;
- deterministic integration suite: 145/145;
- Web GUI suite: 398/398;
- release-blocking real API suite: 26/26.

The added crash matrix proves:

- a child owner PID is paired with a platform process-start identity, and a reused
  live PID does not block Session or subagent recovery;
- parent cold Runtime acquires the child Session lease, commits interrupted
  turn/orphan-tool receipts, and merges authoritative child JSONL history into
  inherited sidecar history exactly once;
- a final-ready child with a current-run assistant result recovers as completed,
  while an empty final cannot reuse an inherited assistant result;
- interrupted worktree changes are preserved, completed clean worktrees are
  removed, and stale missing worktree leases are cleared;
- corrupt child JSONL produces a bounded recovery-failed receipt and disables
  resume without blocking the parent Session;
- a real DeepSeek stream was held after its first content delta, the Blade owner
  was killed, and a new immutable child recovered a token absent from the
  follow-up prompt;
- Web hides Resume and renders the durable error for recovery-failed sources;
  ACP does not emit a false in-progress tool call; TaskOutput exposes only the
  bounded restart outcome and timestamp.
- the first complete Local Qualification run exposed a high-load background
  shell gate race: the owner could exit before the release byte reached the
  wrapper pipe. `startBackgroundProcess()` now waits for the write callback
  before returning its tool result; the focused shell matrix, final Local
  Qualification, and both hard-kill real API trajectories passed afterward.

## Deterministic Evidence

- focused Runtime/TUI/Web/ACP and persistence matrix: 18 files, 295 passed;
- complete Web suite: 15 files, 111 passed;
- complete unit suite after the owner-PID audit fix: 153 files, 1862 passed,
  1 skipped;
- `qualify:local`: 14/14 checks, exit 0;
- complete production `ready`: 15/15 checks, exit 0;
- complete real API suite: 25 files, 117 passed;
- full V8 coverage gate: exit 0; wall-clock performance runs separately after
  the production build and passed 15 tests with 1 explicit benchmark skip;
- CLI, VS Code and Web type checks: passed;
- `git diff --check`: passed.

The deterministic matrix proves:

- foreground root persistence survives manager reconstruction;
- root -> child -> grandchild uses three independent IDs and never mutates a
  source sidecar;
- source model, permissions, tools, system prompt and isolation win over later
  registry changes;
- cross-workspace and type-conflicting resume attempts fail closed;
- a restored worktree keeps its source lease owner while the resumed run gets a
  new agent ID;
- a live owner PID is not marked orphan by another Blade process, while a dead
  owner PID is reconciled;
- REST responses omit prompt, messages, configuration, workspace and owner PID;
- TUI progress, Web SSE, ACP tool updates and headless events preserve the same
  lineage fields;
- `subtask_ref` history projection resolves tool-call IDs after page refresh.

## Web GUI Evidence

An isolated non-watch server and temporary storage root were used with the
production Web UI and session routes:

1. loaded a completed subagent card at resume depth 1;
2. submitted a follow-up through the card and observed a new running child;
3. observed completion at depth 2 with the expected real-model answer;
4. refreshed the page and reconstructed the latest descendant from persisted
   lineage;
5. resumed again from depth 2 and observed a new depth-3 child;
6. verified both resumed answers recovered `gui-module-aurora` without placing
   that value in either follow-up prompt;
7. verified resume controls were unavailable while the parent or child was
   running;
8. verified the browser console contained no errors.

The descendant selector requires a matching root and a depth greater than the
rendered card. This prevents a refreshed ancestor card from creating a sibling
of the latest child.

## Real API Matrix

Credentials were injected only into test subprocess environments.

| Model | Runtime | TUI | Web | ACP |
|---|---:|---:|---:|---:|
| `deepseek-v4-flash` | PASS | PASS | PASS | PASS |
| `deepseek-v4-pro` | PASS | PASS | PASS | PASS |

Each trajectory first persisted a model-authored context value in the source
child, removed the original fixture source, then resumed with a natural
follow-up that did not contain the value. The resumed child recovered the value
from durable history and produced a new lineage record.

An additional real API worktree trajectory passed with immutable child IDs and
the restored source lease owner.

## Failure And Rerun Evidence

- The initial foreground trajectory persisted the stale initial message array
  after the Agent replaced `ChatContext.messages`. `SubagentExecutor` now retains
  the complete context; the Flash and Pro matrices passed after the fix.
- Early verification wording triggered provider injection protection. The
  prompt was changed to a normal code-review context while keeping the answer
  absent from the follow-up; both models passed.
- Initial history projection looked up `subtask_ref.messageId` only as an
  assistant message ID. It now also resolves tool-call IDs; refresh
  reconstruction passed.
- The first browser descendant lookup accepted ancestors and resumed depth 1
  from the root. It now requires a greater depth; the depth 1 -> 2 -> refresh ->
  3 trajectory passed.
- The pre-release audit found that manager startup could mark a running
  sidecar from another live Blade process as orphan. Running sidecars now record
  a private owner PID; full unit regression passed after the fix.
- The first complete local gate exposed single-sample startup timing noise. The
  performance test now uses a 2-second median budget over repeated samples. V8
  coverage excludes the wall-clock performance project because instrumentation
  and parallel project load invalidate its timing; performance remains a
  required independent `qualify:local` check.
- The first production `ready` run passed every local gate and 115 of 117 real
  API checks, then exposed one duplicated ACP fixture failure for Flash and Pro.
  That fixture bypassed the SDK transport by casting a recording client to an
  `AgentSideConnection`, so the required connection abort signal was absent.
  The trajectory now uses paired SDK NDJSON connections, `session/new`,
  `session/set_mode` and `session/prompt`; the exact Flash/Pro rerun passed 2/2,
  followed by a complete production rerun with 117/117 real API checks.

This ledger contains no API key, raw authorization header or full environment
dump.
