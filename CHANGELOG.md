# Changelog

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
