# History-Free Session Projection Release Evidence

## 2026-08-29 Qualification (`blade-code@0.10.120`)

- Design commit: `0b30548a`
- Plan commit: `afe9ecbd`
- RED commit: `1779d10c`
- Implementation commit: `4a484cd4`
- Goal: stop the Web server's live Session projection from retaining complete
  transcripts while preserving catalog counts, message reads, and cold Agent context.

### Reachable issue before the fix

- The module-level `sessions` Map stored complete `messages: Message[]` arrays in each
  `SessionInfo`.
- `getOrHydrateSession()` read metadata, full history, and the task worktree in parallel,
  then cached the complete `SessionInfo` indefinitely.
- Opening an idle Session SSE connection or resolving a Browser route therefore retained
  transcript-sized data without creating a `SessionRuntime`. Runtime residency count and
  TTL controls could not govern this retained history.
- Active-session `messageCount` came from `session.messages.length`, which could include
  internal system/tool messages, while cold catalog entries used the durable
  user/assistant count. The same Session could report different warm and cold values.

### RED evidence

- The AST source gate first failed 2/2 checks: `SessionInfo` had no `messageCount` and
  still contained `messages: Message[]`; `getOrHydrateSession()` still called
  `SessionService.loadSession()`.
- The two route REDs first failed 2/2: idle SSE hydration loaded full history once, and
  `GET /message` reused cached history instead of reading the durable source after an SSE
  projection existed.
- After the minimal production change, the first complete
  `session-routes.test.ts` run had 136 passed and two failed. Both were old assertions:
  the rewind fixture did not provide the new durable history and the shell fixture still
  expected a full-history load after completion. They passed after adapting to the new
  contract.
- Quality review found that rewind still assigned `new Date()` to the live timestamp. A
  new assertion produced a valid RED: expected durable
  `2026-08-05T00:00:01.000Z`, received the current wall-clock timestamp. Refreshing
  authoritative metadata made it GREEN.

### Repaired boundary

- `SessionInfo` keeps `messageCount` and live metadata, but no `Message[]`.
- Hydration reads only authoritative metadata and the small task-worktree descriptor.
  Session SSE and Browser ref-only access therefore do not retain full transcripts.
- `GET /sessions/:sessionId/message` always reads durable history for that request and
  immediately applies the client-safe projection. It neither reuses nor writes full
  history into the live projection.
- Cold Agent execution still obtains complete model context through
  `SessionService.loadSessionModelContext()`, matching the
  `SessionRuntime.loadModelContext()` durable-context boundary;
  `sessionStart.isResume` now uses durable `messageCount > 0`.
- Create, task, fork, and permission recovery insert only history-free projections. Run,
  review, recovered-review, shell, and rewind completion refresh authoritative metadata;
  rewind no longer fabricates `lastMessageTime` from the local wall clock.
- Active and cold catalog entries now use the same durable count of user/assistant
  `message_created` events. Internal system/tool entries cannot change the count merely
  because a Session was hydrated.

### Review results

- RED review found that the source gate used brittle string boundaries and that the fresh
  durable-load test mixed call and result assertions. The gate now uses the TypeScript
  AST, and the route test fixes exact call arguments and filtered output separately; both
  remained causal REDs.
- Implementation specification review reported no Critical, Important, or Minor finding
  and marked the change spec compliant.
- Implementation quality review found only the non-durable rewind timestamp. After its
  focused RED/GREEN fix, re-review reported no remaining finding and Ready: Yes.

### Focused verification results

- `session-projection-history-boundary.test.ts` plus the complete
  `session-routes.test.ts`: two files and 140 tests passed.
- TypeScript: CLI type check, VSCode lint, and Web type check all exited 0.
- Biome on changed files and `git diff --check` both exited 0.
- Final `bun run lint && bun run build && bun run test:all`:
  - Non-performance: 448 files passed and 91 skipped; 4,606 tests passed and 85
    skipped.
  - Performance: 4 files passed and 1 skipped; 9 tests passed and 1 skipped.
  - Exit code 0 with no failures. The build retained the existing non-blocking
    Browserslist-data-age and Web chunk-over-500-kB warnings.

### Provider qualification boundary

This patch did not run a real Provider request. The defect and repair concern where
durable history is loaded, the live projection shape, and Runtime context assembly.
Deterministic tests cover the production route and Runtime seams; a real model request
would not add relevant retained-history ownership coverage.

### Release boundary

`0.10.120` contains only the history-free live Session projection, deterministic
regressions, design and plan, this evidence and its Chinese counterpart, bilingual
changelogs, and the package version. Lightweight live-overlay entry count/TTL, generation
fencing, message pagination, and transient request-memory limits remain separate
follow-up patches.
