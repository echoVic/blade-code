# Changelog

## [0.10.122] - 2026-08-30

### Fixed
- Made TUI Runtime and Agent initialization generation-fenced, exact-target single-flight, and cleanup-owned across unmount, graceful shutdown, Session/workspace replacement, and concurrent turns.
- Destroyed the previous completed-turn Agent before creating its replacement, propagated real cleanup failures, and kept lifecycle cancellation silent in command output.

### Tests
- Added deterministic Promise-gated ownership regressions and real DeepSeek Flash/Pro two-turn qualification, plus a production raw-PTY follow-up control with framework retries disabled.

## [0.10.121] - 2026-08-29

### Fixed
- Fenced asynchronous Web Session hydration by exact generation across delete, archive, controller replacement, and shutdown so stale work cannot repopulate live projections.
- Routed durable permission recovery through the active controller's single-flight hydration owner, while preserving committed responses without creating unowned live state when no controller is active.

### Tests
- Added deterministic Promise-gated regressions for stale hydration commits, lifecycle errors, generation ABA safety, permission-recovery ownership, failed-archive preservation, and ordinary same-key single-flight behavior.

## [0.10.120] - 2026-08-29

### Fixed
- Removed complete transcript arrays from the Web server's live Session projection, so SSE and Browser access no longer retain history-sized memory without a Runtime.
- Unified active and cold Session message counts on durable user/assistant metadata while preserving request-scoped history reads and Runtime-owned model context.

### Tests
- Added AST and route regressions for history-free hydration, durable message reads, Browser access, cold resume context, and authoritative rewind/shell metadata.

## [0.10.119] - 2026-08-29

### Fixed
- Made global and per-Session SSE connections explicit controller-owned resources that terminate and drain before Runtime teardown.
- Propagated Node client disconnects into Fetch request cancellation and ordered graceful shutdown so open SSE clients no longer block server stop.
- Preserved deterministic cleanup errors and server ownership so a failed shutdown can be diagnosed and retried.

### Tests
- Added deterministic controller, pre-handoff abort, per-stream isolation, real Node disconnect, graceful-stop, and cleanup-retry regressions.

## [0.10.118] - 2026-08-29

### Fixed
- Disposed Web Session Runtimes that finish creation but fail before residency accepts ownership, preserving the original initialization failure when cleanup also fails.

### Tests
- Added deterministic SSE/shutdown race coverage for late Runtime creation, exact pre-commit cleanup, empty residency state, and cleanup-error precedence.

## [0.10.117] - 2026-08-29

### Fixed
- Made production ACP pending-resume completion wait for its exact terminal metadata delivery without retrying an already completed durable turn on egress failure.
- Preserved retry backoff and wake ownership across busy operations, cancellation, teardown, and bounded ACP writer failures.

### Tests
- Added deterministic coverage for incomplete metadata prefixes, malformed updates, absolute polling deadlines, deferred or rejected writers, teardown joins, cancellation, and busy-operation wake ordering.
- Requalified the one-shot-failure production ACP recovery path with a real DeepSeek request and zero framework retries.

## [0.10.116] - 2026-08-29

### Fixed
- Added an opt-in nonce-bound OSC readiness handshake emitted only after the active TUI composer input handler is registered.
- Made prompt-sending raw PTY runners wait for the exact per-child readiness marker and removed the token-budget runner's five-second bracketed-mode fallback.

### Tests
- Added deterministic nonce validation, registration ordering, runner inventory, wait-before-paste, and cross-chunk marker coverage.
- Verified the DeepSeek Flash/Pro token-budget and large-prompt raw PTY cells with real Provider requests and zero framework retries.

## [0.10.115] - 2026-08-29

### Fixed
- Resumed parent turns after process restart when every successful result is a host-validated foreground Task adoption with known-safe side effects.
- Persisted a v3 recovery proof across repeated restarts while keeping ordinary successful tools, interrupted tools, legacy receipts, and malformed or unsafe adoptions gated for explicit attention.

### Tests
- Added strict adoption identity, mixed-result, interrupted-tool, malformed-proof, second-restart, and ACP v2/v3 compatibility coverage.
- Requalified DeepSeek Flash and Pro adoption through Headless, ACP, raw PTY, and production Chromium Web with real Provider requests and zero framework retries.

## [0.10.114] - 2026-08-29

### Tests
- Stabilized durable-recovery final-marker qualification by distinguishing an incomplete task lifecycle from a structural mismatch before evaluating the final response.
- Isolated the durable raw-PTY marker protocol from the generic foreground PTY protocol and added deterministic ACP, PTY, bounded-output, and trajectory-harness regressions.

## [0.10.113] - 2026-08-29

### Documentation
- Documented the shared pending-resume decision policy, the distinct Web and ACP lifecycle boundaries, the zero-side-effect replay gate, and the CLI/TUI non-retry boundary.

### Tests
- Added real DeepSeek qualification for durable pending-interaction recovery through production Chromium, a production ACP child over SDK stdio, and the production CLI through a raw PTY.
- Hardened qualification with one-shot `503` injection, streamed upstream lifecycle evidence, exact persisted answers and final output, ordered failed/unacknowledged then successful/acknowledged turns, one `Write`, reload and shutdown checks, prompt-isolated Web/PTY markers, and bounded redacted diagnostics.

## [0.10.112] - 2026-08-28

### Fixed
- Made Goal frontier-stall cleanup an atomic no-op for Sessions without a Goal, preventing ordinary write turns and recovered pending interactions from failing after a successful tool result.

### Tests
- Added GoalStore and Agent-loop regressions for the no-Goal write path, and verified the repaired path through production Chromium with a real DeepSeek request and one injected transient failure.

## [0.10.111] - 2026-08-28

### Fixed
- Preserved replayed pending permission, question, and elicitation cards when an older authoritative message resync finishes after Session SSE initialization, while still dropping resolved interactions.

### Tests
- Added deterministic coverage for the idle-status/resync race and stale interaction removal, plus reusable one-shot Provider failure injection and bounded production Web recovery evidence validation.
- Verified the full deterministic suite with 4,417 passing tests and the Web suite with 509 passing tests.

## [0.10.110] - 2026-08-28

### Added
- Projected bounded Web pending-resume recovery into the active Session store and status bar, including attempt counts and retry delay without exposing Provider details.

### Fixed
- Cleared transient recovery state across Session switches, terminal lifecycle events, rewinds, cancellation, and exact-session user turns while preserving it through recovered assistant output.

### Tests
- Added strict payload validation, workspace identity, lifecycle reset, status priority, and privacy coverage; the Web suite passes 65 files and 507 tests.

## [0.10.109] - 2026-08-28

### Fixed
- Made terminal Web pending-resume failures survive SSE reconnects so replay-safety and four-attempt/120-second budgets cannot be reset by a new wake.
- Fail closed when a retry cannot start or its shared deadline expires before Agent creation, while preserving canonical errors and durable task status.
- Invalidated stale retry attempts immediately before run startup so abort, deletion, controller replacement, and shutdown cannot revive cancelled work.

### Tests
- Added direct Runtime lease handoff, terminal persistence failure, reconnect, pre-start deadline, and in-flight cleanup race coverage.
- Verified 443 deterministic test files with 4,406 passing tests; 82 credential-gated real API cases remained conditionally skipped.

## [0.10.108] - 2026-08-28

### Fixed
- Isolated Web pending-resume route fixtures from shared module and Agent mocks so Headless Core coverage observes the real single-flight lifecycle deterministically.

### Tests
- Headless Core now passes the full 9-file, 391-test recovery gate with the Web pending-resume scenarios included.

## [0.10.107] - 2026-08-28

### Fixed
- Made Web pending-resume recovery single-flight, cleanup-aware, cancellable on shutdown or new input, and bounded by the shared retry policy.
- Stabilized the CLI transcript pager integration under coverage by flushing the shortcut state transition through React `act`.

### Tests
- Added Web pending-resume ownership, cleanup, cancellation, deadline, and concurrent-wake coverage.
- Verified the full coverage suite: 443 files passed and 4402 tests passed.

## [0.10.106] - 2026-08-28

### Fixed
- Normalized Provider recovery-budget, request-deadline, and stream-idle timeout failures into the canonical retryable task failure without leaking provider details.
- Hardened task-failure projection against malformed canonical payloads, cyclic error chains, and deeply nested error metadata.

### Tests
- Added bounded nested-error, canonical-payload, cyclic-chain, and sensitive-detail regression coverage.

## [0.10.105] - 2026-08-28

### Fixed
- Prevented ordinary unchanged Goal work from being classified as stalled without an auditable liveness signal.
- Deferred the unused session-event module preload from the Web initial page to keep the startup bundle within budget without changing event ordering.
- Shared the bounded pending-resume recovery policy between ACP and future Web recovery orchestration.

### Tests
- Re-ran the full CLI and Web suites, production build, real DeepSeek Goal recovery, and production Web GUI reload qualification.
- Added deterministic pending-resume policy coverage for replay boundaries, attempt limits, and recovery budgets.

## [0.10.104] - 2026-08-28

### Fixed
- Applied repository formatting to the Goal frontier runtime and qualification changes so the CI Quality Gate passes its format check.

### Tests
- Re-ran format, type-check, production build, and focused Runtime/Web regression gates after formatting.

## [0.10.103] - 2026-08-28

### Added
- Added a durable Goal frontier stall classifier for dependency waits, unchanged tasks, and repeated deferrals.
- Added bounded strategy-change prompts and stall diagnostics across Headless JSONL, CLI TUI, Web SSE/DOM, and ACP metadata.

### Fixed
- Goal frontier refreshes now preserve same-turn diagnostics without incrementing cross-continuation stall counts, and workspace mutations clear stale stall state.

### Tests
- Added deterministic persistence, continuation, schema, and cross-surface coverage.
- Qualified the behavior with real DeepSeek Goal trajectories and a production Web GUI reload trajectory.

## [0.10.102] - 2026-08-28

### Added
- Added a goal-scoped durable execution frontier backed by the existing TaskList, with stable Goal isolation and Team > Goal > Session task scope precedence.
- Added bounded frontier refresh and continuation injection so resumed Goals receive the latest task counts, dependency blockers, next executable task, and digest before Provider execution.
- Added GoalSnapshot v2 persistence with v1 read compatibility, atomic frontier updates, and unfinished-task completion protection.
- Added frontier projections for Headless JSONL, Web SSE/store state, ACP metadata plus plan updates, and the CLI TUI task panel.
- Added transcript pager full-text search and clipboard copy support.

### Fixed
- Added Web preview display-mode translations and bounded Goal frontier DOM attributes for reload-safe GUI observability.
- Goal frontier read failures now pause the Goal with a typed, recoverable diagnostic instead of continuing with an unknown task state.

### Tests
- Added deterministic frontier, GoalStore migration, scope precedence, continuation, and cross-surface projection coverage.
- Qualified Goal frontier behavior with real DeepSeek Runtime, Web REST, ACP, and production Web GUI reload trajectories; all required browser assertions pass.
- Full Bun 1.3.11 build, type-check, lint, and test gates pass: 4,322 tests passed and 82 conditional skips retained.

## [0.10.101] - 2026-08-27

### Added
- Added an entry-point-neutral durable turn-recovery assessment projected through
  CLI TUI, Headless/Print, Web, and ACP, including recovered-completion state
- Added durable, turn-scoped recovery acknowledgement so explicit operator review
  survives process restarts even when an active Goal has no inbox input

### Fixed
- Interrupted or already-successful tools now block automatic continuation until
  explicit input confirms external state was inspected; blocked task Sessions stay
  recoverable instead of being incorrectly persisted as completed
- Legacy v1 abort receipts recover uncertain tool evidence from their synthetic
  process-restart results, preventing upgrades from replaying unknown side effects
- Inputless Headless and Print recovery now fail visibly instead of returning an
  empty success; Headless uses exit code 2 for the attention-required state
- ACP failures retain the runtime model ID alongside their canonical typed error
  data without exposing raw Provider details

### Tests
- Added repeated-restart, v1 migration, acknowledgement, task-status, rewind,
  Headless/Print, TUI, Web, and ACP regression coverage
- Qualified the recovery gate with real DeepSeek API calls across Headless, ACP,
  raw PTY TUI, and production Web GUI/reload, including exactly-once file effects

## [0.10.100] - 2026-08-27

### Fixed
- Goal completion verification now treats the host-accepted
  `verifying`/`pending` candidate as authoritative evidence that
  `UpdateGoal complete` was submitted, preventing a circular requirement for
  `complete` or PASS before the verifier can issue its own verdict
- The candidate fact remains control-plane-only: verifiers must still prove every
  requested artifact, test, command, and observable outcome independently

### Tests
- Tightened the real DeepSeek premature-stop recovery trajectory to require the
  first completion candidate to PASS with no intermediate FAIL/PARTIAL verdict,
  and qualified direct Runtime, verifier feedback, production Web, and ACP paths

## [0.10.99] - 2026-08-27

### Added
- Made native Browser tools the default execution and verification path for
  rendered Web/UI work, with explicit GUI validation before completion
- Added vision-assisted `click_at` fallback backed by fresh screenshot authority,
  stable-frame validation, viewport/origin binding, stale-pixel rejection, and
  fail-closed frame protection
- Added element picking to the user Test browser: boxed ARIA regions can be
  selected directly on the screenshot and appended as bounded, untrusted context
  to the current Session composer

### Fixed
- Main-view navigation now closes Settings, so New Task, Task Board, project, and
  Session navigation cannot remain hidden behind the Settings page

### Tests
- Added Browser prompt, schema, multimodal Provider context, screenshot authority,
  Web projection, composer draft, and navigation regression coverage
- Qualified the Browser flow with real Chromium, native Web GUI interaction, and
  an eight-cell zero-retry DeepSeek matrix across Headless, TUI, Web, and ACP

## [0.10.98] - 2026-08-27

### Fixed
- ACP now retries durable pending-input auto-resume after canonical transient
  failures, using single-flight bounded backoff, stable jitter, and a hard recovery
  deadline
- Auto-resume retries fail closed after any partial output or tool execution, and
  cancellation, egress failure, or Session destruction invalidates queued attempts

### Tests
- Added exhaustive ACP retry lifecycle coverage and a real DeepSeek trajectory
  that injects one HTTP 503 and verifies exactly-once input projection and file
  effects

## [0.10.97] - 2026-08-27

### Fixed
- Resumed task Sessions now return a canonical `workspace_unavailable` failure
  when their managed worktree is missing, mismatched, or no longer registered,
  instead of collapsing into a generic runtime error
- Server and Web surfaces map unavailable task workspaces to HTTP 409 and retain
  the typed failure in task state so users receive actionable recovery guidance

### Tests
- Added unit, integration, and Web component coverage for missing, mismatched,
  and unregistered task worktrees

## [0.10.96] - 2026-08-27

### Fixed
- Tool invocation retries now fail closed: only explicitly replay-safe local query
  tools retry transient resource errors, preventing Bash, file writes, MCP calls,
  stdin writes, and other side effects from being duplicated after an indeterminate
  failure
- Query-tool adapters preserve structured retryable error causes instead of
  misreporting transient failures as missing or empty state; prompt artifact
  initialization can recover after a failed attempt
- Retry backoff now observes cancellation before another tool attempt can start
- Web surfaces confirmed HTTP submission rejections even when an SSE resync has
  already replaced the optimistic message, preserving capacity error feedback

### Tests
- Added an exhaustive built-in retry-safety inventory and a real-filesystem
  integration test proving an uncertain side effect executes only once
- Hardened raw PTY qualification by forcing interactive child rendering,
  matching the current composer marker, and chunking bracketed-paste input

## [0.10.95] - 2026-08-26

### Added
- Web now opens the Browser panel automatically when the Agent uses a native
  Browser tool and switches Test mode to a read-only Agent view
- Agent Browser interactions now project bounded target geometry so the Web panel
  can animate a visible pointer and click feedback over the latest screenshot

### Security
- Agent browser observation uses an origin-checked, screenshot-only route and does
  not issue snapshots, expose page content, or grant the Web UI control of the
  Agent BrowserContext

### Tests
- Extended the real DeepSeek production Web trajectory to require automatic panel
  opening, Agent screenshots, pointer feedback, and disabled user controls

## [0.10.94] - 2026-08-26

### Fixed
- Preserved the current Web task transcript when stopping a run by deferring
  authoritative history resync until the server reaches its stable idle state

## [0.10.93] - 2026-08-26

### Fixed
- Formatted the Browser Panel production qualification fixture so the repository
  quality gate validates the release source

## [0.10.92] - 2026-08-26

### Added
- Added a unified Web Browser panel with iframe Preview, isolated Chromium Test,
  and explicit system-browser External modes
- Added Session-scoped Web Browser navigation, interaction, snapshot, diagnostics,
  screenshot, and reset APIs

### Changed
- Web Test browsing now owns a separate ephemeral `BrowserContext` so user
  interaction cannot take over Agent Browser Tool pages, cookies, or snapshot refs
- Lucide icons now follow Vite's dynamic chunk graph instead of being forced into
  the initial Web bundle

### Security
- Web Test reuses Browser Runtime URL, origin, popup, download, resource, and
  redaction boundaries, and releases contexts on reset, Session deletion, and
  server shutdown

### Tests
- Added route, lifecycle, screenshot, interaction, stale-snapshot, responsive UI,
  real Chromium, and production Web trajectory coverage

## [0.10.91] - 2026-08-26

### Fixed
- CI coverage publishing now uses `codecov/codecov-action@v7` and
  `actions/upload-artifact@v7` on Node.js 24-compatible runtimes, with a
  complete workflow inventory test preventing legacy action regressions

## [0.10.90] - 2026-08-26

### Fixed
- CI dependency and Playwright browser caches now use `actions/cache@v6` on the
  Node.js 24 action runtime, with a complete workflow inventory test preventing
  legacy cache-action regressions

## [0.10.89] - 2026-08-25

### Fixed
- CI coverage now provisions the pinned Chromium system dependencies and SUID
  sandbox helper, verifies sandboxed startup, and preserves the helper path through
  the Browser runtime environment allowlist

## [0.10.88] - 2026-08-25

### Fixed
- CI coverage now explicitly installs and caches the pinned Playwright Chromium
  runtime before executing browser integration tests

## [0.10.87] - 2026-08-25

### Added
- Added six deferred native Browser tools for navigation, accessibility snapshots,
  ref-based interaction, waiting, diagnostics, screenshots, and page management
- Added explicit `blade browser install` and `blade browser status` commands for
  the pinned Playwright 1.62.1 Chromium runtime

### Changed
- Browser automation now uses one lazy process-wide Chromium with an isolated,
  ephemeral BrowserContext owned by each Session
- CLI, Headless, Web, and ACP now consume one canonical Browser Tool result and
  bounded metadata contract; the existing iframe Browser Preview remains independent
- Session screenshot artifacts now use private content-addressed storage and are
  removed through the same normalized workspace identity as the owning Session

### Security
- Chromium sandboxing is explicitly enabled, while the browser process receives
  only an allowlisted environment without Provider credentials
- Navigation and interaction permissions are scoped to normalized HTTP(S) origins,
  with stale snapshot/ref checks and pre/post-action origin validation
- Cross-origin navigation, popups, and frame interaction are blocked; opaque
  sandboxed frames, credential controls, downloads, arbitrary selectors, script
  evaluation, uploads, persistent profiles, and storage-state access remain unavailable

### Tests
- Added deterministic real-Chromium coverage for all six tools, Session isolation,
  sandbox launch arguments, redirects, popups, frames, dialogs, downloads,
  diagnostics, artifacts, stale refs, bounds, aborts, crashes, and cleanup
- Added a zero-retry DeepSeek Flash/Pro qualification matrix across Headless, raw
  PTY TUI, production Chromium Web, and ACP surfaces

## [0.10.86] - 2026-08-25

### Changed
- The right-side Preview panel now opens directly into its four tabs, with the
  desktop tabs filling the compact toolbar instead of sharing space with a
  redundant title row or close action
- Desktop users collapse Preview through the existing global toolbar toggle;
  the full-screen compact dialog retains its internal close action
- A new global maximize/restore control lets Preview occupy the complete
  workspace while preserving the sidebar, application header, and the user's
  split-view width
- Maximized Preview keeps the current Session composer available as a bottom
  overlay with a status row that expands into conversation and runtime details
- The panel retains its accessible Preview label while reclaiming vertical
  space on both desktop and compact mobile layouts

### Tests
- Added toolbar structure, maximize/restore layout, and compact keyboard-focus
  coverage, plus desktop and mobile production Chromium validation
- Re-ran the complete Web suite, bundle-size gate, and real DeepSeek embedded
  browser trajectory

## [0.10.85] - 2026-08-23

### Added
- The right-side Preview panel now includes a Browser tab with address
  navigation, bounded back/forward history, reload, and explicit system-browser
  opening
- Bare local and private-network development addresses resolve to HTTP, while
  ordinary bare hosts resolve to HTTPS

### Changed
- Browser state remains mounted while switching Preview tabs, and project-only
  Preview sessions now default to Files once without overriding later tab
  choices
- Browser-specific translations remain in the lazy Preview chunk so the
  initial Web bundle stays within its existing gzip budget

### Security
- Embedded navigation accepts only HTTP(S), rejects credential-bearing URLs
  and Blade Web's own origin, and runs in a no-referrer sandboxed iframe
- Blade does not proxy target pages or remove their `X-Frame-Options` or CSP
  boundaries

### Tests
- Added deterministic URL, history, navigation, reload, error, external-open,
  tab-preservation, and compact-focus coverage
- Release qualification now includes a real DeepSeek turn followed by
  production Chromium desktop/mobile browser navigation, sandbox assertions,
  console fault checks, and complete server/browser/port cleanup
- Token-budget qualification now enforces zero prefix/suffix bytes around the
  copied final marker, forbids observed boundary/copy narration, and reports
  only bounded redacted mismatch diagnostics

## [0.10.84] - 2026-08-23

### Changed
- Session transcript initialization now shares one in-flight first-access
  operation across storage facades and retains successful initialization in a
  256-entry per-facade LRU cache
- Ordinary message, tool, interaction, review, compaction, and lifecycle
  appends no longer re-read and parse the complete transcript solely to prove
  that immutable Session metadata already exists

### Fixed
- Concurrent first writes to a new Session can no longer commit duplicate
  `session_created` events
- Failed or corrupt initialization is never cached, and deleting a Session
  invalidates its local positive initialization state before reuse

### Tests
- Added deterministic coverage for concurrent first writes through independent
  facades, gapless event sequences, scan-free hot-path appends, failed
  validation retry, delete/recreate behavior, and bounded LRU eviction
- Release qualification retains real Provider coverage across Headless, raw
  PTY TUI, production Chromium Web GUI, and ACP
- Provider-recovery Web qualification now latches full structured lifecycle
  evidence before bounded diagnostic-tail truncation
- Token-budget qualification now emits an explicit final-copy contract before
  the hidden Bash marker while retaining exact-output assertions and zero test retry

## [0.10.83] - 2026-08-23

### Added
- User prompts above 32 KiB are now stored as Session-private,
  content-addressed artifacts, while Providers receive a bounded UTF-8-safe
  preview and opaque artifact ID
- The always-available read-only `ReadPromptArtifact` tool supports verified,
  paginated reads up to 64 KiB without exposing host paths

### Changed
- TUI, Headless, Web, and ACP now share a 1,000,000-character and 4 MiB durable
  user-input contract, including active-turn steering and restart recovery
- Session forks copy only referenced prompt artifacts; Session deletion removes
  private artifacts without affecting source or sibling Sessions

### Fixed
- Large specifications, logs, and migration requests no longer fail at the
  previous 32,000-character transport limit or enter the first Provider request
  in full
- Host verification, worktree, delegation, and completion policy still evaluate
  the complete original request, and multimodal offload preserves image order
- Artifact reads now fail closed on invalid IDs, ownership, permissions, size,
  hashes, layouts, or symlink substitution

### Tests
- Added deterministic coverage for UTF-8 pagination, metadata persistence,
  restart, fork/delete lifecycle, multimodal order, quotas, transport limits,
  tool filtering, and original-input host policy
- Added a release-blocking DeepSeek Flash/Pro matrix across Headless, raw PTY,
  production Chromium Web, and ACP that proves hidden prompt content reaches the
  Provider only through the matching durable tool result
- Hardened token-budget continuation fixtures to preserve the exact final-output
  protocol across fallback compaction, and expanded the complete release matrix
  watchdog from 60 to 90 minutes for the new eight-cell large-prompt coverage
- Gave the large-output foreground accounting control a five-second handoff
  margin so loaded hosts cannot accidentally exercise the background path, and
  made the TUI batched-input harness submit its latest rendered value

## [0.10.82] - 2026-08-23

### Added
- Predictive context-window accounting now uses the latest complete Provider
  token usage as a baseline and estimates only post-response tool results,
  control messages, and positive request-shape growth before the next request
- Durable compaction checkpoints and Headless, Web, and ACP lifecycle
  projections now expose `preTokenSource` and `estimatedPendingTokens`

### Changed
- The 70% handoff and 80% compaction thresholds now share one complete-context
  projection instead of relying on the previous request's prompt tokens
- Model and tool-schema switches retain Provider usage as a conservative floor;
  destructive history rewrites or missing usage fall back to a complete local
  system, tool, and history estimate
- TUI context occupancy now uses complete Provider total tokens, matching Web

### Fixed
- Large model completions, tool results, runtime control messages, and newly
  activated project rules can no longer leave the next Provider request
  undercounted until a reactive context-limit failure
- Turn-limit compaction now includes all response and tool-result growth in its
  pre-compaction token projection

### Tests
- Added boundary, stale-baseline, model/schema switch, history-rewrite,
  persistence, and cross-surface deterministic coverage
- Qualified the one-token-below-threshold negative control with real DeepSeek
  Flash/Pro across Headless, raw PTY, production Chromium Web, and ACP
- Withheld the final token-budget marker until the passing verification command,
  preventing models from bypassing the required four-boundary tool trajectory
- Hardened ACP residency qualification to await durable completion before
  closing a follow-up that was accepted as steering

## [0.10.81] - 2026-08-23

### Added
- Deterministic compaction fallback now targets the smallest of an 80% source
  budget with a 5,000-token floor, 50% of the model context window, and an
  absolute 50,000-token cap
- Durable checkpoints and TUI, Headless, Web, and ACP lifecycle projections now
  expose fallback target, omitted-message, and truncated-message metrics

### Changed
- Fallback history is packed newest-first as complete atomic tool-call units and
  token-truncates at most one oversized boundary unit while retaining its head
  and tail
- Mandatory continuation checkpoints can raise the fallback target only to
  their measured size

### Fixed
- Fallback history no longer retains reasoning payloads, images, orphaned tool
  results, incomplete empty assistant turns, or a fully checkpointed duplicate
  active-task request
- Token accounting now includes replayed reasoning content, and compaction
  reminders preserve exact pending actions and final-response constraints

### Tests
- Qualified deterministic fallback and real-summary recovery with DeepSeek
  Flash/Pro across Headless, raw PTY, production Chromium Web, and ACP
- Qualified compaction safety with real DeepSeek Flash/Pro, Claude, and GPT;
  Production Qualification passed all 16 checks with 174 real-API tests

## [0.10.80] - 2026-08-23

### Added
- Compaction now validates the complete replacement, including retained messages
  and restored checkpoints, against a same-basis token estimate
- Durable checkpoints and TUI, Headless, Web, and ACP lifecycle projections now
  expose the stable `insufficient_reduction` fallback classification

### Fixed
- Non-empty summaries for histories of at least 5,000 estimated tokens are no
  longer committed when the complete replacement retains more than 80% of the
  source; Blade falls back deterministically and preserves billable usage
- Repeated ineffective summaries now participate in the existing per-session
  circuit breaker instead of issuing unbounded Provider requests
- Cross-provider release qualification now aligns the GPT fallback idle
  deadline with its request deadline while retaining the 45-second recovery cap

### Tests
- Added complete-replacement, usage, circuit-breaker, checkpoint, and
  cross-surface projection coverage
- Qualified effective compaction with real DeepSeek Flash/Pro, Claude, and GPT,
  plus the complete production Web, raw PTY, Headless, and ACP release matrix

## [0.10.79] - 2026-08-23

### Added
- Compaction now replaces every multimodal image part with a fixed text
  placeholder before calling the text-only summary Provider
- Durable checkpoints and TUI, Headless, Web, and ACP lifecycle projections now
  expose the number of images omitted from each compaction request

### Fixed
- Inline data URLs, base64 image payloads, and remote image URLs no longer reach
  the compaction Provider, while canonical history and retained messages remain
  unchanged
- Real-API recovery qualification now avoids privacy-triggering marker language
  and isolates sequential Web and ACP trajectories across Provider channels

### Tests
- Added fail-closed proxy checks and a real DeepSeek Flash/Pro, Claude, and GPT
  trajectory proving image payload elision, text preservation, durable metrics,
  and canonical message immutability

## [0.10.78] - 2026-08-23

### Added
- Compaction now adapts oversized summary inputs within the existing
  three-attempt budget by removing re-readable files, dropping the oldest
  complete tool-call units, then lowering the per-message character cap
- Durable checkpoints and Headless, Web, and ACP lifecycle events now expose
  input reduction and omitted message/file counts

### Fixed
- Context-window failures no longer replay an identical compaction payload;
  fallback starts immediately when the host cannot produce a strictly smaller
  request
- Exact continuation records are restored from the full canonical transcript
  after a reduced-input summary succeeds

### Tests
- The real DeepSeek Flash/Pro Headless, raw PTY, production Chromium Web, and
  ACP matrix now injects context overflow followed by `503`, proves the retry
  payload is smaller, and verifies the durable reduction metadata

## [0.10.77] - 2026-08-23

### Added
- Compaction summaries now use a bounded three-attempt recovery loop for
  transient Provider failures, stream closures, and empty responses
- Durable checkpoints and Headless, Web, and ACP lifecycle events now expose
  compaction sample attempts and stable fallback classifications

### Changed
- Compaction disables nested ChatService retries so one host-owned policy
  controls classification, exponential backoff, aborts, and request count

### Fixed
- Authentication, permission, invalid-request, context-overflow, and caller
  abort failures now stop compaction retries immediately
- Usage and cost from successful empty compaction samples are accumulated
- Web recovery qualification retains protocol evidence separately from large
  rendered HTML, preventing valid early retry events from being truncated

### Tests
- The real DeepSeek Flash/Pro Headless, raw PTY, production Chromium Web, and
  ACP token-budget matrix now injects one compaction `503`, requires a fresh
  real summary request, and verifies durable `sampleAttempts: 2`

## [0.10.76] - 2026-08-23

### Added
- Goal verification now preserves bounded, sanitized structured feedback across
  continuations, compaction, process restarts, and subagent result adoption
- Verification gap state is projected through TUI, Headless JSONL, Web, and ACP

### Changed
- Repeated identical verifier gaps now request a strategy change on the second
  occurrence and atomically block the Goal on the third
- Goal edits, explicit resume, and a fresh verifier PASS clear stale
  verification-stall state

### Fixed
- Verifier feedback now replaces workspace roots, redacts common credential
  forms, escapes control markup, and remains capped at 4,000 characters
- Real API handoff qualification now preserves strict durable-boundary checks
  while tolerating bounded model correction turns and delayed TUI rendering

### Tests
- Added deterministic persistence, sanitization, convergence, projection, and
  crash-adoption coverage
- Qualified a real verifier FAIL-to-repair-to-PASS trajectory across DeepSeek,
  Claude, GPT, and Qwen, plus production Web, raw PTY, ACP, and the complete
  16-check production release matrix

## [0.10.75] - 2026-08-23

### Tests
- Give the intentional over-16 MiB SSE validation test an explicit timeout
  budget so full coverage instrumentation remains stable on constrained CI
  runners without changing the production response limit

## [0.10.74] - 2026-08-23

### Added
- Active Goals now detect conservative premature-stop patterns in the final
  assistant paragraph and persist only the pattern, consecutive count, and
  detection time
- Goal recovery state is projected through TUI status, Headless JSONL, Web SSE
  and DOM attributes, and ACP metadata

### Changed
- Goal continuations now issue an actionable recovery directive after a
  deferral or handoff, escalating to a strategy change after the second
  consecutive match

### Fixed
- Three consecutive matches of the same premature-stop pattern now atomically
  block the Goal, preventing unbounded continuation and token consumption
  without imposing a global continuation limit
- Normal progress and explicit Goal actions clear stale recovery state

### Tests
- Added deterministic classifier, persistence, prompt, lifecycle projection,
  and Web component coverage with false-positive controls
- Qualified autonomous recovery with real DeepSeek, Claude, GPT, and Qwen
  providers, production desktop/mobile Chromium, raw PTY rendering, and the
  complete 16-check production release matrix

## [0.10.73] - 2026-08-22

### Added
- Added config-gated Agent Teams across TUI, Web, and ACP with reusable
  `.blade/agents` and `.claude/agents` roles, durable team definitions, and a
  shared dependency-aware task graph
- Added atomic task claiming, automatic dependency unblocking, direct and
  broadcast durable mailboxes, and live `team.*` lifecycle projections
- Write-capable teammates now default to isolated worktrees, while nested team
  creation is rejected

### Changed
- Provider requests now run without implicit owner, global, or request-class
  concurrency limits unless explicit admission limits are configured
- Web Team schemas, transport, and translations load with the chat surface
  instead of increasing the initial bundle

### Fixed
- Teammate messages remain hidden from user chat while staying durable and
  available to the intended model context
- Team status is derived from authoritative agent sessions and task state, and
  disabled Agent Teams no longer produce failing Web requests

### Tests
- Added deterministic coverage for team lifecycle, ownership, task DAGs,
  mailbox delivery, HTTP routes, slash commands, ACP metadata, TUI state, Web
  state, and UI interactions
- Qualified DeepSeek Flash and Pro team coordination, production desktop/mobile
  Chromium, raw PTY rendering, and the complete production release matrix

## [0.10.72] - 2026-08-22

### Added
- Added `/btw <question>` side conversations to TUI, Web, and ACP, with
  dedicated transient loading, result, error, cancellation, and dismissal
  states
- Side questions reuse the current Session's model context and Provider prompt
  prefix while remaining single-turn and tool-free
- Added `POST /sessions/:sessionId/side-question` for the Web surface

### Fixed
- Side questions and answers never enter the main Session transcript, durable
  inbox, or later model context, and they do not interrupt or steer an active
  main turn
- Runtime disposal and surface navigation now cancel and drain in-flight side
  conversations

### Tests
- Added deterministic service, Runtime, HTTP, ACP, TUI, Web store, and component
  coverage, including byte-identical JSONL assertions
- Qualified real DeepSeek Runtime, GPT Web route, Claude ACP, DeepSeek PTY, and
  desktop/mobile Chromium flows with framework retries disabled

## [0.10.71] - 2026-08-22

### Fixed
- Workspace identity resolution now uses a 512-entry least-recently-used cache,
  preventing high-cardinality Web and ACP workspace traffic from retaining stale
  FIFO entries
- Canonical paths and symbolic-link aliases share one cache entry, and trust or
  revoke decisions explicitly refresh identity before selecting the Git common
  checkout root

### Tests
- Added high-cardinality eviction, cache-hit promotion, path-alias invalidation,
  and trust-decision topology refresh coverage
- Qualified the workspace trust boundary through real GPT runtime and MCP
  isolation trajectories

## [0.10.70] - 2026-08-22

### Fixed
- Retry, verification, delegation, and stale-loop continuations now persist the
  assistant response and host control prompt through one ordered JSONL path,
  preserving the parent UUID chain across resume
- Web task queue projections now read queue state from the durable Session
  snapshot instead of duplicating mutable values in the active run

### Changed
- Context management is now a thin `PersistentStore` facade, removing the
  unused in-memory context, cache, compression, and search model
- Provider admission accounting now uses one request-class counter structure
  for active streams, queued requests, and retained bytes
- Thinking mode, tool read-only status, and workspace trust are derived from
  their authoritative enum or configuration state instead of duplicated flags
- Durable recovery helpers reuse one materialized event projection per lookup

### Tests
- Added and updated continuation persistence, Provider admission, workspace
  trust, tool registry, and state projection coverage
- Qualified Provider admission through real DeepSeek Web and ACP sessions and
  workspace trust through real GPT sessions

## [0.10.69] - 2026-08-22

### Fixed
- The subagent session store now retains at most 256 inactive session sidecars
  in memory while pinning running sessions, preventing historical Task traffic
  from growing the long-lived Web and ACP process heap without bound
- Session cache hits refresh least-recently-used order, and full session scans
  retain the most recently active terminal sessions

### Tests
- Added terminal-session churn, disk reload after eviction, and active-session
  pinning coverage

## [0.10.68] - 2026-08-22

### Added
- Fallback model references can select a concrete model configuration with
  `configId`, allowing each fallback to use its own credentials, endpoint, and
  request overrides

### Fixed
- Pre-output Provider idle timeouts can switch to a different fallback
  Provider without retrying the stalled Provider
- Cross-Provider circuit breaking, request admission, and transport options now
  use the fallback channel identity instead of the primary channel
- Raw PTY qualification fails immediately when an authoritative durable final
  does not match the required output instead of waiting for the full timeout

### Tests
- Added a real Claude-timeout-to-GPT-fallback trajectory with independent
  channel credentials and strict no-primary-retry assertions
- Added fallback configuration, replay-boundary, admission-isolation, and PTY
  terminal classification coverage

## [0.10.67] - 2026-08-22

### Fixed
- Session event-log instances now use a bounded least-recently-used cache, so
  long-running Web and ACP processes do not retain every historical Session
  while active stream subscribers remain pinned

### Tests
- Added cache-capacity, least-recently-used eviction, and live-subscriber
  retention coverage for the unified Session event stream

## [0.10.66] - 2026-08-22

### Added
- Web now provides a multi-project task board with waiting, active, blocked, and
  review stages driven by durable task state and the global SSE feed
- Board tasks support local-workspace dispatch, project filtering, search,
  priority, task type, due dates, cancellation, retry, change inspection, and
  acceptance through archive
- Automatic task claiming can be paused without interrupting active work and
  resumed in FIFO order
- Task status, priority, kind, and due dates are projected into dedicated
  SQLite columns; task scans push status, priority, and due-time filters into
  indexed SQL while preserving equivalent JSONL fallback behavior

### Changed
- Web model selection defaults to a concrete supported reasoning effort instead
  of ambiguous `auto`, while preserving an explicit `off`
- Updated `pi-ai` to `0.84.2` so reasoning capabilities come from the provider catalog
- Compaction treats bounded `EXACT CONTINUATION RECORD` lines as a host-owned
  contract and restores them under canonical ledger headings

### Fixed
- Empty final responses after successful tools receive one durable correction
  and fail closed if the model remains empty
- Turn abort receipts atomically preserve input acknowledgements, successful
  tool evidence, and spent correction state across process restarts
- Structured output stays authoritative after a valid payload is committed at
  the output-token boundary
- Read-only verification sandboxes preserve the Session Node toolchain while
  keeping the workspace and home directory denied
- Test processes isolate and reclaim temporary roots and managed Git overlays
- Web task-start/final waits and ACP/Headless final projection observe the
  correct committed lifecycle boundary

### Tests
- Added release-blocking DeepSeek Flash/Pro token-budget handoff coverage across
  Headless, raw PTY, production Web Chromium, and ACP with framework retry 0
- Added deterministic coverage for exact-record reconciliation, empty-final
  recovery, abort receipts, ACP cleanup deadlines, and bounded diagnostics

## [0.10.65] - 2026-08-20

### Fixed
- Read-only verification agents now accept test, lint, type-check, and build
  commands whose output is bounded by a single numeric `head` or `tail`
  pipeline; Blade removes that projection before execution so the original
  command exit status remains authoritative
- Verification sandboxes can read and write their dedicated temporary cache while
  the source workspace remains read-only, and verifier guidance now substitutes
  no-write checks for build scripts that emit workspace artifacts
- Verification command admission continues to reject file-reading pipeline
  arguments, output-writing `tee` pipelines, redirects, and chained commands

### Tests
- Added verification command and permission-boundary regressions for safe
  output truncation, true exit-code preservation, unsafe pipeline variants,
  and native read-only sandbox temporary storage

## [0.10.64] - 2026-08-19

### Fixed
- LSP clients now ignore delayed process and JSON-RPC close events from disposed
  transport generations instead of reporting a clean shutdown as a crash or
  clearing the initialized state of a replacement server

### Tests
- Added deterministic transport-generation coverage proving a stale LSP child
  cannot mutate or fail a newly initialized connection

## [0.10.63] - 2026-08-19

### Fixed
- Vitest workers now create collision-free owned storage roots and remove them
  synchronously at test-file teardown instead of leaving PID-named state behind
- Explicitly supplied `BLADE_STORAGE_ROOT` directories remain caller-owned and
  are never removed by the test harness
- npm publish now uses Trusted Publishing (OIDC) and declares `repository`
  metadata so sigstore provenance verification succeeds

### Tests
- Added real child-process coverage proving owned roots disappear after natural
  worker exit while externally managed roots and their contents remain intact

## [0.10.62] - 2026-08-19

### Changed
- CLI Unicode code-point and string-width caches now use entry-count and
  retained-size LRU limits instead of permanently retaining every rendered
  non-ASCII string
- Syntax highlighting now enforces both its existing 200-line limit and a
  512K retained-character budget
- Oversized width inputs and code lines are still rendered but no longer
  admitted to process-wide caches

### Tests
- Added high-cardinality Unicode text churn, oversized input, cache reset,
  unique highlighted-line churn, and giant code-line residency coverage
- Re-ran the complete TUI platform UI suite across message rendering, Static
  ownership, input, hooks, workspace trust, and Session switching

## [0.10.61] - 2026-08-19

### Changed
- HookManager now keeps at most 64 non-current workspace and worktree
  configurations while active Sessions retain independent hook snapshots
- Workspace trust reviews now use a 64-entry LRU instead of permanently
  retaining every path inspected by a long-lived Web or ACP process
- Managed worktree transitions bind inherited hooks to the owning Session so
  workspace cache eviction cannot alter an active turn

### Fixed
- Session disposal now removes every dynamic hook config, pause alias, and
  transient worktree reference for the Session ID, not only its final paths
- HookManager cleanup now restores a reusable default state instead of retaining
  the current workspace config or process-wide disabled flag

### Tests
- Added project and trust cache churn, active Session snapshot survival, dynamic
  worktree eviction, full Session alias cleanup, and singleton reuse coverage

## [0.10.60] - 2026-08-19

### Changed
- Workspace agent catalogs now retain at most 32 idle workspaces with
  deterministic LRU eviction while protecting active and initializing entries
- Total active or initializing workspace catalogs are capped at 64, and Web
  requests receive retryable overload semantics before another catalog starts
- Plugin, skill, command, and subagent registries release evicted workspace
  generations by object identity, while active Sessions keep immutable snapshots

### Fixed
- Failed workspace catalog initialization no longer leaves partial registry
  generations resident
- Plugin lifecycle mutations now pin their workspace catalog across asynchronous
  refresh, install, policy, and reconciliation work
- Server shutdown releases workspace catalogs, and MCP/LSP plugin discovery no
  longer creates an otherwise unused workspace PluginRegistry

### Tests
- Added concurrent 64-workspace active-use and hard-cap coverage, idle LRU
  ordering, cross-registry reclamation, partial-failure cleanup, ABA protection,
  and plugin-hook generation restoration tests

## [0.10.59] - 2026-08-19

### Fixed
- Command admission gates now monitor their owning Blade process and terminate
  the full command group when that owner hard-exits, even if the control pipe
  remains open
- POSIX gates verify the direct parent relationship so PID reuse cannot keep an
  orphan command alive

### Tests
- Added a real-process regression that hard-kills a foreground command owner
  and proves the gate and its TERM-ignoring command self-reap without invoking
  the durable orphan reaper

## [0.10.58] - 2026-08-18

### Changed
- Removed the permanent per-config-directory instance table from the stateless
  Agent Team store, so workspace churn cannot retain arbitrary config paths

### Tests
- Added a cross-instance persistence contract proving fresh TeamStore facades
  share only durable team files and no process-local object identity

## [0.10.57] - 2026-08-18

### Changed
- Prompt-cache monitoring now retains tool identity and contract fingerprints
  only as SHA-256 values, including user-controlled MCP tool names
- Tool additions, removals, and contract changes are attributed by hashed
  identity without retaining the source schema between requests

### Tests
- Added direct retained-state privacy coverage alongside the existing
  attribution and bounded-Session tests
- Strengthened the real GPT cache trajectory to warm beyond Provider-shared
  prefix blocks before asserting cache-break attribution with framework retry 0
- Stabilized cross-process tool-admission evidence across non-atomic fixture
  marker transitions while preserving exact concurrency assertions

## [0.10.56] - 2026-08-18

### Added
- Prompt-cache breaks are now attributed to model, system prompt, tool schema,
  request policy, TTL, or likely Provider-side routing and eviction changes
- Web cache details, CLI `/cost`, and Headless JSONL expose the latest bounded
  cache-break attribution

### Changed
- Cache-break detection uses per-Session SHA-256 fingerprints without retaining
  prompt content or user-controlled tool names
- Detection uses adaptive token thresholds and resets its baseline across
  explicit compaction epochs to avoid false positives

### Fixed
- Provider tool-call identities now remain stable across live events, durable
  JSONL history, and Web reconnects instead of changing while a tool card is
  being rendered

### Tests
- Added deterministic attribution, TTL, compaction, privacy, and bounded-state
  coverage
- Added a real GPT trajectory that warms Provider cache, replaces every stable
  prompt block, and verifies system-prompt attribution with framework retry 0
- Re-qualified bounded foreground output across DeepSeek Flash/Pro and
  Headless/ACP/production Web reloads with framework retry 0

## [0.10.55] - 2026-08-18

### Fixed
- Agent Team members now preserve their shared `taskListId` through streaming
  and non-streaming tool execution instead of writing isolated Session lists
- Task and Team tools now use the same `BLADE_STORAGE_ROOT` as Session runtime
  state
- Task-list mutations reload the authoritative disk state while holding a
  cross-process lock, preventing stale overwrites and duplicate IDs
- Corrupt task-list state now fails closed instead of being replaced by an
  empty list

### Changed
- Task-list snapshots are written atomically with strict file permissions
- Task-list coordination no longer retains a process-wide manager per Session

### Tests
- Added deterministic same-process and real multi-process concurrency,
  crash-lock recovery, corruption, path-containment, and reclamation coverage
- Added release-blocking DeepSeek Flash/Pro Agent Team trajectories with four
  concurrent real-API teammate writers per model

## [0.10.54] - 2026-08-18

### Fixed
- Read-only verification agents can execute the host Node runtime when it is
  installed below the otherwise unreadable user home directory
- Verification sandbox environment merging preserves the allowlisted host
  `PATH` without exposing Provider credentials or Session environment values

### Tests
- Added deterministic sandbox environment coverage and a native Seatbelt
  integration test for bare `node` execution
- Re-qualified ACP model switching through the selected DeepSeek Pro model,
  including Edit, `node --test`, independent verification, and cleanup

## [0.10.53] - 2026-08-18

### Added
- CLI status bar now displays prompt cache hit rate (`Cache —` / `Cache XX%`)
- Web StatusBar displays cache hit rate with tooltip breakdown
- `/cost` slash command now includes cache read/write token breakdown
- `derivePromptCacheMetrics` and `formatPromptCacheHitRate` pure functions for unified cache telemetry
- i18n strings for cache status display (English and Chinese)

### Changed
- Improved prompt cache efficiency by stabilizing request prefixes:
  - Provider session key (`providerSessionId`) passed for cache continuity
  - Removed dynamic git/listing snapshots from system prompt
  - Tools, skills, and deferred tool lists now sorted deterministically
  - Enabled `cacheRetention: 'long'` for Provider-native caching
- Unified cache hit rate formula: `cacheReadTokens / inputTokens` (undefined when no Provider usage)
- Raised PTY evidence deadline from 180s to 270s for high-latency Providers
- Raised ACP fork stage timeout from 180s to 270s and model switch from 300s to 600s
- Raised unit suite wall-clock budget from 240s to 480s
- PTY and GPT cells filtered from release-blocking matrix under `REAL_API_RELEASE_MATRIX=1`

### Fixed
- Durable foreground/background process lifecycle tests hardened against host-load timing
- Session Runtime residency Web test cleanup now retries on `ENOTEMPTY` race
- Goal finalization preserves fresh verification receipt across recovery
- Bounded physical provider attempt deadline enforced correctly
- Keyed coordination state reclaimed deterministically without GC dependency
