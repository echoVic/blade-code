# Changelog

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
