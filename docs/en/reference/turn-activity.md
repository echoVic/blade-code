# Active Turn Activity

Blade Code keeps the current top-level turn's ephemeral activity in `SessionRuntime` and projects the same state to TUI, Web, ACP, and Headless. Clients no longer infer “what is happening” independently from unrelated events.

## States and presentation

The phase vocabulary is closed:

- `starting`: the turn exists but has not entered the model loop;
- `thinking`: the model is reasoning or preparing its next action;
- `responding`: final response output has started;
- `executing_tools`: at least one tool is still active;
- `compacting`: context compaction is running;
- `continuing`: a tool result, follow-up, or Goal continuation is advancing.

The projection also includes the turn index, optional turn limit, started/completed tool counters, up to eight active tools, and an overflow count. A tool exposes only its sanitized name, kind, start time, and optional numeric progress. Clients derive elapsed time from `startedAt`; no per-second protocol traffic is needed. An unlimited turn count is represented as `null`.

The TUI loading area shows the phase, active tools, tool/turn counters, elapsed time, and the Esc hint. Web renders a compact `role=status`, `aria-live=polite` strip above the composer. Surface precedence is: pending interaction, Provider recovery, action stationarity, turn activity, then generic loading copy, so specialized states are not duplicated.

## Lifecycle and reconnects

Every top-level turn creates a new `generation`; semantic changes increment `revision`. Old generations, old revisions, and late live generations without a revision-0 anchor cannot replace current state. Completion, failure, cancellation, early consumer close, and Runtime disposal publish `snapshot: null` and invalidate the old generation.

Web SSE treats `connected.properties.turnActivity` as authoritative. A page reload or EventSource reconnect during tool execution restores the snapshot before later live revisions arrive. An idle Session without a resident Runtime receives an explicit `null`.

## Protocol surfaces

- TUI/internal Agent stream: `turn_activity`;
- Web Session Bus/SSE: `turn.activity`, with `turnActivity` on the connected frame;
- ACP: `session_info_update._meta['blade/turnActivity']`;
- Headless JSONL: `type: "turn_activity"`, snake_case fields, and `snapshot: null` for clear;
- Headless text mode remains silent to avoid progress spam.

The Runtime publishes authoritative ACP/Web events through the Session Bus. ACP suppresses duplicate generation/revision updates, and the direct Agent stream does not emit the same metadata a second time.

## Privacy boundary

Activity is not persisted in transcripts. It never contains tool arguments, commands, output, paths, prompts, URLs, raw errors, progress messages, or credentials. TypeBox validation and Runtime reduction reject or ignore unknown fields, invalid counters, oversized names, and inconsistent progress.
