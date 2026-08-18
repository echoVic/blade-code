# Changelog

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
