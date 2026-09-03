# Remote Session Surface Identity Qualification Evidence

## Release candidate identity and scope

- Design: `docs/superpowers/specs/2026-09-02-remote-session-surface-identity-design.md`
- Plan: `docs/superpowers/plans/2026-09-02-remote-session-surface-identity.md`
- Baseline: `v0.10.128`
- Target version: `0.10.129`
- Final code candidate: `2fa1cc1d582594ec977fa0136319960406065c13`
- Candidate range: `v0.10.128..2fa1cc1d`, containing `36` design, implementation, fix, and qualification commits
- Qualification date: `2026-09-02`

This evidence covers one unified, read-only, bounded Session history surface for
listing, opening, paging, and forking local and ACP remote history from the Web
GUI and terminal TUI. A remote locator contains only an opaque public workspace
reference. The canonical remote working directory is display-only.

The public reference, catalog capabilities, and `displayCwd` are never treated
as execution authority. Remote open and fork re-resolve durable identity and
return only allowlisted history messages.

## Commit responsibilities

| Task | Commits | Responsibility |
| --- | --- | --- |
| Design | `3dad8ab6`, `eb282074`, `3c81ba84`, `c0a171dc` | Freeze identity, lifecycle, GUI/TUI, and execution-plan contracts |
| 1 | `a03ca569`, `d247e065`, `eccdfe25` | Define and tighten V2 locator, capability, message, request/response, and error schemas |
| 2 | `63a28916`, `7f1f725c` | Persist random public references inside protected remote scopes and harden crash-safe publication |
| 3 | `33012577`, `e2ce840b` | Project exact generation-current owner state and fence teardown |
| 4 | `3786d10c` | Add the strict message projector and bounded cursor/snapshot registry |
| 5 | `15f5313c` | Add bounded catalog/history reads to the schema-v7 disposable SQLite projection |
| 6 | `eb6dd8db` | Add lifecycle-owned `SessionSurfaceService` and JSONL fallback |
| 7 | `802bd49b` | Add isolated `/sessions/v2` Hono routes and graceful shutdown ownership |
| 8 | `610e98bb` | Reject protected remote roots at V1 Session, suggestions, and terminal boundaries |
| 9 | `e55f6c77` | Add the Web V2 client, opaque navigation, and isolated history store |
| 10 | `962d599c` | Add the Web remote-history GUI and two-layer action gates |
| 11 | `67750dfb` | Add the TUI remote selector, history viewer, and owned controller |
| 12 | `3daefa82`, `d3ab622a`, `a1ccc071` | Add the paired-ACP fixture, repair surface path redaction, and qualify production GUI/TUI behavior |
| Review closure | `fd7be712`, `8c4c39b0`, `626085d2`, `2a270f18`, `d219be8d`, `c44555ce`, `6a9b63f0`, `b6143a65`, `7d41ccc2`, `2a1d6f46`, `27e243e7`, `94833144`, `2765bcc8`, `2fa1cc1d` | Tighten Session and lineage IDs, Win32 path redaction, rotated locators, GUI/TUI history windows, request bodies, local service and persisted-source boundaries, and lexical plus canonical suggestion-path containment |

## Direct security evidence

| Requirement | Direct evidence | Result |
| --- | --- | --- |
| Locator contains no private path or descriptor | TypeBox negative tests plus Chromium response, DOM, URL, console, and server-log canary scans | PASS |
| Public reference is stable and protected | Mode, symlink, concurrency, restart, rotation, transplant, corruption, and capacity tests | PASS |
| Mixed catalog is stable and bounded | SQLite epoch/revision, semantic digest, JSONL frozen snapshot, and cursor replay tests | PASS |
| History is allowlisted and bounded | Strict message schema, `limit + 1` SQLite query, `256 KiB` message, and `512 KiB` page tests | PASS |
| Remote open/fork creates no live authority | Spies around production Runtime, Agent, SSE, Browser, filesystem, Git, hook, plugin, skill, and PTY constructors or calls | PASS |
| Web history-only mode fails closed | Component/store/direct-handler tests plus Chromium request and WebSocket assertions | PASS |
| TUI preserves the live local Session | Real Ink stdin/stdout, store identity, activity-count, and source-transcript assertions | PASS |
| Owner state cannot transfer | Duplicate Session ID, exact identity, collision-only, and stale-generation tests | PASS |
| Local and ACP-local parity | V1 route, local activation, Web, TUI, and fork regression suites | PASS |

A public history message contains only an opaque ID, a `user` or `assistant`
role, content, timestamp, and optional `truncated` flag. Metadata, reasoning, tool
calls and results, raw attachments, host roots, descriptor identities, and raw
event fields never enter the surface. The canonical remote `displayCwd` is the
only intentionally public remote path field. It is not included in the locator
or URL and is not consumed by any file, terminal, or execution entry point.

## Focused deterministic qualification

### Core, service, and route matrix

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit --maxWorkers=1 \
  tests/unit/integrations/api/session-surface-schemas.test.ts \
  tests/unit/integrations/api/schemas.test.ts \
  tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts \
  tests/unit/services/session-surface-projection.test.ts \
  tests/unit/services/session-surface-cursor-registry.test.ts \
  tests/unit/services/session-surface-service.test.ts \
  tests/unit/context/sqlite/projection.test.ts \
  tests/unit/agent-runtime/server/session-surface-routes.test.ts \
  tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts \
  tests/unit/agent-runtime/server/session-ref.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/agent-runtime/server/session-fork-routes.test.ts \
  tests/unit/agent-runtime/server/suggestions-routes.test.ts \
  tests/unit/agent-runtime/server/terminal-routes.test.ts \
  tests/unit/integration/session-surface-qualification-harness.test.ts
```

Result: `16` files and `426/426` tests passed, exit `0`. An earlier parallel
attempt had one intermittent failure in unchanged sources in the real
two-process 1,024-capacity race. That exact case then passed three consecutive
standalone runs, and the complete matrix above passed with one worker.

### Focused TUI matrix

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=cli \
  tests/integration/cli/session-history-surface.test.tsx \
  tests/integration/cli/session-selector-fork.test.tsx
```

Result: `2` files and `8/8` tests passed, exit `0`. These tests use the real Ink
input router and typed stdin/stdout streams. They cover remote selection, paging,
search, copy, fork, close, late-completion fencing, and preservation of the exact
local Session object.

### Focused Web matrix

```bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/sessionIdentity.test.ts \
  tests/store/session/sessionNavigation.test.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/components/layout/Sidebar.test.tsx \
  tests/components/layout/Layout.test.tsx \
  tests/components/chat/ChatView.test.tsx \
  tests/components/chat/ChatInput.test.tsx \
  tests/components/preview/FilePreview.test.tsx \
  tests/components/tasks/TaskArtifactBar.test.tsx \
  tests/App.test.tsx
```

Result: `11` files and `298/298` tests passed, exit `0`. Coverage includes merged
catalog rendering, opaque locator navigation, sibling history state, generation
fencing, refresh restoration, remote badges, disabled or hidden controls, and
direct-handler fail-closed behavior.

## Production GUI, TUI, and real Provider qualification

Final release cell:

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
  bun x vitest run --config vitest.config.ts --project=real-api --retry=0 \
  --reporter=verbose \
  tests/integration/real-api/session-surface-history-trajectory.test.ts \
  tests/integration/real-api/session-surface-tui-trajectory.test.tsx
```

Result: `2` files and `4/4` tests passed, exit `0`, total duration `23.84s`. The
framework retry budget was `0`, and the fixture enforced model `maxRetries=0`.

| Surface | Model | Duration | Direct assertions |
| --- | --- | ---: | --- |
| Production Chromium GUI | `deepseek-v4-flash` | `6.412s` | Merged local/remote catalog, offline/history-only banner, canonical cwd, paging, loaded-page search, fork, refresh, unchanged local Session, and network/privacy scans |
| Production Chromium GUI | `deepseek-v4-pro` | `7.573s` | Same assertions |
| Real Ink TUI | `deepseek-v4-flash` | `2.601s` | Selector, paging, search, copy, fork, close, unchanged local Session identity, and stdout/stderr privacy scans |
| Real Ink TUI | `deepseek-v4-pro` | `2.812s` | Same assertions |

For each model, the fixture first created a real remote transcript through the
production `BladeAgent` and paired ACP NDJSON, then disconnected its owner. The
GUI launched production `dist/blade.js serve` and Playwright Chromium. Provider,
remote-file, and remote-terminal activity counts remained unchanged while the
history actions ran, and source transcript bytes remained unchanged. No second
Provider request or history-only file, terminal, Browser, review, or message-write
request was observed.

The TUI qualification directly drove real Ink input/output and production
`SessionSurfaceService`; it did not mock Agent, Runtime, ACP connection,
SessionService, or Provider. This cell did not spawn a production raw PTY or use
desktop computer-use, so the evidence claims real Ink input and state transitions,
not desktop visual automation.

Chromium screenshots were supporting runtime assertions and were deleted when
each test completed. Fixture references were revoked after each callback and all
temporary state was removed under a cleanup deadline. No raw screenshot, remote
transcript, path, descriptor, or credential was persisted.

## Full repository gates and coverage

- `bun run format:check && bun run lint && bun run type-check && bun run build`:
  all exited `0`. Build output contained only the existing stale Browserslist
  data and greater-than-`500 kB` chunk warnings.
- `bun run test:all`: exit `0`. Main phase: `474` files passed / `94` skipped,
  `5472` tests passed / `84` skipped, duration `321.20s`. Performance phase:
  `4` files passed / `1` skipped, `9` tests passed / `1` skipped, duration `5.29s`.
- `CI=true bun run --filter blade-code test:coverage`: exit `0`; `474` files
  passed / `94` skipped, `5472` tests passed / `84` skipped, Vitest duration
  `484.79s` and wrapper duration `487.84s`. Total coverage: statements `73.38%`,
  branches `66.79%`, functions `75.34%`, lines `74.71%`.
- The planned Web command from `packages/cli/web` exposed an existing dependency
  mismatch before test collection: workspace-local `vitest 3.2.7` resolved the
  root `@vitest/coverage-v8 4.1.10` provider and threw `Class extends value
  undefined`. Dependencies and the lockfile were left unchanged. The already
  installed, matching root `vitest 4.1.10` then ran the same config and complete
  collection:

```bash
cd packages/cli/web
CI=true ../../../node_modules/.bin/vitest run --config vitest.config.ts --coverage
```

Result: `66` files and `591/591` tests passed in `10.27s`, with an explicitly
captured exit code of `0`. Total Web coverage was statements `72.83%`, branches
`64.73%`, functions `71.62%`, and lines `75.66%`.
`src/components/history` reached `91.42% / 74.13% / 95.83% / 96.72%`. This is
complete Web-source coverage; the original wrapper/provider compatibility error
is not described as a test failure. The tag-triggered CI coverage job must still
pass before publication is accepted.

## Bounded artifact hashes

These SHA-256 values pin the qualification harness and trajectory sources. They
contain no credential, raw remote content, descriptor, or workspace reference:

| Artifact | SHA-256 |
| --- | --- |
| `tests/support/acp/remoteFilesystemQualification.ts` | `c5c258f11ec87aa31b16b3b92b5d0070cf4cdd54d2d22ffdb51871acf6abd9bf` |
| `tests/support/launch-session-surface-gui.ts` | `695c5b8d2614b6e33fbd8a5d2f90c270c8f4ccbb4d09860ca0b2a016d0f54c84` |
| `tests/integration/real-api/session-surface-history-trajectory.test.ts` | `2fc2dc0173ca521efab66ae7b4f2ed00d537b1cf04816ae359d7f84b16b4b754` |
| `tests/integration/real-api/session-surface-tui-trajectory.test.tsx` | `195d8a0f87b30bf79dd8b709ac2f6be42ea3d09f47074f5d36740ab0bd46602b` |
| CLI `coverage-final.json` (`14,469,522` bytes) | `7c79ee7c48789e421399ce5d1385c2a9dcb91106564d4096d2971e0f6e8cc184` |
| Web `coverage-final.json` (`3,108,086` bytes) | `fe3dc95f966bb293231504d694c218629df861576b055dddf804ca3237034c07` |

The fixture also computes canonical SHA-256 digests for Provider requests, the
remote-filesystem sequence, assistant output, and transcript while exposing only
digests, counts, and booleans to assertions. Those values are not echoed into
logs, avoiding persistence of content-derived identifiers. Coverage files remain
in ignored directories for local review and are not part of the release commit.

## Independent review

Independent specification and quality/security/concurrency reviewers both
reviewed the exact committed candidate
`2fa1cc1d582594ec977fa0136319960406065c13` against the peeled `v0.10.128`
baseline. Both returned `APPROVED` with no Critical, Important, or Minor findings.
The quality reviewer also reran focused suggestion, plugin, projection, service,
TUI, and route tests plus `git diff --check`.

## Limitations and post-tag gate

- This release does not start remote Agent turns from Web/TUI and does not add a
  remote file browser or editor, ACP command console, remote PTY, remote Browser
  control, or remote code review.
- Owner discovery is process-local. A public workspace reference is not an
  authentication or execution credential.
- JSONL fallback is bounded to `10,000` rows and `16 MiB` per chain. The cursor
  registry is bounded to `2,048` entries, `64` chains, `32` cursors per chain,
  `64 MiB` of frozen snapshots, and a `10`-minute idle TTL. Capacity exhaustion
  fails closed.
- Publication still requires the annotated `v0.10.129` tag to trigger
  `publish.yml`, followed by verification of local HEAD, `origin/main`, local and
  remote peeled tag SHA, workflow `headSha`, npm `version/gitHead/latest`, the
  GitHub Release, and a clean worktree.
