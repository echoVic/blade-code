# Durable Token-Budget Handoff Design

**Date:** 2026-08-19
**Target:** `blade-code@0.10.65`
**Status:** Written specification ready for user review
**Capability:** Durable token-budget handoff for long-running coding turns

## Decision summary

Blade will add a two-stage context-budget boundary without moving its existing
automatic-compaction safety limit:

1. when authoritative Provider usage first reaches 70% of the input budget, the
   runtime durably appends one hidden handoff reminder to the current model
   context;
2. when usage reaches 80%, the existing automatic compaction path still runs
   before another task-model request.

The reminder rides the next request that the Agent loop was already going to
make. It does not create a standalone Provider request, does not change the root
system prompt, and does not appear in CLI, Web, ACP, or resumed user history. Its
durable authority is one dedicated internal Session event rather than a normal
`message_created`/`part_created` pair. A successful or fallback full compaction
supersedes the reminder and begins a new handoff epoch. A direct jump to the
compaction threshold skips the reminder and compacts immediately.

The same patch will strengthen the compaction summary contract with a bounded
continuation ledger so a direct threshold jump still preserves the active
objective, decisions, mutations, verification evidence, outstanding work, and
exact next action.

## Problem

Blade currently reserves the configured output budget and triggers LLM
compaction when the last authoritative prompt usage reaches 80% of the remaining
input capacity. This prevents context-window overflow, and the post-compaction
active-task message preserves the user's original request. It does not give the
task model advance notice that a context rollover is approaching.

For a long coding task, some of the most useful continuation state can still be
implicit at that boundary:

- why the current approach was selected over alternatives;
- which repository mutations are complete and which are only planned;
- which verification commands ran, what failed, and what still needs rerunning;
- which background tasks or subagents are still relevant;
- the single next action that should advance the task.

The compaction model can reconstruct only what the transcript makes explicit. A
generic chronological summary can preserve a large amount of text while still
under-specifying the execution frontier. If the process crashes just before
compaction, a process-local reminder flag would also be lost and could cause
duplicate control messages after resume.

This is a long-task progression gap, not a request to increase the model's
context window or delay compaction beyond the current safe limit.

## Reference findings

The local Codex implementation separates context-window accounting from a
one-shot token-budget reminder:

- `/Users/bytedance/Documents/GitHub/codex/codex-rs/core/src/session/token_budget.rs`
  claims a reminder once and records it as model-visible context;
- `/Users/bytedance/Documents/GitHub/codex/codex-rs/core/src/session/context_window.rs`
  distinguishes remaining base-window tokens from the hard context limit;
- `/Users/bytedance/Documents/GitHub/codex/codex-rs/features/src/feature_configs.rs`
  defines bounded reminder and fallback prompt fields.

Blade already has the necessary durable primitives:

- `packages/cli/src/agent/loop/executeLoopGenerator.ts` owns the pre-request
  compaction check and authoritative Provider usage;
- `packages/cli/src/agent/loop/conversationPersistence.ts` can commit hidden
  model-visible control messages before they enter the in-memory conversation;
- `packages/cli/src/context/compactionCheckpoint.ts` and
  `packages/cli/src/services/SessionService.ts` restore an authoritative
  replacement context after a compaction checkpoint;
- `packages/cli/src/services/clientMessageVisibility.ts` already provides the
  cross-surface `clientVisible: false` contract.

Blade will adopt the useful reminder semantics, not Codex's configurable
post-threshold expansion. Version 0.10.65 keeps Blade's current output reserve
and 80% automatic-compaction boundary unchanged.

## Goals

1. Give the task model one normal turn of advance context when a long task enters
   the 70%-to-80% handoff band.
2. Commit the reminder before exposing it to the model so crash recovery cannot
   duplicate an already-issued handoff.
3. Keep the reminder internal across Headless, raw PTY TUI, Web, ACP, session
   reload, and session export.
4. Preserve the current immediate-compaction behavior at and above 80%.
5. Improve continuation quality even when usage jumps directly past the reminder
   band.
6. Add no unbounded maps, timers, retained prompt content, or per-session global
   state.
7. Prove the behavior with deterministic tests and real DeepSeek Flash/Pro
   trajectories across all production surfaces.

## Non-goals

- Increasing a Provider's context window or borrowing tokens past Blade's current
  automatic-compaction boundary.
- Adding a new checkpoint tool or requiring the model to create a repository
  file solely for runtime bookkeeping.
- Exposing thresholds as user configuration in the first release.
- Displaying a new status card, toast, terminal line, or ACP update.
- Replacing reactive `prompt_too_long` recovery, snip compaction, micro-compaction,
  or the existing active-task checkpoint.
- Solving unrelated follow-ups such as `SessionEventLog` residency, raw-spawn
  architecture enforcement, multi-task `TaskOutput`, or a no-key Web GUI CI job.

## Budget model

The calculation uses the same values and authoritative usage source as the
existing automatic-compaction check:

```text
availableForInput = maxContextTokens - maxOutputTokens
handoffThreshold = floor(availableForInput * 0.70)
compactionThreshold = floor(availableForInput * 0.80)
```

`actualPromptTokens` is the most recent completed normal Provider request's
reported prompt usage. It is authoritative for that request but necessarily lags
new tool results and control messages appended afterward. Estimated message counts
do not issue a durable handoff. If the unseen tail causes the next request to
exceed the Provider limit, the existing reactive `prompt_too_long` path remains
the safety net. If the context window is unknown, the output reserve is invalid,
or authoritative usage is unavailable, the feature makes no change and the
current runtime behavior continues.

The resulting phase is one of:

| Phase | Condition | Runtime action |
|---|---|---|
| `unknown` | budget or usage is not trustworthy | no handoff; preserve current behavior |
| `below_handoff` | usage is below 70% | no handoff |
| `handoff_band` | usage is at least 70% and below 80% | attempt one durable hidden reminder |
| `compaction_due` | usage is at least 80% | skip a new reminder and compact immediately |

The 10-point band is a soft operational buffer. It does not authorize an extra
request after the runtime observes `compaction_due`.

## Handoff epoch and authority

A **handoff epoch** is the current model context after the latest successfully
persisted full-compaction checkpoint, or the entire Session when no such
checkpoint exists. Snip and micro-compaction do not begin a new epoch. Model
switches do not begin a new epoch.

The dedicated durable event is the authority for whether the current epoch has
already received a reminder. Process-local state is only an optimization for a
failed persistence attempt. On startup or Session resume, the model-context
projection turns the latest unsuperseded event into one hidden user message.

The event payload is versioned and bounded:

```ts
interface TokenBudgetHandoffRecordedV1 {
  version: 1;
  messageId: string;
  observedPromptTokens: number;
  availableForInput: number;
  handoffThreshold: number;
  compactionThreshold: number;
  createdAt: string;
}
```

The payload contains opaque identity, budget counts, and a timestamp only.
It does not retain the reminder text, user text, file paths, tool names,
credentials, reasoning, or Provider response content. The v1 renderer reconstructs
the static hidden message from the numeric payload. A valid supported version is
projected deterministically on cold resume. An event with an unsupported version
or invalid payload is not projected, emits only a bounded warning, and suppresses
another handoff append until the next valid full-compaction checkpoint. This
fail-closed downgrade behavior prevents duplicate marker records.

`PersistentStore.recordTokenBudgetHandoff()` uses the existing validated JSONL
append boundary. Under the per-file write queue it scans only the current epoch:
events after the latest summary part whose versioned replacement context parses
successfully. A persisted reactive-snip replacement is such a boundary; standalone
micro- or snip-compaction without a durable replacement is not. It appends one
`token_budget_handoff_recorded` event when none exists, or returns the existing
event without appending. The returned result distinguishes `created` from
`existing` and always provides the authoritative message identity.

Its concrete contract is:

```ts
interface RecordedTokenBudgetHandoff {
  outcome: 'created' | 'existing';
  event: TokenBudgetHandoffRecordedEvent;
}

interface SuppressedTokenBudgetHandoff {
  outcome: 'suppressed';
  recordId: string;
}

recordTokenBudgetHandoff(
  sessionId: string,
  payload: Omit<TokenBudgetHandoffRecordedV1, 'messageId' | 'createdAt'>
): Promise<RecordedTokenBudgetHandoff | SuppressedTokenBudgetHandoff>;
```

The implementation uses `SessionEventLog.commitValidatedBatch()`. Its validation
callback captures and returns the existing epoch event with an empty append batch,
or returns one new event. Therefore an `existing` result is never restamped,
re-appended, or fanned out. The method generates `messageId` and `createdAt` only
for the winning new event. A malformed or unsupported existing record returns
`suppressed` with only its bounded durable event ID; it neither invents a message
identity nor projects a model message.

Every active Agent loop already holds the cross-process `SessionLease`; this is
the required single-writer boundary across Headless, Web, and ACP. Validated
append closes same-process check/commit races, while the lease prevents two
processes from independently entering that boundary for one Session. Tests must
prove both assumptions. Session fork uses a new Session ID and therefore starts a
new handoff epoch. `SessionService.forkSession()` copies the effective committed
conversation and full-compaction checkpoints but explicitly omits
`token_budget_handoff_recorded`; the child may issue its own marker when its own
Provider usage enters the handoff band.

Session rewind follows the same authoritative projection as other conversation
events. A `conversation` or `both` rewind removes handoff events at or after the
target user checkpoint, while a `code`-only rewind leaves conversation events,
including the current handoff authority, unchanged. Epoch scans run over
`materializeSessionEvents()` output so a rewound-away marker cannot suppress a new
one.

## Handoff prompt contract

The reminder is a bounded static runtime control message. Dynamic interpolation
is limited to
`max(0, compactionThreshold - observedPromptTokens)`, labeled as the approximate
tokens remaining before automatic compaction because unseen tail messages are not
included. Its instructions must:

- say that context rollover is approaching, not that the task is complete;
- tell the model to continue the user's task rather than stop for a status-only
  answer;
- ask it to make the execution frontier explicit through the normal next tool or
  response: objective and constraints, decisions, completed and pending
  mutations, verification evidence, active background work, blockers, and one
  exact next action;
- prefer existing durable Task, Goal, Session, and workspace artifacts when they
  already belong to the task;
- forbid inventing successful verification, marking unfinished work complete, or
  creating a bookkeeping file that the user did not request;
- remain below 2,000 UTF-8 bytes.

The message is appended at the mutable tail of the conversation. It never changes
the stable root system prompt or tool schema, limiting prompt-cache disruption to
one expected tail insertion per handoff epoch.

The projected message has this exact identity metadata:

```ts
{
  id: event.data.messageId,
  role: 'user',
  content: renderTokenBudgetHandoff(event.data),
  metadata: {
    clientVisible: false,
    tokenBudgetHandoff: {
      version: 1,
      messageId: event.data.messageId
    }
  }
}
```

`isTokenBudgetHandoffMessage()` accepts only this bounded shape with matching
outer and metadata identities. User-authored text that resembles the reminder is
never classified as an internal marker.

`ChatServiceInterface.Message` gains `id?: string` so this already-used durable
identity is represented without casts. `createPiContext()` continues to build a
fresh pi-ai context from role, content, reasoning, and tool protocol fields only;
it does not forward `id` or Blade metadata as Provider message fields.

## Component boundaries

### `TokenBudgetHandoff.ts`

A new focused module at `packages/cli/src/context/TokenBudgetHandoff.ts` owns pure
policy:

- derive the budget snapshot and phase;
- build and validate the v1 event payload;
- recognize authoritative handoff events and projected messages;
- render the bounded hidden control message from a v1 event;
- remove marker messages from full-compaction inputs and replacements.

The public pure API required by compaction is:

```ts
function isTokenBudgetHandoffMessage(message: Message): boolean;
function stripTokenBudgetHandoffMessages(
  messages: readonly Message[]
): Message[];
```

`stripTokenBudgetHandoffMessages()` returns a new array in original order, removes
only valid projected handoff messages, and never mutates the source `Message`
objects or `ConversationState`. `CompactionService.compact()` invokes it at its
entry boundary before file analysis, prompt construction, retain-tail selection,
or fallback construction. Reactive and turn-limit paths receive the filtered
`CompactionService` result; reactive snip also filters before its snip-only
fallback. Manual `/compact` passes its `Message[]` through the same service
boundary.

The cold-recovery integration is an explicit extension of
`SessionService.convertJSONLToModelContext()`. After selecting the latest valid
replacement checkpoint, its suffix fold recognizes
`token_budget_handoff_recorded` and calls
`projectTokenBudgetHandoffEvent(event)` from this module at the event's original
stream position. That pure function returns one hidden `role: 'user'` `Message`
with `id === event.data.messageId`, or `undefined` for an invalid/unsupported
payload. `convertJSONLToMessages()`, UI projections, exports, and SQLite read
models continue to ignore the internal event.

It does not perform persistence, call a Provider, mutate `ConversationState`, or
know about CLI/Web/ACP. Both the Agent loop and `CompactionService` may depend on
this context-layer policy; the context layer never imports the Agent loop. The
existing compaction check consumes the same budget snapshot so the 70% and 80%
decisions cannot drift.

### Agent-loop integration

Immediately before the existing full-compaction decision and next task-model
request, the loop performs this order:

1. drain durable/runtime control changes as it does today;
2. call the existing `ConversationState.writeback()`. This commits its pending
   assistant, tool-result, user-control, and MCP-control messages to `history` and
   writes that authoritative history into `context.messages`;
3. derive one shared budget snapshot;
4. if `compaction_due`, run existing compaction without issuing a reminder;
5. if `handoff_band` and a projected marker is already present, continue normally;
6. if `handoff_band` and no marker is present, call the best-effort validated
   `recordTokenBudgetHandoff()` storage API;
7. only after storage returns a newly created or existing authoritative event,
   project it to the hidden user message and append it if that identity is not
   already in `ConversationState`;
8. if storage returns `suppressed`, append nothing and continue;
9. continue to the already-planned Provider request. The internal event never
   becomes `lastMessageUuid`, because it is not part of the public parent-message
   chain.

This is persist-before-observe. A crash after the commit but before the in-memory
append is safe because resume reloads the committed marker. A crash after append
but before the Provider request is also safe for the same reason.

### Persistence failure

The reminder is advisory, so failure to persist it must not fail an otherwise
valid coding turn. The dedicated storage call is invoked in explicit best-effort
mode. The loop writes one `logger.warn` entry in the internal Agent log, capped at
512 UTF-8 bytes and composed only from a fixed event name, Session ID digest, and
normalized error class/code. It does not emit a LoopEvent or surface message. The
loop does not append the uncommitted reminder
to model context, and marks the persistence attempt as spent for the current
`executeLoopGenerator` invocation. It continues with the existing request and
compaction behavior.

The invocation-local attempt flag prevents repeated failing disk writes on every
loop iteration. A later user turn or fresh process may retry because the external
storage failure may have cleared. No Provider credential, prompt body, or user
content is written to the warning.

### Full-compaction integration

Every full-compaction path must remove the control marker before it builds a
summary, chooses retained messages, constructs fallback messages, or serializes a
replacement context:

- threshold-triggered LLM compaction;
- reactive `prompt_too_long` compaction;
- turn-limit compaction;
- manual `/compact`;
- deterministic fallback compaction.

The marker is an instruction, not task evidence. The model activity that followed
the marker remains eligible for summarization. Compaction works on a copy with the
projected marker removed; it does not delete or rewrite the append-only transcript.
On a successfully persisted LLM, fallback, or reactive-snip checkpoint, the newer
summary event supersedes the earlier handoff event, and its replacement context
contains no projected marker. Resume therefore begins a new epoch naturally.

If compaction aborts, throws, or fails before its checkpoint is durable, the old
context and marker remain authoritative. The runtime must not issue a duplicate.
The existing post-compaction cooldown no longer authorizes another normal Provider
request after the shared budget phase reaches `compaction_due`; direct and repeated
80% crossings compact before the next task-model request. Hysteresis may still
avoid optional work below that boundary, but cannot override the hard 80% phase.

## Continuation-ledger summary contract

The compaction prompt will replace its generic continuation sections with a
bounded, execution-oriented ledger. The summary must contain these headings when
the source transcript provides relevant evidence:

1. `Objective and constraints`
2. `Decisions and rationale`
3. `Workspace mutations`
4. `Verification evidence`
5. `Active tasks and background work`
6. `Open risks or blockers`
7. `Exact next action`

The summary must distinguish observed facts from intended work, preserve exact
commands and literals when necessary for continuation, and never convert a plan
into a completed mutation. It must not copy credentials, hidden control-message
text, raw reasoning, or unrelated historical detail. The existing active-task and
recent-file restoration messages remain separate safeguards after the summary.

The fallback path cannot ask an LLM for this ledger. It retains the current bounded
tail plus the active-task checkpoint, strips the marker, and explicitly states
that verification and pending work must be re-established from retained evidence.

## Surface behavior

The capability is runtime-internal and has identical semantics on every surface:

| Surface | Required behavior |
|---|---|
| Headless JSONL | normal tool/final events continue; the raw transcript owns one numeric internal record, but stdout emits no handoff text or metadata |
| raw PTY TUI | no extra rendered user bubble or terminal status line; task continues normally |
| production Web | no marker in HTTP history, SSE, Zustand state, or DOM before or after reload |
| ACP | no marker in `session/update`, `session/load`, or terminal output |
| Session export | no marker text or metadata in the portable user-facing export |

The runtime commits exactly one marker message identity during an epoch. Until a
full compaction replaces the context, that same historical message is naturally
present once in each subsequent Provider request; the loop must not append another
copy. Surface filtering does not remove it from model context.

`SessionEventLog` treats `token_budget_handoff_recorded` as a non-fan-out internal
event: commit still assigns and persists its monotonic `seq`, but live Bus
publication and direct replay subscribers do not receive it. This server-side rule
prevents the payload from reaching global/session SSE, Web state, or any future
surface that consumes the shared event stream. A sequence gap is legal; the next
visible committed event advances the client's durable cursor. Model-context load
reads the raw transcript directly and is the only projection that materializes the
hidden message.

The suppression is implemented in both delivery paths: `record()` updates
`highestSeq` and then returns before subscriber/Bus publication; `replay()` skips
the internal event before invoking `subscriber.onCommitted`. No caller must infer
privacy by joining a preceding `message_created` event, because the dedicated event
contains no reminder text and has no companion part.

## Security, privacy, and performance

- The reminder contains no user-controlled interpolation other than bounded
  integer counts.
- Model-context projection marks the reconstructed message
  `clientVisible: false` as defense in depth, while the internal event's
  non-fan-out rule is the primary live-surface boundary.
- It adds at most one durable internal-event commit and one sub-2,000-byte
  projected context item per full-compaction epoch.
- It adds no Provider request, interval, timeout, singleton, or process-wide
  collection.
- It does not weaken output-token reservation, permission checks, workspace
  sandboxing, Goal verification, or tool admission.
- It remains at the conversation tail and does not churn the cached system/tool
  prefix.

## Deterministic test strategy

### Pure policy tests

Add focused tests for:

- invalid/unknown budget inputs;
- exact boundaries immediately below, at, and above 70% and 80%;
- integer rounding and very small valid windows;
- v1 event validation plus fail-closed future/malformed payload handling;
- bounded rendering with no user-controlled content;
- marker removal without removing adjacent real user messages.

### Agent-loop tests

Prove:

- below 70%, no persistence or context mutation occurs;
- in the handoff band, the JSONL commit completes before the marker reaches the
  next chat request;
- an existing restored marker suppresses another commit;
- multiple consecutive requests that remain in the handoff band reuse the same
  durable message identity and contain at most one marker occurrence per request;
- a persistence failure sends no uncommitted marker and does not fail the turn;
- the in-memory failure flag prevents repeated writes in one process;
- usage at or above 80% compacts before another task-model request;
- a Provider pre-stream retry reuses the same marker rather than committing a
  second one;
- a model switch within the same epoch does not duplicate the reminder.
- a Session fork retains the effective task context but omits the parent marker,
  while the child can commit a distinct identity in its own epoch.

### Persistence and compaction tests

Prove with real temporary JSONL storage that:

- a process-style reload restores the hidden marker into model context;
- two same-process `PersistentStore` facades race the real validated append against
  one temporary JSONL transcript; both return one shared identity and the file
  contains one event. This test exercises the per-file write queue below the
  Runtime lease and does not replace or mock storage;
- unsupported-version and malformed events suppress duplicate appends without
  entering model or surface projections;
- while one real child process holds a Session lease, a second real child calling
  `SessionLease.acquire()` fails with `SessionInUseError` and
  `code === 'BLADE_SESSION_IN_USE'`; after the owner releases or exits, a new child
  can acquire it;
- UI-safe and Web projections omit it;
- a counting `Bus.subscribe()` observer and a counting
  `SessionEventLog.subscribe({fromSeq})` replay observer both see the visible
  events surrounding the internal record, preserve increasing visible sequence
  numbers, and record zero internal events or synthetic text parts;
- real loopback global SSE and Session SSE clients record the same surrounding
  visible events and zero JSON payloads containing the internal event name, marker
  identity, or reminder text;
- a full checkpoint replacement removes it on cold reload;
- conversation/both rewind before a marker removes its authority, while code-only
  rewind preserves it;
- aborted or non-durable compaction keeps it;
- LLM, reactive, turn-limit, manual, and fallback replacements contain no marker;
- the compaction prompt contains the complete seven-heading contract;
- a real DeepSeek Flash/Pro compaction fixture places three high-entropy ASCII
  sentinels, explicitly marked `preserve exactly`, around one proven mutation, one
  failed verification, and one pending action in the source transcript. A bounded
  Markdown-section parser normalizes heading level, case, surrounding whitespace,
  and optional list punctuation; it does not fuzzy-match or rewrite sentinel
  content. The persisted summary must contain each exact sentinel substring in the
  correct logical ledger section and must not place the pending sentinel in a
  completed-mutation clause or the failed-verification sentinel in a passing
  clause. This cell uses framework retry 0. Missing or rewritten sentinels are real
  qualification failures, not candidates for an automatic rerun;

No integration test may replace the real persistence layer with a partial object
or use `as any` to bypass the production message contracts.

## Real API qualification

A transparent local proxy will forward requests to the real DeepSeek endpoint and
control only the returned usage counters needed to enter each budget phase. The
task responses and compaction summary remain real Provider outputs. The proxy
records bounded structural evidence and never logs API keys or full prompt bodies.

Each trajectory performs a sequential coding task that cannot finish in one model
step:

1. inspect the fixture repository;
2. enter the handoff band from real Provider response 1;
3. verify normal request 2 contains one hidden marker occurrence backed by one
   durable marker message identity and advances the implementation;
4. report `compaction_due` usage after request 2;
5. verify full compaction runs before normal request 3;
6. verify request 3 receives the continuation ledger without the marker, completes
   the remaining edit/command, and produces the exact expected final state;
7. reload or resume the same Session and prove the marker remains absent while the
   completed task is intact.

The release-blocking matrix is:

| Provider | Headless | raw PTY TUI | production Chromium Web | real ACP SDK |
|---|---:|---:|---:|---:|
| DeepSeek Flash | required | required | required | required |
| DeepSeek Pro | required | required | required | required |

The Web cells use real browser locators, reload the page during the trajectory,
and fail on `pageerror`, unexpected error console output, or failed same-origin
requests. Before application code runs, the Playwright driver installs a bounded
wrapper around the browser's native `EventSource` that records parsed message
payloads without changing delivery. After the run and reload, the test reads that
page-owned evidence buffer and asserts zero marker event names, identities, or
text. It separately fetches the production HTTP message endpoint and inspects the
rendered DOM; Web unit tests fold the same committed stream through the real
Zustand event handlers and assert no hidden message enters store state. No
production debug endpoint or global store exposure is added. The TUI cells use a
real pseudo-terminal because PTY byte streams and
durable transcript markers are authoritative for terminal behavior. Desktop
computer-use is not the authority for this patch; it would add visual timing
ambiguity without proving the JSONL or Provider-request contract. If a stable
host computer-use harness becomes available, it may be added as a non-blocking
observation only.

The new trajectory enters `realApiQualification.files` with framework retry 0.
Existing production qualification continues to cover the configured Claude and
GPT baseline capabilities; this feature-specific matrix uses both required
DeepSeek models.

## Documentation and release gates

Implementation updates must include:

- `CHANGELOG.md` for `0.10.65`;
- `docs/testing/qualification.md` with the new release-blocking trajectory;
- `docs/testing/durable-token-budget-handoff-evidence.md` containing commands,
  matrix cells, durations, request-count assertions, artifact hashes, and any
  intermittent failure disclosure;
- package version and lockfile updates required by the repository release process.

Required gates, in order:

```bash
bun run --filter blade-code type-check
bun run --filter blade-code test:unit
bun run build
bun run test:all
bun run qualify:local
bun run --filter blade-code browser:check
bun run qualify:production
```

Targeted tests run earlier during TDD, but they do not replace the complete gates.
Credentials come only from the approved restricted credential file or injected
environment; commands and evidence record variable names and model IDs, never
secret values.

After every gate passes against the exact release commit, create and push
`v0.10.65`, wait for `publish.yml`, and verify the published npm version.

## Completion criteria

`blade-code@0.10.65` is complete only when all of the following are evidenced:

1. the 70% and 80% decisions share one budget calculator and the same most-recent
   completed-request usage source;
2. the marker is committed before model observation and is issued at most once per
   handoff epoch across crash/resume;
3. a marker persistence failure neither leaks an uncommitted prompt nor stops the
   coding turn;
4. direct jumps to 80% compact without another task-model request;
5. every full-compaction path removes the marker and produces a recoverable
   continuation context;
6. CLI, Web, ACP, exports, live/replayed event streams, and user-facing reloads
   never expose the internal marker event, metadata, or rendered text;
7. all eight DeepSeek Flash/Pro surface cells finish the real coding task with
   exactly one durable pre-compaction marker identity, at most one occurrence in
   each pre-compaction request, and none afterward;
8. deterministic suites, full local gates, production qualification, release
   workflow, and npm publication all pass for the same commit;
9. the evidence report identifies what was directly proven and describes any
   intermittent failures in unchanged sources without treating reruns as proof of
   irrelevance.

## Deferred independent patches

The next audited candidates remain separate so this release keeps one behavioral
responsibility:

1. bounded `SessionEventLog` residency and release ownership;
2. a raw-spawn architecture contract and gradual process-owner consolidation;
3. a deterministic no-key production Web GUI smoke job in CI;
4. multi-ID `TaskOutput` aggregation;
5. native fatal-crash reporting and terminal restoration.
