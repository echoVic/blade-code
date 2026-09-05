# Reliable Compaction Memory Consolidation Design

**Date:** 2026-09-06
**Target:** `blade-code@0.10.140`
**Status:** Written specification ready for user review
**Capability:** Safe, durable project-memory consolidation at full-compaction boundaries

## Decision summary

Blade will harden its existing rule-based memory consolidation without adding a
second Provider request. A full compaction will derive a bounded plan containing
only reusable project knowledge from messages that leave the active context. The
runtime will commit the compaction checkpoint first, then await a best-effort,
workspace-scoped memory commit before applying the in-memory replacement.

The implementation will cover successful LLM compaction and deterministic
fallback across threshold, reactive context-limit, turn-limit, and manual
compaction paths. Micro-compaction, ordinary snipping, and reactive snip-only
recovery remain outside the feature because they do not establish a full
compaction boundary.

The patch will not introduce an independent semantic memory-flush model call. It
will first make the current no-extra-call path correct, private, discoverable,
and observable. A later patch may add semantic pre-compaction extraction on top
of this storage and lifecycle foundation.

## Problem

Blade already has three distinct continuity mechanisms:

- compaction summaries and exact continuation records preserve the active task;
- durable token-budget handoff prepares the model for an approaching rollover;
- Auto Memory persists project knowledge for later Sessions.

The third mechanism is currently weaker than its documentation implies.
`CompactionService.compact()` calls `consolidateAfterCompaction()` only after a
successful LLM summary and does so without awaiting it. The consolidation code
uses ambient `getCwd()` rather than the Session workspace, bypasses the sensitive
content checks used by `MemoryWrite`, writes topic files through non-atomic
read-modify-write operations, does not deduplicate entries, and does not add new
topics to `MEMORY.md`. Consequently, a quick process exit can lose a write,
fallback compaction saves nothing, concurrent surfaces can overwrite each other,
remote or alternate workspaces can be misattributed, and automatically written
knowledge is usually invisible to the next Session.

This is a persistence and runtime-ordering gap. It is not a request to duplicate
the active-task ledger in long-term memory or to store complete transcripts.

## Reference findings

The local reference implementations separate current-task continuation from
long-term memory:

- Grok Build has a dedicated memory-flush policy, captures a conversation
  snapshot before compaction, guards one flush per compaction cycle, serializes
  concurrent flushes, suppresses recursive auto-compaction, applies response
  quality limits, and treats flush failure as non-fatal.
- Codex invokes pre-compaction hooks at its local, remote, and token-budget
  compaction boundaries, demonstrating that compaction-wide side effects belong
  at a shared boundary rather than in one caller.
- Claude Code coordinates snip, micro-compaction, proactive compaction, reactive
  recovery, and post-compact attachments while keeping their responsibilities
  distinct.
- Neovate Code's structured compaction summary preserves the active task,
  decisions, errors, and plan for the next context window. That is continuation
  state rather than automatically promoted long-term project memory.

Blade will adopt the useful lifecycle and isolation properties without adopting
Grok Build's extra Provider call in this patch.

## Goals

1. Persist reusable project knowledge from every committed full compaction,
   including deterministic fallback.
2. Never persist memory for a compaction that is aborted, blocked, or fails to
   commit its durable replacement checkpoint.
3. Attribute every automatic write to the explicit active workspace and disable
   local writes for ACP remote workspaces.
4. Apply one shared sensitive-content policy to explicit `MemoryWrite` calls and
   automatic consolidation.
5. Prevent same-process and cross-process lost updates, use atomic file
   replacement, and make retries idempotent through exact normalized deduplication.
6. Keep automatically created topic files discoverable through `MEMORY.md`
   without unbounded index growth.
7. Expose bounded, content-free consolidation results consistently through TUI,
   Web, ACP, and Headless surfaces.
8. Qualify the behavior with deterministic production-build tests and real
   DeepSeek Flash/Pro trajectories, including Chromium Web and raw PTY TUI.

## Non-goals

- A standalone LLM call for semantic memory extraction.
- Idle-time, session-end, or periodic memory flushes.
- Vector embeddings, semantic deduplication, or memory ranking.
- Persisting active task progress, pending work, temporary status, full tool
  output, reasoning, images, or the complete transcript.
- Changing the existing 70% durable handoff or 80% compaction thresholds.
- Treating micro-compaction or snip-only recovery as a full-compaction boundary.
- Adding a Web memory editor or replacing the existing `/memory` command.
- Allowing memory failure to fail or roll back a committed compaction.

## Knowledge eligibility and bounds

The planner receives only messages that the selected full-compaction replacement
no longer retains verbatim. It never receives post-compaction restoration
messages or newly generated continuation checkpoints.

Eligible knowledge is intentionally conservative:

- a user-authored explicit marker such as `remember:`, `记住：`, `convention:`,
  `约定：`, `lesson:`, or `教训：`;
- an assistant-authored explicit resolved-problem marker such as `fixed:` or
  `修复：`, subject to the existing useful-length bounds.

Raw tool failures are not eligible. A failure alone is historical evidence, not
a reusable solution, and tool output is the most likely source of large or
sensitive payloads. Message reasoning, images, tool-call arguments, metadata, and
non-text content are never inspected.

Each candidate is normalized by trimming it and collapsing horizontal whitespace.
Empty entries are discarded. A single entry is capped at 500 Unicode code points,
one plan contains at most 20 entries, and the combined accepted content is capped
at 8,000 Unicode code points. The planner preserves source order and removes exact
duplicates using the same normalized text used by storage. These constants are
exported for direct unit testing.

## Shared sensitive-content policy

A focused `MemorySafety.ts` module owns pure validation used by both explicit
`MemoryWrite` and automatic consolidation. The policy rejects an entire candidate
when it contains any of the following:

- credential labels such as `password`, `token`, `secret`, `api_key`, or
  `private_key` followed by `:` or `=`;
- bearer credentials;
- common API-key forms including `sk-` values;
- PEM private-key headers;
- known cloud access-key forms already recognized by Blade's export redaction.

The validator returns a stable reason code only. It must not return the matched
substring or serialize candidate content into logs, events, or errors. Explicit
`MemoryWrite` retains its current fail-closed behavior. Automatic consolidation
rejects only the unsafe candidate, records an aggregate rejected count, and
continues with other safe candidates.

This filter is defense in depth, not a claim that arbitrary secrets can be
recognized perfectly. Conservative extraction and the prohibition on raw tool
output remain the primary boundary.

## Component design

### `MemoryConsolidation.ts`

The current extract-and-write function becomes a pure planner plus an explicit
commit operation:

```ts
interface MemoryConsolidationEntry {
  topic: 'preferences' | 'conventions' | 'lessons' | 'debugging';
  content: string;
}

interface MemoryConsolidationPlan {
  entries: readonly MemoryConsolidationEntry[];
  rejectedSensitive: number;
}

type MemoryConsolidationOutcome =
  | { outcome: 'written'; entries: number; topics: string[] }
  | { outcome: 'nothing_to_store'; entries: 0; topics: [] }
  | { outcome: 'disabled'; entries: 0; topics: [] }
  | { outcome: 'failed'; entries: 0; topics: [] };
```

`planMemoryConsolidation(messages)` is deterministic, synchronous, and has no
filesystem or Provider dependencies. `commitMemoryConsolidation(plan, options)`
requires an explicit `workspaceRoot` and accepts `workspaceAccess`. It returns
`disabled` when workspace access is unavailable or `BLADE_AUTO_MEMORY=0`. It
catches storage errors, logs only a bounded error class/code plus counters, and
returns `failed`.

The plan is attached to `CompactionResult` as internal process data. It is never
persisted in the compaction checkpoint and never exposed to clients. Only the
content-free commit outcome may be projected.

### `CompactionService.ts`

`CompactionService.compact()` remains responsible for deriving exactly which
source messages are no longer retained by a full replacement. Both successful
LLM compaction and deterministic fallback return a `memoryPlan`.

For the LLM path, discarded messages are computed against the retained source
prefix, as today. For fallback, the service returns source-position information
from the fallback planner so consolidation includes only fully omitted original
messages. A source message that is retained in truncated form is not promoted to
long-term memory because the replacement still carries part of it and its
semantic status may be ambiguous.

The service no longer performs filesystem writes. This keeps summarization pure
with respect to durable project memory and lets callers respect checkpoint-first
ordering.

### `AutoMemoryManager.ts`

The manager gains one batch operation:

```ts
appendUniqueEntries(
  entriesByTopic: ReadonlyMap<string, readonly string[]>
): Promise<{ written: number; duplicate: number; topics: string[] }>;
```

The operation canonicalizes the project memory directory and serializes by that
path with `KeyedMutexRegistry`. Inside the process lock it acquires a
`proper-lockfile` lock on the initialized memory directory so separate CLI, Web,
and ACP processes cannot lose updates. It then re-reads affected files, performs
exact normalized line-level deduplication, and writes changed files through
`write-file-atomic` with mode `0600`. Lock acquisition uses a bounded retry policy
and always releases in `finally`.

The same transaction ensures an idempotent `## Auto-consolidated topics` section
in `MEMORY.md`. Each fixed topic appears once as a relative Markdown link such as
`- [debugging](debugging.md)`. User-authored text outside that managed section is
preserved byte-for-byte. When no new entry survives deduplication, no file is
rewritten. Existing single-file manager methods remain available to the tools,
but automatic consolidation uses only the batch operation.

## Runtime ordering and coverage

Full-compaction callers use this sequence:

```text
derive replacement and memory plan
  -> durably commit the replacement checkpoint
  -> await best-effort memory commit
  -> apply replacement to in-memory conversation state
  -> emit compaction end
```

The ordering produces these guarantees:

- abort or a blocking hook before a result creates no memory write;
- checkpoint failure creates no memory write and applies no replacement;
- memory failure cannot undo a committed checkpoint and cannot stop the task;
- a retry after an ambiguous memory result is safe because storage deduplicates;
- the completion event describes the memory result before clients leave their
  compaction phase.

Threshold and turn-limit callers apply the sequence directly in
`executeLoopGenerator.ts`. Reactive LLM/fallback recovery applies it after its
checkpoint succeeds. Reactive snip-only recovery produces no plan. Manual
`/compact` commits its checkpoint first, then invokes the same helper. If there
is no Session ID and therefore no durable checkpoint, manual compaction may still
replace the current in-memory context but returns `disabled` for automatic memory
consolidation; this avoids claiming a durable memory side effect without a
durable compaction boundary.

ACP remote workspaces pass `workspaceAccess: 'none'`; their plans are empty and
their outcome is `disabled`, so a remote path never creates local project memory.

## Surface contract

The content-free public result is:

```ts
interface MemoryConsolidationProjection {
  outcome: 'written' | 'nothing_to_store' | 'disabled' | 'failed';
  entries: number;
  topics: string[];
}
```

`entries` is a non-negative safe integer. `topics` contains only fixed enum values
in stable lexical order. The projection contains no memory text, matched secret,
path, Provider response, or error message.

- TUI keeps its existing compaction state. When `outcome === 'written'`, the
  status presentation briefly includes `Saved N project memories`; other outcomes
  remain silent.
- Web keeps the existing turn-activity component and displays the equivalent
  localized completion detail only for `written`. It does not add a modal or a
  persistent transcript message.
- ACP nests the projection under the existing
  `_meta["blade/compaction"].memory` object.
- Headless JSONL includes it as `memory` on the completed `compacting` record.
  Human-readable Headless output prints a short suffix only when entries were
  written.
- Manual `/compact` appends a short result line only when entries were written.

Reloading a Web Session reads the existing compaction checkpoint but does not
re-run its memory commit. Memory status is operational metadata, not an assistant
message and not replayed as a new notification.

## Failure semantics

| Condition | Compaction | Memory outcome | Visible behavior |
|---|---|---|---|
| Caller aborts before result | aborted | absent | existing abort behavior |
| Compaction hook blocks | blocked | absent | existing blocked behavior |
| LLM summary succeeds | committed | written / empty / disabled / failed | task continues |
| LLM summary falls back | committed | written / empty / disabled / failed | task continues |
| Checkpoint commit fails | failed | absent | replacement not applied |
| Memory lock or write fails | committed | failed | replacement applied; no user error |
| Same entry is retried | committed | nothing new | duplicate is not appended |
| ACP remote workspace | committed | disabled | no local memory write |

Warnings use stable bounded categories. They may include an error name and a
whitelisted filesystem code, but not an exception message, workspace path,
candidate text, topic contents, or credentials.

## Testing and qualification

Implementation follows strict red-green-refactor order.

### Unit tests

- `MemorySafety` rejects each credential form and accepts ordinary technical
  text. The explicit tool and automatic planner use the same function.
- The planner covers every marker, ordering, normalization, exact deduplication,
  bounds, non-text payloads, reasoning, and the removal of raw tool-error capture.
- `AutoMemoryManager` proves atomic append, same-process concurrency, a spawned
  second-process writer, exact deduplication, mode `0600`, managed-index
  idempotency, preservation of user-authored index content, and bounded lock
  failure.
- `CompactionService` proves successful and fallback plans contain only omitted
  source messages, while abort and blocked paths produce no plan.
- Loop and slash-command tests prove checkpoint-before-memory ordering, no commit
  after checkpoint failure, best-effort memory failure, and no writes for snip-only
  recovery.
- Projection tests prove that no memory text, secret, workspace path, or storage
  error reaches TUI, Web, ACP, or Headless output.

### Deterministic production-build integration

A local Provider fixture forces a full compaction and exposes a unique reusable
knowledge marker. One release-blocking suite launches production `dist` through:

1. Headless JSONL;
2. ACP stdio;
3. raw PTY TUI;
4. Chromium Web GUI.

Each surface must prove that the task continues after compaction, the correct
workspace receives one memory entry, `MEMORY.md` discovers its topic, a second
Session loads the entry, repeated/reloaded observation does not duplicate it, and
no seeded secret appears in memory or surface output. Web verification includes a
real reload. Raw PTY verification is preferred over synthetic component-only
testing because no general terminal computer-use driver is available in the
current harness.

### Real API qualification

A gated release trajectory uses credentials loaded from the user's restricted
local configuration without printing, persisting, or committing them. It runs
DeepSeek Flash and DeepSeek Pro through Headless, ACP stdio, raw PTY, and Chromium
Web. Every cell must trigger a real Provider-backed full compaction and prove:

- continuation after compaction;
- one safe project-memory write in the correct workspace;
- discovery by a new Session;
- no duplicate write;
- no secret or credential leakage.

The trajectory is registered in the release-blocking real-API qualification
manifest. A green unit suite alone is not accepted as evidence for this feature.

### Release gate

Before tagging `v0.10.140`, run the focused tests, Web suite, real-API matrix,
build, and full `bun run test:all`. Update the Chinese and English memory guides,
process-lifecycle references, and source changelogs. Do not edit generated
`docs/changelog.md` or `docs/en/changelog.md`. Publish through an annotated tag
and verify the release workflow, GitHub Release, and npm registry version.

## Deferred semantic flush

An independent semantic pre-compaction memory flush remains a candidate for a
later patch. It would require an explicit cost/latency decision, separate model
call, once-per-cycle state, recursion suppression, response quality validation,
semantic deduplication, and its own cross-surface lifecycle. None of those
behaviors are implied by this patch.
