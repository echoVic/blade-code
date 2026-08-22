# Bounded Session Runtime Residency Release Evidence

- Date: 2026-08-17
- Version: `blade-code@0.10.43`
- Design commit:
  `dad276fb453a8956e6dae6e90d8ddaf1f2eaf77b`
- Runtime and deterministic test commit:
  `8b6de70171791b0cf30da4ce35a1f1bfec1062f9`
- Lifecycle and real-API closure commit:
  `d67f99b82029a1aeb5b016ec133f39d36b1ec4f2`
- Qualified release metadata commit:
  `73118a506f0e13035dd6eccf86a856855f21e4e8`
- Final formatting commit:
  `d5269a1525bf139a910317d6f044884475ead2df`
- Final ACP shutdown-semantics commit:
  `e260f4bc1a9b60fb530876c88af192539c655dd6`
- Production command: `bun run qualify:production`
- Final Production Qualification log SHA-256:
  `67d8eb029c8a85f6270ea1612f499214bfcc95bf51868e4418c21efed625dad2`

## Result

Production Qualification ran from a clean
`e260f4bc1a9b60fb530876c88af192539c655dd6` worktree and passed all 16
checks.

- Unit: 3,252 passed, 1 skipped
- Integration: 172 passed
- CLI: 8 passed
- Headless runtime: 298 passed
- End-to-end: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 418 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 126 passed across 28 files

The release-blocking real-API suite completed in 2398.91s. The same
qualification type-checked and linted the CLI, VS Code extension, and Web
application, verified formatting, built production CLI/Web/VS Code artifacts,
and launched the pinned Playwright Chromium binary.

All eight Session Runtime residency target and non-interference cells passed
without a framework retry marker. The complete Production Qualification
contained two disclosed retry-assisted passes in pre-existing controls. Both
exact final-head cells passed separate `--retry=0` runs.

The final logs contained no credential-shaped literal, Authorization value, or
Bearer value.

## Closed Residency Gap

The Web controller and ACP agent previously retained initialized Session
Runtime graphs in process-wide maps for the lifetime of the server or ACP
connection. Durable Session storage was bounded independently, but inactive
initialized graphs could retain:

- Agent, Session Runtime, context, and transcript projections;
- MCP and LSP clients, task ownership, and executor catalogs;
- shell and subagent registries;
- Web event collectors, mutexes, and runtime projections;
- ACP filesystem and terminal contexts.

Creating many Sessions over a long-lived process could therefore grow resident
runtime state without a hard upper bound. The new residency manager owns both
initialized residents and initialization reservations, so concurrency cannot
cross the configured process boundary before expensive side effects begin.

## Reference Basis

The design was checked against:

- Codex residency control and thread lifecycle code for reserve-before-spawn,
  pending-plus-resident accounting, pinned LRU, identity-safe teardown, and
  bounded shutdown;
- Grok Build pool and soak-test code for idle TTL, in-use protection,
  generation-safe cleanup, and steady-state churn;
- Claude Code's single-foreground-Session ownership as a non-multiplexed
  control;
- Neovate's unbounded ACP Session map as a negative multiplexing control.

The implementation preserves Blade's durable Session model instead of copying
another product's lifecycle wholesale.

## Frozen Configuration

Both Web and ACP read one startup Store snapshot.

| Property | Minimum | Default | Maximum |
| --- | ---: | ---: | ---: |
| `maxResidentSessionRuntimes` | 1 | 32 | 256 |
| `sessionRuntimeIdleMs` | 30,000ms | 300,000ms | 3,600,000ms |

Only safe integers in the closed ranges are accepted. Zero cannot disable
either boundary. Project and Session-local configuration cannot override the
startup values. CLI flags expose:

```text
--max-resident-session-runtimes
--session-runtime-idle-ms
```

The Web idle sweep runs every 30 seconds, is unreferenced, and is cleared by
server shutdown. CLI/TUI/print/Headless own one root Runtime and do not enter
the multiplexed registry.

## Reservation And Ownership Invariants

`SessionRuntimeResidency` enforces:

```text
resident + reserved <= maxResident
```

Reservation occurs before Runtime, Agent, MCP/LSP, durable task, or worktree
side effects. A committed reservation starts pinned. Acquire/release updates
MRU order, and every Runtime operation keeps a lease for its ownership
interval.

Web may evict only an unpinned, evictable least-recently-used resident. ACP
uses the same hard capacity but sets `allowEviction=false`; users must close a
Session explicitly.

All removal paths compare the expected object identity. A stale completion
cannot delete or dispose a same-key replacement. Duplicate reservations are
deduplicated, cancelled reservations release capacity, and manager shutdown
closes admission before disposing residents.

Disposal failure is fail-closed. The resident becomes poisoned, continues to
consume capacity, cannot be acquired, and is not selected repeatedly for
automatic eviction.

## Evictability Contract

`SessionRuntime.isIdleForResidency()` returns true only when the Runtime is
initialized, is not disposing, and owns none of:

- active turn or turn owner;
- pending steering or durable input;
- attached executor catalog;
- running background shell;
- running background agent;
- unadopted terminal child completion;
- active MCP task.

Pins independently protect a Runtime while a Web request, run, or ACP
operation owns it. Idle TTL applies only to Web residents and reuses the same
evictability and identity checks as capacity eviction.

Eviction deletes only volatile Runtime, projection, and unlocked mutex state.
Durable Session metadata, transcript, inbox, Goal, task, permission, model,
and worktree state remain available for cold rehydration.

## Surface Semantics

### Web

When no safe candidate exists, Web returns:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Session runtime capacity is full",
    "details": {
      "resource": "resident_runtimes",
      "limit": 1
    }
  }
}
```

The production chat view renders the error inline. Rejected input produces no
Provider request and no half-created Runtime. Queued recovery defers on
capacity instead of persisting a terminal failure. After an idle eviction, a
follow-up reconstructs history from durable storage.

### ACP

ACP advertises the standard 1.3 close capability and implements
`session/close`. New, fork, and load reserve before Session or Runtime
initialization. Capacity failure retains the bounded message and typed JSON-RPC
data:

```json
{
  "resource": "resident_runtimes",
  "limit": 1,
  "retryable": true
}
```

ACP never silently evicts another Session. A successful close settles prompt
and user-shell ownership, disposes the exact Session graph, and immediately
reuses the slot.

Explicit `session/close` acknowledges the cancelled Session's durable pending
input so it cannot replay as a ghost turn. ACP connection or process shutdown
does not acknowledge that inbox; graceful and crash restart therefore retain
the existing automatic-resume contract.

## Deterministic Coverage

Focused tests cover:

- exact and one-over resident capacity;
- resident plus pending-reservation accounting;
- duplicate key, reservation cancel, and commit;
- pin, MRU/LRU order, and no-candidate rejection;
- Web-only capacity eviction and ACP no-eviction;
- exact idle-TTL boundary and sweep;
- poison-on-disposal-failure behavior;
- expected-identity and generation protection against ABA cleanup;
- shutdown and admission closure;
- 512-cycle create/evict/dispose steady state;
- every active/pending/shell/subagent/MCP/executor evictability blocker;
- startup config ownership, legal ranges, and CLI/config projections;
- typed Web and ACP capacity errors;
- standard ACP close and explicit-close inbox acknowledgement;
- connection-shutdown inbox preservation;
- reservation-before-side-effect and public-state privacy source gates.

The final clean-head unit suite passed 3,252 tests with one unrelated skipped
test. Integration, Headless, E2E, snapshot, security, Web, and performance
gates passed with the counts listed above.

## Real API Matrix

Every feature cell used:

- DeepSeek V4 Flash or DeepSeek V4 Pro;
- real Provider traffic through the configured endpoint;
- `maxResidentSessionRuntimes=1`;
- a loopback recording proxy where a rejection boundary was required;
- production build artifacts;
- exact process, socket, browser/terminal, HOME, storage, and workspace cleanup.

| Model | Surface | Result | Full-run duration | Framework retry |
| --- | --- | --- | ---: | ---: |
| Flash | production Chromium Web GUI | passed | 18.582s | 0 |
| Pro | production Chromium Web GUI | passed | 23.039s | 0 |
| Flash | real ACP stdio | passed | 17.637s | 0 |
| Pro | real ACP stdio | passed | 16.821s | 0 |
| Flash | production Headless control | passed | 10.188s | 0 |
| Pro | production Headless control | passed | 15.032s | 0 |
| Flash | raw PTY TUI control | passed | 31.502s | 0 |
| Pro | raw PTY TUI control | passed | 52.524s | 0 |

The Web cells proved active overflow, typed HTTP 429, zero rejected-marker
Provider traffic, slot reuse, idle LRU eviction, and durable cold-rehydrate
follow-up through the production GUI.

The ACP cells proved capacity rejection before Provider/storage side effects,
typed error data, standard close, immediate slot reuse, and a later load
follow-up from the durable transcript.

Headless and raw PTY cells completed real coding tasks at resident limit one
without a false `resident_runtimes` failure. They prove the multiplexed
boundary does not narrow normal single-root coding.

## Retry Disclosure

The complete Production Qualification passed 126/126 real-API tests but
contained two retry-assisted passes:

```text
bounded fair tool admission, DeepSeek Flash Web: retry x1
weighted background rejection, DeepSeek Pro raw PTY: retry x1
```

Neither is a Session Runtime residency target. They are disclosed rather than
reported as a zero-retry full run.

The exact final-head Web control passed 1/1 with `--retry=0` in 14.591s. Its
log SHA-256 is:

```text
58709c97e03418d662c65c036d7da9f3ab28436439e7e54108ff7aa46d5884a1
```

The exact final-head raw-PTY control passed 1/1 with `--retry=0` in 87.410s.
Its log SHA-256 is:

```text
bc06af5ea07bccf56bcc271dda647394672aaf9aa0b319bf27efe8496d012772
```

Neither exact log contains a retry marker. Business-level Provider retry and
recovery tests remain release-blocking and passed; they are not framework
retries.

## Release Boundary

The exact qualified implementation is
`e260f4bc1a9b60fb530876c88af192539c655dd6`.

The next commit may add only this evidence file. The annotated `v0.10.43` tag
must contain no unqualified runtime, test, configuration, version, lockfile,
changelog, or user-documentation change.
