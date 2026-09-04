# TUI Durable Task Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist TUI task completion attention across CLI restarts, render exact-session `NEW` state in `/resume` and the status bar, and clear it only after a successful exact Session open.

**Architecture:** Extend the read-only Session surface summary with a canonical terminal timestamp, then place a TUI-only, privacy-preserving acknowledgement ledger behind a serialized controller. `BladeInterface` owns the controller, reuses its complete catalog for resume/fork flows, projects state into Zustand, and acknowledges only committed local activation or a ready remote history view.

**Tech Stack:** TypeScript strict, React + Ink, Zustand, TypeBox, Node filesystem, `proper-lockfile`, `write-file-atomic`, Vitest, `bun-pty`, real DeepSeek API.

---

### Task 1: Project a stable terminal signature input

**Files:**
- Modify: `packages/cli/src/api/sessionSurfaceSchemas.ts`
- Modify: `packages/cli/src/context/storage/sqlite/projection.ts`
- Modify: `packages/cli/src/ui/utils/sessionActivation.ts`
- Test: `packages/cli/tests/unit/context/sqlite/projection.test.ts`
- Test: `packages/cli/tests/unit/services/session-surface-service.test.ts`
- Test: `packages/cli/tests/unit/platform/ui/utils/sessionActivation.test.ts`

- [ ] Add failing tests proving valid `taskCompletedAt` is projected for local and
  remote summaries, invalid legacy timestamps are omitted, and the local compatibility
  adapter preserves the field.
- [ ] Run the three test files and record RED caused by the strict surface schema
  stripping the field.
- [ ] Add optional bounded `taskCompletedAt` to `SessionSurfaceSummarySchema`;
  normalize with `Date.parse()` plus `toISOString()` in
  `projectSessionSurfaceSummaryFields()`; copy it in
  `toLocalSessionSurfaceSummary()`.
- [ ] Run the focused tests, CLI/Web type-check, Biome, and `git diff --check`.
- [ ] Commit as `feat(tui): expose task terminal signatures`.

Expected contract:

```ts
expect(summary.taskCompletedAt).toBe('2026-09-04T12:30:00.000Z');
expect(invalidSummary.taskCompletedAt).toBeUndefined();
```

### Task 2: Add the private cross-process attention ledger

**Files:**
- Create: `packages/cli/src/ui/services/TuiTaskAttentionStore.ts`
- Create: `packages/cli/tests/unit/platform/ui/services/TuiTaskAttentionStore.test.ts`
- Create: `packages/cli/tests/fixtures/tui-task-attention-writer.ts`

- [ ] Write RED tests for missing baseline, known non-terminal to completed/failed/
  interrupted, cancelled, same terminal signature, terminal-to-terminal change, exact
  acknowledgement, duplicate IDs across workspaces, parser bounds, deletion pruning,
  and stable newest-first catalog compaction.
- [ ] Implement a version-1 store at
  `<BLADE_STORAGE_ROOT>/tui-task-attention-v1.json`.
- [ ] Make the key a domain-separated SHA-256 digest of an explicit canonical locator
  tuple; never persist raw project paths, workspace refs, titles, prompts, results, or
  failure text.
- [ ] Serialize mutations through `KeyedMutexRegistry` and `proper-lockfile`, read after
  acquiring the file lock, and write with `write-file-atomic`, mode `0600`, under a
  `0700` directory.
- [ ] Keep failed writes/locks/reads as a bounded, ordered semantic mutation journal
  without coalescing reconcile transitions; replay it once over the next locked latest
  disk state. At 256 entries, become sticky fail-closed instead of dropping or
  reordering operations. Treat only `ENOENT` and explicitly
  invalid v1 content as empty; other I/O failures must not be written back as empty.
  Use a non-throwing `onCompromised` callback and prevent writes after compromise.
- [ ] Add a real two-Bun-process fixture proving concurrent exact entries are not lost.
- [ ] Reconcile acknowledged terminal entries by authoritative newest-first catalog
  order on every complete pass, retaining the latest 1,024 plus every protected
  null/unread entry. Repeat the same 1,025-entry catalog and add one newer terminal to
  prove the retained set is stable and admits the new latest entry.
- [ ] Deduplicate repeated locators by the first newest-first occurrence. Add tests for
  write-failure replay over a second writer's committed update, transient read failure,
  lock compromise, and bounded fixture timeouts/child cleanup.
- [ ] Run focused tests, type-check, Biome, and diff check; commit as
  `feat(tui): persist task attention`.

The public store interface is:

```ts
export interface TuiTaskAttentionSnapshot {
  readonly unreadKeys: readonly string[];
}

export class TuiTaskAttentionStore {
  reconcile(
    sessions: readonly SessionSurfaceSummary[],
    visibleLocator?: SessionLocatorV2
  ): Promise<TuiTaskAttentionSnapshot>;
  acknowledge(summary: SessionSurfaceSummary): Promise<TuiTaskAttentionSnapshot>;
  snapshot(): TuiTaskAttentionSnapshot;
}
```

### Task 3: Add serialized catalog reconciliation

**Files:**
- Create: `packages/cli/src/ui/services/TuiTaskAttentionController.ts`
- Create: `packages/cli/tests/unit/platform/ui/services/TuiTaskAttentionController.test.ts`

- [ ] Write RED tests for complete pagination, failed-page no-reconcile, dirty-bit
  follow-up refresh, close/late-completion fencing, process-local lifecycle events, an
  unref'd 30-second poll, and exact acknowledgement.
- [ ] Implement one owned `SessionSurfaceService`, one active refresh promise plus a
  dirty bit, one Bus subscription, one unref'd timer, and immutable listener snapshots.
- [ ] Never reconcile a partial catalog. A failed or aborted scan preserves the last
  known sessions and unread keys while reporting `error`.
- [ ] Run controller/store tests, type-check, Biome, and diff check; commit as
  `feat(tui): reconcile durable task attention`.

The controller interface is:

```ts
export interface TuiTaskAttentionState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly sessions: readonly SessionSurfaceSummary[];
  readonly unreadKeys: readonly string[];
}

export class TuiTaskAttentionController {
  start(): Promise<void>;
  listAll(): Promise<SessionSurfaceSummary[]>;
  acknowledge(summary: SessionSurfaceSummary): Promise<void>;
  setVisibleLocator(locator?: SessionLocatorV2): Promise<void>;
  subscribe(listener: (state: TuiTaskAttentionState) => void): () => void;
  close(): Promise<void>;
}
```

### Task 4: Wire exact acknowledgement into the TUI

**Files:**
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/store/slices/appSlice.ts`
- Modify: `packages/cli/src/store/selectors/index.ts`
- Modify: `packages/cli/src/ui/components/BladeInterface.tsx`
- Modify: `packages/cli/src/ui/components/SessionSelector.tsx`
- Modify: `packages/cli/src/ui/components/sessionSelectorModel.ts`
- Modify: `packages/cli/src/ui/components/ChatStatusBar.tsx`
- Modify: `packages/cli/src/ui/utils/slashCommandRouter.ts`
- Test: `packages/cli/tests/unit/platform/ui/components/session-selector-model.test.ts`
- Test: `packages/cli/tests/unit/platform/ui/ChatStatusBar.test.tsx`
- Test: `packages/cli/tests/unit/platform/ui/utils/slashCommandRouter.test.ts`
- Test: `packages/cli/tests/integration/cli/session-selector-fork.test.tsx`
- Test: `packages/cli/tests/integration/cli/session-history-surface.test.tsx`

- [ ] Add UI REDs for `[NEW] [DONE] <title>` in resume mode, no `[NEW]` in fork
  mode, `New tasks 2 · /resume` in the status bar, and no acknowledgement on selector
  cancel or failed activation.
- [ ] Add `taskAttentionStatus` and `taskAttentionUnreadKeys` to the TUI app slice,
  plus narrow selectors and one projection action. Keep durable I/O out of Zustand.
- [ ] Make `BladeInterface` own/start/close the controller and use its `listAll()` for
  startup continue, CLI resume/fork, and slash-command resume/fork.
- [ ] Acknowledge local resume only after `restoreSession` commits. Acknowledge remote
  resume only after `SessionHistoryController` publishes `ready` for the same locator.
  Do not acknowledge fork source selection.
- [ ] Render the selector marker and bounded status-bar count without showing task
  content in the status bar. Preserve unread state on a failed refresh and render one
  concise sync warning.
- [ ] Run all listed UI tests, the complete CLI integration suite, type-check, Biome,
  and diff check; commit as `feat(tui): surface durable task attention`.

### Task 5: Qualify the production raw-PTY lifecycle

**Files:**
- Create: `packages/cli/tests/support/tuiTaskAttentionPtyDriver.ts`
- Create: `packages/cli/tests/support/tuiTaskAttentionPtyRunner.ts`
- Create: `packages/cli/tests/integration/tui-task-attention.test.ts`
- Create: `packages/cli/tests/integration/real-api/tui-task-attention-trajectory.test.ts`
- Modify: `packages/cli/scripts/test-config.js`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`

- [ ] Add a deterministic raw-PTY RED: create a running local task Session, launch the
  production Node CLI long enough to persist its null baseline, exit, persist a
  terminal transition while absent, and relaunch with `--resume`. Require exact
  `[NEW]`, successful selection, and no marker on the third launch.
- [ ] Implement any missing production seams without weakening the user journey; rerun
  the deterministic raw-PTY test to GREEN.
- [ ] Add a release-gated trajectory for exactly `deepseek-v4-flash` and
  `deepseek-v4-pro`: dispatch one real task through the production server and a
  recording pass-through proxy, establish the TUI running baseline, miss completion,
  observe/open/clear exact `[NEW]`, and prove one upstream request, zero injection,
  framework/model retry `0`, bounded output, no credential leak, and complete cleanup.
- [ ] Register the new trajectory in `realApiQualification.files`, first recording the
  exact registry-test RED and then GREEN.
- [ ] Run the deterministic PTY test and zero-retry two-model real-API test; commit as
  `test(tui): qualify durable task attention`.

Exact commands:

```bash
bun run build:cli
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/tui-task-attention.test.ts
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/tui-task-attention-trajectory.test.ts
```

### Task 6: Document, review, verify, and release

**Files:**
- Modify: `docs/reference/remote-session-history-surfaces.md`
- Modify: `docs/en/reference/remote-session-history-surfaces.md`
- Create: `docs/testing/tui-durable-task-attention-evidence.md`
- Create: `docs/en/testing/tui-durable-task-attention-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] Obtain independent specification review first, then quality/security/concurrency
  review for the complete implementation. Resolve every Critical/Important finding
  and repeat the affected review.
- [ ] Document `[NEW]`, the status count, exact-open acknowledgement, first-load
  baseline, TUI-only ownership, failure degradation, deterministic PTY evidence, real
  Flash/Pro evidence, review verdicts, hashes, and limitations in both languages.
- [ ] Run `bun run format:check`, `bun run lint`, `bun run type-check`,
  `bun run build`, `bun run test:all`, `bun run test:coverage`, and
  `git diff --check`.
- [ ] Verify the next patch version is free locally, remotely, and on npm. Update only
  the CLI package version, both source changelogs, and bilingual docs; do not modify
  root `package.json`, `bun.lock`, `docs/changelog.md`, or
  `docs/en/changelog.md`.
- [ ] Push `main`, verify remote SHA, create/push an annotated tag, wait for
  `.github/workflows/publish.yml`, and verify workflow, npm `latest`/`gitHead`, GitHub
  Release, local/remote/tag SHA, and a clean worktree.
