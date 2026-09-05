# Runtime Turn Activity Surface Design

## Context

Blade already emits detailed `LoopEvent` values for turns, streaming output, tool
lifecycle, compaction, Goals, subagents, and Provider recovery. Those events are
useful for transcript rendering, but the current live status is still owned by each
consumer:

- TUI shows a generic loading phrase unless Provider recovery or action
  stationarity overrides it. It does not have one authoritative current-tool or
  turn-progress snapshot.
- Web derives `agentPhase` and active tool cards from whichever SSE events it has
  observed. A reconnect hydrates Provider recovery, but not the rest of the active
  turn's current activity.
- ACP receives several independent metadata updates, while Headless prints event
  fragments. Neither has one bounded current-activity contract.

This makes a healthy long-running turn look less informative than comparable
coding agents. Codex keeps a live turn status with elapsed time and bounded details;
Claude Code derives its spinner label from the current task or tool and reports
tool-use progress; Neovate renders a bounded recent activity view; grok-build keeps
runtime activity counters. The common requirement is not a verbose event log. It is
one trustworthy answer to: **what is the active turn doing now?**

Provider recovery remains a separate, higher-priority projection. This design does
not merge network recovery into generic activity or weaken its generation fencing.

## Goals

1. Make `SessionRuntime` the authority for the active turn's current activity.
2. Give TUI and Web a stable current phase, turn number, elapsed time, active tools,
   and bounded tool counters.
3. Repair Web state immediately after SSE reconnect and expose the same projection
   through ACP and Headless.
4. Fence late events from an older run so they cannot overwrite a newer run.
5. Support parallel tools without pretending one arbitrary tool is the entire turn.
6. Keep the projection bounded, typed, ephemeral, and free of arguments, outputs,
   paths, prompts, Provider text, or credentials.
7. Preserve current transcript, interaction, Provider-recovery, cancellation, and
   task-status contracts.

## Non-Goals

- Persisting live activity in JSONL, SQLite, Session metadata, or a browser ledger.
- Reconstructing an interrupted turn after process restart. Existing turn recovery
  remains authoritative for that case.
- Replacing transcript tool cards, Task lists, Goal frontier, Provider recovery, or
  durable pending-interaction UI.
- Estimating percentage completion for a whole coding task. Blade only reports
  explicit tool progress; it does not invent a completion percentage.
- Exposing tool arguments, progress messages, command lines, file paths, prompts,
  response text, raw errors, or subagent instructions in the cross-surface snapshot.
- Adding a new mutation API. Activity is read-only observation.

## Considered Approaches

### A. Keep deriving state independently in each consumer

This is the smallest implementation, but it preserves the current defects: Web
cannot repair missed ephemeral events, every surface chooses different precedence,
and late events can revive stale activity. Rejected.

### B. Persist an activity ledger

Persistence would allow cold-start history, but a stored `executing_tools` value is
false after the owning process exits. Correct repair would require another durable
turn-state protocol and would duplicate existing turn recovery. Rejected.

### C. Runtime-owned ephemeral projection with generation fencing

`SessionRuntime` reduces the LoopEvent stream into a small snapshot, publishes each
accepted revision on the Session Bus, and clears it at every terminal boundary. Web
and ACP can request the current snapshot from their resident Runtime. TUI and
Headless receive the same projection through the Agent stream. This is the chosen
approach.

## Public Contract

Add a strict TypeBox schema in `src/api/turnActivitySchemas.ts`:

~~~ts
interface TurnActivityProjectionV1 {
  version: 1;
  generation: string;
  revision: number;
  snapshot: TurnActivitySnapshotV1 | null;
}

interface TurnActivitySnapshotV1 {
  phase:
    | 'starting'
    | 'thinking'
    | 'responding'
    | 'executing_tools'
    | 'compacting'
    | 'continuing';
  startedAt: number;
  updatedAt: number;
  turn: number;
  maxTurns: number | null;
  outputStarted: boolean;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  activeTools: TurnActivityToolV1[];
  activeToolOverflow: number;
}

interface TurnActivityToolV1 {
  name: string;
  kind?: 'readonly' | 'write' | 'execute';
  startedAt: number;
  progress?: number;
  total?: number;
}
~~~

The envelope makes a clear observable. `generation` is an opaque runtime token and
`revision` is monotonic within that generation. `maxTurns=-1` is normalized to
`null`, meaning unlimited or not meaningfully bounded. Counters and timestamps use
explicit finite integer bounds. Tool names are normalized by removing control
characters, trimming, and truncating to 128 UTF-16 code units.

`activeTools` contains at most eight entries in start order. Parallel calls with the
same name remain separate internally, but the public projection contains no
Provider-issued tool-call ID. `activeToolOverflow` reports additional active calls.
Tool progress is included only when both values are finite, non-negative, and
`progress <= total`; arbitrary progress text is intentionally excluded.

The snapshot is immutable from a consumer's perspective. TypeBox objects use
`additionalProperties: false`, and every surface validates external or reconnect
payloads before accepting them.

## Runtime State Machine

Add `TurnActivityState` beside `ProviderRecoveryState`. It owns only in-memory state
and a pure, testable reducer. `Agent.chatStream()` begins one activity generation for
each top-level Session run and requires the returned generation token for every
later observation or clear. Starting a new generation invalidates the previous token
before publishing revision zero.

Initial state is `starting`, with zero counters and no active tools. Events reduce as
follows:

- `turn_start` -> `thinking`, update `turn` and normalized `maxTurns`;
- non-empty `thinking_delta` -> `thinking`, `outputStarted=true`;
- non-empty `content_delta` or `structured_output` -> `responding`,
  `outputStarted=true`;
- `tool_start` -> add the call, increment `toolCallsStarted`, and use
  `executing_tools`;
- `tool_progress` -> update numeric progress for the matching active call without
  storing its message;
- `tool_result` -> remove the matching call, increment `toolCallsCompleted`, and
  remain `executing_tools` while any call is active, otherwise use `continuing`;
- compaction start -> `compacting`; compaction end -> `thinking`;
- `follow_up_started` or `goal_continuation_started` -> `continuing`;
- other events do not mutate the activity snapshot.

Structured-output tool calls are excluded, matching existing surface behavior. Task
list tools are still counted as work even when the TUI does not render duplicate
transcript cards. An unknown or duplicate `tool_result` is ignored rather than
corrupting counters. A duplicate update that produces no semantic change does not
advance the revision.

Each accepted update records `updatedAt` from the runtime clock. The Runtime
publishes the projection exactly once as `turn.activity`. The direct Agent stream
also yields `turn_activity` for TUI and Headless, but Web and ACP ignore the direct
copy because they already subscribe to the authoritative Bus publication.

`clear(generation)` publishes `snapshot: null`. A stale token cannot update or clear
the current generation. `Agent.chatStream()` clears in success, failure, abort,
generator close, and its final defensive cleanup. `SessionRuntime.dispose()` also
clears any remaining live generation.

## Surface Precedence

The activity projection is the baseline live-turn explanation. Existing specialized
states keep higher priority:

1. pending permission, question, or elicitation;
2. Provider recovery;
3. action-stationarity recovery or halt;
4. turn activity;
5. existing generic loading phrase.

This prevents a generic `executing_tools` label from hiding a user action request or
a bounded Provider wait.

### TUI

Store the validated projection in the Session slice. `LoadingIndicator` renders:

- localized phase text;
- up to two active tool names plus `+N`;
- explicit numeric progress when present;
- `turn/maxTurns` when the maximum is bounded;
- completed/started tool counts;
- elapsed time computed locally from `startedAt`;
- the existing Esc cancellation hint.

The layout remains one line at wide widths and bounded multi-line at narrow widths.
It must never append arbitrary progress messages. The projection is cleared by the
same command/session reset paths that clear Provider recovery.

### Web

Add a compact activity strip directly above the composer and below higher-priority
recovery/interaction bars. It uses semantic status markup, a reduced-motion-safe
indicator, phase text, active tools, turn/tool counters, and local elapsed time. The
existing transcript tool cards remain unchanged. The strip is responsive and does
not force the message list to resize on every timer tick.

The SSE `connected` frame carries `turnActivity`; the client applies it as an
authoritative snapshot before reporting the connection ready. Later
`turn.activity` events are generation/revision fenced. A reconnect with `null`
clears stale client state. Navigation, rewind, archive, and subscription teardown
clear local activity.

### ACP

ACP sends the strict projection under
`session_info_update._meta['blade/turnActivity']`. It sends the current Runtime
snapshot in initial Session updates and subsequent Bus revisions once. No custom ACP
capability or mutation is advertised.

### Headless

JSONL mode emits a closed `turn_activity` event with the same envelope. Human output
prints only meaningful phase transitions, not every numeric progress revision, to
avoid noisy logs. The terminal clear is observable in JSONL and silent in human
output.

## Error, Lifecycle, and Privacy Rules

- Projection failure must not fail the Agent run. Invalid tool names or progress are
  dropped or normalized at the reducer boundary.
- Consumer validation failure keeps the last valid generation; an authoritative
  reconnect payload of `null` clears it.
- No timer is owned by Runtime. TUI and Web derive elapsed display locally, so the
  projection does not publish periodic heartbeats or create background lifecycle
  work.
- No raw text from tool arguments, outputs, progress messages, prompts, errors,
  model responses, environment, cwd, URLs, headers, or credentials enters the
  snapshot.
- Runtime replacement cannot transfer an active projection. The old owner clears on
  disposal; the new owner starts a fresh generation if it owns a new turn.
- Bus listeners, SSE writers, and ACP egress retain their existing bounded queues
  and shutdown semantics.

## Testing Strategy

### Deterministic tests

- schema bounds, strict objects, invalid names, invalid counters/timestamps, and
  null clears;
- pure reducer transitions, parallel tools, overflow, duplicate progress/result,
  structured-output exclusion, semantic no-op revisions, and stale generation
  update/clear rejection;
- Agent success, failure, abort, and generator-return cleanup;
- TUI store and presentation precedence, narrow/wide bounded rendering, elapsed
  display, and reset paths;
- Web event fencing, reconnect hydration/clear, navigation cleanup, accessibility,
  and reduced-motion rendering;
- ACP initial/live metadata and no duplicate direct-stream projection;
- Headless closed JSONL schema and bounded human output.

### Production-surface qualification

- Raw PTY TUI: observe thinking -> tool -> responding with elapsed time, then terminal
  clear and Esc cleanup.
- Production Chromium Web: observe the activity strip, reload while a tool is
  active, verify authoritative hydration, then terminal clear with no console errors.
- Real ACP stdio: observe initial/live `blade/turnActivity` revisions and terminal
  null.
- Headless JSONL: validate the same generation/revision sequence.
- Run the bounded trajectories with `deepseek-v4-flash` and
  `deepseek-v4-pro`, framework retry `0`, model `maxRetries=0`, and explicit
  request-count evidence.

Qualification artifacts must record candidate/tag SHAs, commands, model identity,
request counts, lifecycle cleanup, and credential scans without storing credentials.

## Release

Ship as one patch release after focused tests, CLI/Web type-check, lint, full build,
full deterministic suite, performance gates, separate coverage gates, production
GUI/PTY/ACP/Headless qualification, documentation, and a prompt-to-artifact audit
all pass.
