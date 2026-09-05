# Compaction Project Memory Qualification Evidence

- Date: 2026-09-06
- Target version: `blade-code@0.10.140`
- Implementation and real-API qualification baseline: `79c1d5c64addc85b5dd0dbac16a37017871421a8`
- Deterministic command: `bunx vitest run --config vitest.config.ts --project=integration tests/integration/compaction-memory-consolidation.test.ts`
- Real-API command: `REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts`

## Result

Full compaction now derives a bounded, content-private project-memory plan from visible
messages that are definitely removed from model context. The replacement checkpoint is
committed first. Memory is persisted only after that commit; a memory-write failure cannot
invalidate compaction or stop the task. The flow makes no additional Provider request.

The deterministic production test passed three consecutive runs. Each run covered
Headless, real ACP stdio, raw PTY TUI, and Chromium Web (`4/4`), for `12/12` surface
executions. Every cell injects one `context_length_exceeded` response and verifies
compaction start, durable checkpoint, the `written` projection, final response, exact
deduplication, the `MEMORY.md` topic link, discovery from a new Session, and sensitive
candidate rejection.

The real-API matrix used `deepseek-v4-flash` and `deepseek-v4-pro` across all four
production surfaces and passed `8/8`; Vitest took 120.73 seconds in the final
release-runner command, or 126.18 seconds including the production build. Model and
framework retries were both disabled. Each cell injected one context-limit response through a loopback proxy, then
forwarded compaction, continuation, and new-Session discovery requests to real DeepSeek.
Every cell produced one discoverable `conventions.md` entry and an exact final marker.

## Covered contracts

- Extraction is limited to explicit user `remember`/`note`, `convention`, and `lesson`
  markers plus explicit resolved-problem text from assistant messages; tool output, tool
  arguments, reasoning, metadata, and image URLs are never inspected.
- Each item is limited to 500 Unicode code points, with at most 20 items and 8,000 code
  points per plan.
- Credential labels, Bearer tokens, `sk-*` keys, AWS access keys, and PEM private-key
  headers fail closed.
- In-process and cross-process locking, atomic writes, `0600` modes, normalized exact
  deduplication, and one managed index block prevent lost or undiscoverable writes.
- Threshold, context-limit, turn-limit, and manual `/compact` paths all follow
  `checkpoint -> memory -> replacement`; remote ACP workspaces never write host project
  memory.
- TUI, Web, ACP, and Headless project only outcome/count/topic metadata, never content,
  paths, or storage errors.
- Web reload does not recreate the ephemeral success notice, and later Session/run/terminal
  boundaries clear it.
- Durable SSE replay filters hidden messages and non-tool parts, preventing internal content
  from bypassing the public boundary.
- Raw PTY directly verifies compaction status, the `Project Memory` completion message, the
  exact persisted final marker, and memory-index loading for the next Session.

## Defects found and fixed by qualification

1. TUI `MessageArea` rebuilt the streaming tool baseline on every history update, causing a
   late `Project Memory` completion message to be classified as old and omitted. The
   baseline now resets only at a streaming-generation or explicit-clear boundary.
2. Durable Web Session SSE replay forwarded `clientVisible:false` messages and their text
   parts verbatim. Live and replay paths now share one projector that suppresses hidden
   messages and text/reasoning/image/summary parts while retaining the existing safe tool
   call/result projections.

## Privacy and cleanup

Tests use random temporary HOME, `BLADE_STORAGE_ROOT`, workspace, Session IDs, and loopback
ports. Fixture secrets are never committed; real API credentials are loaded only from the
restricted local credential configuration. Assertions scan public JSONL, ACP updates, PTY
output, Web SSE, DOM, server output, and memory files. Provider proxies, SSE readers,
browser/pages, ACP connections, PTYs, servers, and temporary directories all close through
bounded teardown paths.

## Release gates

~~~text
type-check    PASS — CLI and Web
lint          PASS — CLI 1,411 files; Web 208 files
web test      PASS — 69 files; 665 tests
build         PASS — production CLI and Web
test:all      PASS — 497 files passed, 100 skipped; 5,813 tests passed, 88 skipped
performance   PASS — 4 files passed, 1 skipped; 9 tests passed, 1 skipped
coverage      PASS — 497 files passed, 100 skipped; 5,813 tests passed, 88 skipped
                statements 73.88%, branches 67.24%, functions 75.72%, lines 75.25%
real API      PASS — Flash/Pro × Headless/ACP/raw PTY/Web, 8/8
git diff      PASS
~~~

The final `test:all` main stage took 444.30 seconds, the performance stage took 5.58
seconds, and the complete command took 455.46 seconds. Coverage took 481.73 seconds. The
final release-runner real-API matrix cell timings were Flash
12.804/12.117/12.734/9.785 seconds and Pro 20.688/15.770/21.631/13.669 seconds, both in
Headless/ACP/raw PTY/Web order.

The first `test:all` run exposed three issues: the new PTY runner was missing from the
inventory, the runner process had not switched its own storage root to the isolated fixture,
and the unchanged Chromium cross-origin test intermittently observed a stale snapshot first.
The first two were fixed and covered by the later complete gate; the unchanged Chromium case
passed on its exact rerun.
The first attempt to use the plan's release-runner command with a file argument revealed
that the old runner ignored that argument and unintentionally ran all 45 historical real-API
files; 16 existing Web/process trajectories failed under that concurrent resource load. A
new runner argument contract now selects the requested trajectory, and the same command
completed with 8/8 and exit code 0.

## Completion audit

| Requirement | Inspectable implementation or evidence | Result |
| --- | --- | --- |
| Checkpoint first | `CompactionService` only plans; Runtime and `/compact` write after checkpoint | PASS |
| Failure isolation | Checkpoint failure skips memory; memory failure still applies replacement | PASS |
| Extraction and bounds | Fixed markers/topics, 20 items, 500 per item, 8,000 total code points | PASS |
| Safety | Shared credential classifier; no tool/reasoning/metadata/image inspection | PASS |
| Concurrency and persistence | Keyed mutex, file lock, atomic write, 0600, exact deduplication | PASS |
| Workspace isolation | Local workspaces are independent; remote ACP host writes are disabled | PASS |
| TUI | Production raw PTY renders compaction and `Project Memory`, exact final persisted | PASS |
| Web GUI | Production Chromium notice, terminal/reload clear, hidden SSE replay filtered | PASS |
| ACP | Real SDK stdio receives `blade/compaction.memory` | PASS |
| Headless | Production JSONL exposes only outcome/count/topic | PASS |
| New-Session discovery | All four surfaces verify the `MEMORY.md` topic link loads in a new prompt | PASS |
| Real models | DeepSeek Flash/Pro across all four surfaces | PASS |
| Docs and release | Bilingual guide/reference/evidence, source changelogs, CLI package bump | PASS |
