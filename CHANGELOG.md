# Changelog

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
