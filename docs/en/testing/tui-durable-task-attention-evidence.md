# TUI Durable Task Attention Qualification Evidence

- Date: 2026-09-04
- Target version: blade-code@0.10.133
- Baseline: v0.10.132 / `3daf2f93ddcb89bfcdfc17a4f79c7fbb6fbda188`
- Qualified implementation: `4c5ace5a`
- Framework retry: 0
- Provider model retry: 0

## Result

Blade TUI now maintains an independent, private, and bounded durable attention
ledger for known background tasks. When a known running Session reaches
`completed`, `failed`, or `interrupted` while the TUI is absent, `/resume` shows
`[NEW]` and the status bar shows `New tasks N · /resume`. The terminal signature
is acknowledged only after the exact Session opens successfully. Cancelling the
selector, opening a same-ID Session from another project, or forking the source
does not clear it.

Historical terminal Sessions seen for the first time become a silent baseline,
and `cancelled` does not create attention. TUI and Web acknowledgement state are
separate. The TUI ledger stores only canonical terminal signatures, acknowledgement
state, and SHA-256 locator digests. It stores no prompts, model output, failure
text, raw remote paths, or raw workspace references.

## Deterministic coverage

### Projection, persistence, and coordination

- The shared Session surface projection accepts only canonical UTC
  `taskCompletedAt` values.
- SQLite, JSONL fallback, and the local compatibility adapter use the same
  normalization boundary.
- The private v1 ledger uses a cross-process lock and atomic replacement. Failed
  mutations enter an ordered journal capped at 256 entries and replay against the
  newest disk state after recovery.
- Read terminal entries follow complete newest-first catalog retention. Nonterminal
  and unread entries are protected from ordinary capacity pruning. Lock compromise,
  read/write failures, and post-write chmod failures retain explicit commit-point
  semantics.
- The controller reconciles only after a complete catalog. Refresh, acknowledgement,
  and visibility mutations are serialized with dirty follow-up, event/poll refresh,
  close draining, and listener isolation.

### TUI lifecycle

- React/Ink lifecycle ownership remains singular across StrictMode replay.
- Startup, ordinary new Sessions, continue fallback, local resume, remote history,
  and fork use explicit proven-visible and exact-acknowledgement boundaries.
- The Session selector labels only its current page and uses a memoized unread set
  for `[NEW]`.
- The status bar shows the unread count. `Task sync unavailable` preserves existing
  state instead of falsely clearing it.

~~~text
Task 1 focused projection/schema tests: 80 passed
Task 2 store tests:                     36 passed
Task 3 controller + store tests:        58 passed
Task 4 focused TUI tests:              148 passed
Task 4 CLI integration tests:           15 passed
~~~

## Production raw PTY

The deterministic test uses real `bun-pty` and production `dist/blade.js`:

1. The first launch observes a running Session and persists
   `signature=null, unread=false`.
2. After the TUI exits, the same Session becomes terminal and receives an exact
   persisted assistant marker.
3. The second `--resume` observes `[NEW] [DONE]`, selects the exact Session, opens
   the transcript with a real `Ctrl+O`, and verifies the terminal content.
4. The third `--resume` proves the Session remains listed and `[NEW]` is gone.

The suite also covers a rejected completion callback, a callback that never settles,
and an outer runner deadline. Every failure path performs bounded `TERM → KILL`
cleanup and proves the runner PID was reclaimed. Complete stdout/stderr is checked
before JSON parsing; stream latches detect credentials split across chunks or rolled
out of the retained tail. Runner environments remove API-key, token, secret,
password, and credential variables.

~~~text
deterministic raw PTY: 4 passed
qualification contracts: 27 passed
CLI integration through unified prebuild entry: 15 passed
~~~

## Real API qualification

~~~bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/tui-task-attention-trajectory.test.ts
~~~

~~~text
Tests  2 passed | 1 skipped gate placeholder
Flash  15.033s
Pro    16.712s
Total  33.26s
~~~

Both models create a task through production `dist/blade.js serve`. The recording
proxy delays and forwards the single real Provider request without generating or
replacing its response. Each trajectory asserts framework retry 0, model
`maxRetries=0`, forwarded requests `[1]`, no injection, and
`upstream_started → headers_received → body_completed`. The task then persists as
completed with `taskCompletedAt` and the exact assistant marker before the three
production TUI launches verify the attention lifecycle.

Health, task dispatch, and terminal polling use separate HTTP deadlines. The
terminal, completion, driver, and test budgets are 180, 190, 300, and 360 seconds,
respectively, leaving explicit teardown headroom.

## Build and test isolation

For every suite that needs production `dist`, `scripts/test.js` performs one fresh
build before starting any Vitest child. Non-coverage `test:all` runs
`build → !performance → performance`; coverage runs `build → !performance`. Test
workers never write the shared `dist`, avoiding partially built reads across parallel
projects.

## Repository gates

~~~text
format:check  PASS — 1,568 files
lint          PASS — CLI 1,366 files, Web 200 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS
test:all main 480 files passed, 96 skipped
              5,587 tests passed, 86 skipped, 304.24s
performance   4 files passed, 1 skipped
              9 tests passed, 1 skipped, 5.31s
coverage      480 files passed, 96 skipped
              5,587 tests passed, 86 skipped, 331.06s
              statements 73.49%, branches 66.91%
              functions 75.37%, lines 74.83%
git diff      PASS
~~~

The first complete `test:all` run exposed that the new raw-PTY runner had not
been added to the global marker-latching inventory. After registering the runner
and its `[NEW]` latch contract, the focused inventory suite passed 65/65 and a
fresh complete `test:all` run passed. The build emitted only the existing stale
Browserslist-data and >500 KiB chunk warnings.

## Final review

- Final specification review: PASS, Critical 0 / Important 0.
- Final quality, security, and authenticity review: APPROVED, Critical 0 / Important 0.
- Review confirmed the production server and TUI, pass-through Provider, zero-retry
  boundary, bounded diagnostics, credential isolation, and fail-closed process
  cleanup.

## Final source hashes

~~~text
sessionSurfaceSchemas.ts                 c4b85e02884ae251ae0818b8dbad1dfef2ccb31f162ec1b7b3e7985cdecbfa78
TuiTaskAttentionStore.ts                 a241f9cbeccea068f99f162f4436ef58359b70ac90fb5863bd80db10473ed9f9
TuiTaskAttentionController.ts            ad35d78d310956db490b499d8453b528b3fc883db2a22ccbe159951c7b7c6d5d
TuiTaskAttentionLifecycle.ts             d71d7a4546ed38a052d53ae2f7e5d7f6c215e9cc6e7c69765e2823cebca2451c
SessionHistoryLifecycle.ts               2aebe0b8dd562e82de8e444a9267439693b4dd56172a853360b36e85c3fbec4b
BladeInterface.tsx                       1b9daefaa2b7012535ccf4e55079a4e8e786666271f95664a75e0216dbb45b2c
sessionSelectorModel.ts                  d0c4310a58c06882aa84d243f9de7129cf010f7ca545281251675f75a9944b88
tuiTaskAttentionPtyDriver.ts             c296b8de72eb94e0a8b7c1f4abe06c0f83bc5a1ea489582ea50744036a0fac88
tuiTaskAttentionPtyRunner.ts             537400cb6abfc7833b5ca9f1434385cc0a83ccd3ea1b15dfc2f0928440ca15e6
tui-task-attention-trajectory.test.ts    c7b1f458950737a74f3909469a620b4dc8861bc91717ba671f60abd1a581b282
~~~

## Boundaries

- This attention state belongs to the TUI and does not share acknowledgement with
  the Web unread ledger.
- Raw PTY qualification is explicitly skipped on Windows; existing cross-platform
  smoke tests still cover Windows.
- A screenshot is not the success oracle. Selector markers, exact Session activation,
  transcript content, ledger state, Provider request lifecycle, and process
  reclamation form the evidence.
- No Provider credential or raw model response was printed, persisted, or committed.
