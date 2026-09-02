# Remote Session Surface Identity And History UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship `v0.10.129` with one safe local/ACP-remote Session history surface that Web and TUI can list, open, page, and fork without exposing private host state or creating remote execution authority.

**Architecture:** Introduce a strict V2 public locator and message projection, persist a random public reference inside each protected remote state scope, and resolve every operation through a lifecycle-owned `SessionSurfaceService`. A rebuildable SQLite projection supplies stable merged catalog and bounded history pages; opaque in-memory cursors bind pages to an epoch/revision or transcript snapshot. Web and TUI consume the same contract but keep remote history in isolated read-only state, never adapting it to the existing path-based interactive Session state.

**Tech Stack:** TypeScript strict mode, TypeBox runtime schemas, Hono, SQLite projection, React/Zustand/Vite, React Ink, Vitest, Playwright Chromium, paired ACP NDJSON, and real DeepSeek Provider qualification.

**Design:** `docs/superpowers/specs/2026-09-02-remote-session-surface-identity-design.md`

**Constraints:** Work directly in the primary checkout. Do not create a worktree. Use `apply_patch` for edits. Do not add `any`, `as any`, `as never`, TypeScript suppressions, lint suppressions, or partial mocks of core runtime objects. Preserve V1 local and ACP-local behavior. Do not implement remote file browsing, remote file editing, an ACP command console, or a remote PTY in this release.

---

## File ownership map

New focused modules:

- `packages/cli/src/api/sessionSurfaceSchemas.ts`: strict public V2 schemas.
- `packages/cli/src/acp/AcpRemoteWorkspaceReference.ts`: protected random public-reference sidecars.
- `packages/cli/src/services/SessionSurfaceCursorRegistry.ts`: bounded opaque catalog/history cursor state.
- `packages/cli/src/services/sessionSurfaceProjection.ts`: pure whitelist message projection and redaction.
- `packages/cli/src/services/SessionSurfaceService.ts`: lifecycle-owned locator resolution and list/open/history/fork orchestration.
- `packages/cli/src/server/routes/sessionSurface.ts`: Hono parsing and typed error/status mapping.
- `packages/cli/web/src/store/session/slices/historySurfaceSlice.ts`: Web history-only state and request generations.
- `packages/cli/web/src/components/history/SessionHistorySurface.tsx`: Web read-only history presentation.
- `packages/cli/src/ui/components/SessionHistoryViewer.tsx`: TUI read-only history presentation.
- `packages/cli/src/ui/services/SessionHistoryController.ts`: TUI service ownership, pagination, and cancellation.

Existing large modules remain coordinators. Do not fold the new implementation into `SessionService.ts`, `server/routes/session.ts`, `BladeInterface.tsx`, or the Web `sessionSlice.ts` beyond narrow delegation points.

---

### Task 1: Add strict public Session-surface schemas

**Files:**
- Create: `packages/cli/src/api/sessionSurfaceSchemas.ts`
- Modify: `packages/cli/src/api/schemas.ts`
- Create: `packages/cli/tests/unit/integrations/api/session-surface-schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests that parse both locator variants and a complete surface summary, then reject forbidden remote fields:

```ts
const remoteLocator = {
  version: 2,
  sessionId: 'remote-session',
  workspace: {
    kind: 'acp-remote',
    workspaceRef: 'acp-remote-workspace:' + 'A'.repeat(43),
  },
} as const;

expect(SessionLocatorV2Schema.parse(remoteLocator)).toEqual(remoteLocator);
expect(() => SessionLocatorV2Schema.parse({
  ...remoteLocator,
  projectPath: '/private/state',
})).toThrow();
expect(() => SessionLocatorV2Schema.parse({
  ...remoteLocator,
  workspace: { ...remoteLocator.workspace, wirePath: 'C:/Repo' },
})).toThrow();
expect(() => SessionSurfaceMessageSchema.parse({
  id: 'surface-message:1:abc',
  role: 'assistant',
  content: 'visible',
  timestamp: '2026-09-02T00:00:00.000Z',
  metadata: { hostStateRoot: '/private/state' },
})).toThrow();
```

Also cover every capability enum and fixed error code, including
`invalid_session_surface_request` and `session_surface_unavailable`, limits
`1`/`50`/`100`, rejection of `0`/`101`, and `additionalProperties: false` at
every object level.

- [ ] **Step 2: Run causal RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/integrations/api/session-surface-schemas.test.ts
```

Expected: FAIL because `SessionLocatorV2Schema` and surface schemas do not exist.

- [ ] **Step 3: Implement schemas in the dedicated module**

```ts
const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const SessionLocatorV2Schema = Runtime(Type.Union([
  StrictObject({
    version: Type.Literal(2),
    sessionId: Type.String({ minLength: 1 }),
    workspace: StrictObject({
      kind: Type.Literal('local'),
      projectPath: Type.String({ minLength: 1 }),
    }),
  }),
  StrictObject({
    version: Type.Literal(2),
    sessionId: Type.String({ minLength: 1 }),
    workspace: StrictObject({
      kind: Type.Literal('acp-remote'),
      workspaceRef: Type.String({
        pattern: '^acp-remote-workspace:[A-Za-z0-9_-]{43}$',
      }),
    }),
  }),
]));
```

Define and export the capability, summary, strict message, catalog page, history page, open/history/fork request, open response, and fixed error-envelope schemas. Re-export their `Static<>` types from `schemas.ts`.

- [ ] **Step 4: Run GREEN and static checks**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/integrations/api/session-surface-schemas.test.ts tests/unit/integrations/api/schemas.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/api/sessionSurfaceSchemas.ts src/api/schemas.ts tests/unit/integrations/api/session-surface-schemas.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/api/sessionSurfaceSchemas.ts packages/cli/src/api/schemas.ts packages/cli/tests/unit/integrations/api/session-surface-schemas.test.ts
git commit -m 'feat(api): define session surface contracts'
```

---

### Task 2: Persist random public references inside protected remote scopes

**Files:**
- Create: `packages/cli/src/acp/AcpRemoteWorkspaceReference.ts`
- Modify: `packages/cli/src/acp/AcpRemoteWorkspace.ts`
- Modify: `packages/cli/src/context/storage/pathUtils.ts`
- Create: `packages/cli/tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/remote-workspace.test.ts`

- [ ] **Step 1: Write failing sidecar contract tests**

Use real temporary storage roots and branded scopes. Cover random shape, absence of path/identity substrings, stable rereads, concurrent create convergence, distinct exact identities in one collision scope, `0700` directory and `0600` file modes, symlink/mode/owner/extra-key/digest/transplant/duplicate corruption, missing-sidecar rotation, the `1024` binding cap, and redacted errors. Inject deterministic random bytes only through a test seam.

- [ ] **Step 2: Run causal RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts tests/unit/agent-runtime/acp/remote-workspace.test.ts
```

Expected: FAIL because the sidecar and protected child-directory APIs do not exist.

- [ ] **Step 3: Implement the protected reference store**

```ts
export type AcpRemoteWorkspacePublicRef = `acp-remote-workspace:${string}`;

export async function getOrCreateAcpRemoteWorkspacePublicRef(
  scope: AcpRemoteStateScope,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): Promise<AcpRemoteWorkspacePublicRef>;

export async function readAcpRemoteWorkspacePublicRef(
  scope: AcpRemoteStateScope,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): Promise<AcpRemoteWorkspacePublicRef | undefined>;
```

Add a branded protected-child-directory helper rather than constructing paths from plain strings. Use `open(..., 'wx', 0o600)`, handle sync, directory sync, handle/path identity checks, and exact realpath checks. The JSON sidecar contains only `version`, `exactIdentityDigest`, and `workspaceRef`.

- [ ] **Step 4: Run GREEN and checks**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts tests/unit/agent-runtime/acp/remote-workspace.test.ts tests/unit/agent-runtime/context/storage-path-utils.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/acp/AcpRemoteWorkspaceReference.ts src/acp/AcpRemoteWorkspace.ts src/context/storage/pathUtils.ts tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts tests/unit/agent-runtime/acp/remote-workspace.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/acp/AcpRemoteWorkspaceReference.ts packages/cli/src/acp/AcpRemoteWorkspace.ts packages/cli/src/context/storage/pathUtils.ts packages/cli/tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts packages/cli/tests/unit/agent-runtime/acp/remote-workspace.test.ts
git commit -m 'feat(acp): persist public remote workspace references'
```

---

### Task 3: Project exact live ACP ownership without granting authority

**Files:**
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`

- [ ] **Step 1: Write owner-snapshot RED tests**

Use real `initializeSession()` calls and fully typed SDK connections. Assert exact online capabilities, collision-only mismatch, unknown/destroyed/replaced generation offline state, and duplicate live Session IDs not transferring capabilities between exact workspaces. Assert the result contains no connection, path, or descriptor.

- [ ] **Step 2: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/acp/service-context.test.ts
```

- [ ] **Step 3: Implement the read-only owner snapshot**

```ts
export interface RemoteSurfaceOwnerSnapshot {
  connection: 'online' | 'offline';
  generation?: string;
  readText?: boolean;
  writeText?: boolean;
  terminal?: boolean;
}
```

Add `getRemoteSurfaceOwnerSnapshot(sessionId, descriptor)`. Store exact identity and a unique generation alongside accepted private services. Remove the binding before `destroySession()` can report offline. Never expose SDK connections or roots.

- [ ] **Step 4: Run GREEN and checks**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/acp/service-context.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/acp/AcpServiceContext.ts tests/unit/agent-runtime/acp/service-context.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/acp/AcpServiceContext.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
git commit -m 'feat(acp): project exact remote surface ownership'
```

---

### Task 4: Add the strict visible-message projector and cursor registry

**Files:**
- Create: `packages/cli/src/services/sessionSurfaceProjection.ts`
- Create: `packages/cli/src/services/SessionSurfaceCursorRegistry.ts`
- Create: `packages/cli/tests/unit/services/session-surface-projection.test.ts`
- Create: `packages/cli/tests/unit/services/session-surface-cursor-registry.test.ts`

- [ ] **Step 1: Write projector RED tests**

Build real typed events containing user/assistant messages, tool/system messages, reasoning, images, shell-command metadata, duplicates, invalid timestamps, and private-state canaries in metadata and visible text. Assert a strict field-by-field projection, stable sequence/digest IDs, original validated timestamps, UTF-8-safe `256 KiB` truncation, image placeholders, and no metadata/reasoning/tool fields.

- [ ] **Step 2: Write cursor-registry RED tests**

Use a fake clock and deterministic token source. Cover token kinds, `2048` entries, `64` chains, `32` cursors per chain, `10`-minute TTL, `64 MiB` frozen-snapshot budget, parameter/locator/revision/snapshot binding, idempotent replay, LRU reclamation, close/abort/drain, and restart invalidation.

- [ ] **Step 3: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/services/session-surface-projection.test.ts tests/unit/services/session-surface-cursor-registry.test.ts
```

- [ ] **Step 4: Implement both focused modules**

The projector accepts committed events plus exact private roots and constructs `SessionSurfaceMessage` without copying metadata. The registry exposes typed issue/redeem operations, `close()`, and bounded `stats()`. Tokens use random 32-byte values with distinct catalog/history/snapshot prefixes and are never logged.

- [ ] **Step 5: Run GREEN and checks**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/services/session-surface-projection.test.ts tests/unit/services/session-surface-cursor-registry.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/services/sessionSurfaceProjection.ts src/services/SessionSurfaceCursorRegistry.ts tests/unit/services/session-surface-projection.test.ts tests/unit/services/session-surface-cursor-registry.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/services/sessionSurfaceProjection.ts packages/cli/src/services/SessionSurfaceCursorRegistry.ts packages/cli/tests/unit/services/session-surface-projection.test.ts packages/cli/tests/unit/services/session-surface-cursor-registry.test.ts
git commit -m 'feat(session): add bounded surface projection primitives'
```

---

### Task 5: Upgrade the disposable SQLite projection for surface reads

**Files:**
- Modify: `packages/cli/src/context/storage/sqlite/schema.ts`
- Modify: `packages/cli/src/context/storage/sqlite/projection.ts`
- Modify: `packages/cli/tests/unit/context/sqlite/projection.test.ts`

- [ ] **Step 1: Write schema and projection RED tests**

Assert migration moves `SCHEMA_VERSION` from `6` to `7`, drops and rebuilds an old cache, and creates `surface_projection_meta` plus `surface_messages`. Assert `sessions` gains `public_workspace_ref`, `public_workspace_sort_key`, and `surface_digest`. Cover local/remote row derivation, strict message JSON, deletion GC, rewind rebuild, no-op resync preserving revision, semantic change incrementing revision once, and a history query that reads only `limit + 1` complete messages.

- [ ] **Step 2: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/context/sqlite/projection.test.ts
```

Expected: schema, column, revision, and bounded-query assertions fail.

- [ ] **Step 3: Implement schema v7 and transactional surface materialization**

Extend `ProjectedSession` with an optional validated public reference and strict message rows. `syncAcpRemoteScope()` creates or reads the sidecar asynchronously while holding the validated scope and passes the reference into the synchronous derivation/write transaction. Local sync passes no reference. Compute a semantic digest from the catalog-visible summary plus ordered surface messages. In one transaction compare the digest, update `sessions`, replace `surface_messages`, update projection state, and increment `catalog_revision` only when the digest changed.

Export typed read helpers:

```ts
export function readSessionSurfaceCatalogPage(
  db: SqliteDb,
  query: ProjectedSurfaceCatalogQuery
): ProjectedSurfaceCatalogPage;

export function readSessionSurfaceHistoryPage(
  db: SqliteDb,
  query: ProjectedSurfaceHistoryQuery
): ProjectedSurfaceHistoryPage;

export function readSessionSurfaceCandidates(
  db: SqliteDb,
  sessionId: string
): readonly ProjectedSurfaceCandidate[];
```

The service owns a random process epoch; SQLite owns only the monotonic semantic revision.

- [ ] **Step 4: Run GREEN and regression checks**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/context/sqlite/projection.test.ts tests/unit/services/session-service-catalog.test.ts tests/unit/services/session-service-remote.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/context/storage/sqlite/schema.ts src/context/storage/sqlite/projection.ts tests/unit/context/sqlite/projection.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/context/storage/sqlite/schema.ts packages/cli/src/context/storage/sqlite/projection.ts packages/cli/tests/unit/context/sqlite/projection.test.ts
git commit -m 'feat(session): project bounded session surfaces'
```

---

### Task 6: Implement lifecycle-owned SessionSurfaceService

**Files:**
- Create: `packages/cli/src/services/SessionSurfaceService.ts`
- Modify: `packages/cli/src/services/SessionService.ts`
- Create: `packages/cli/tests/unit/services/session-surface-service.test.ts`
- Regression only: `packages/cli/tests/unit/services/session-service-fork.test.ts`
- Regression only: `packages/cli/tests/unit/services/session-service-remote.test.ts`

- [ ] **Step 1: Write merged-catalog and resolver RED tests**

Use real local JSONL, protected remote scopes, SQLite projection, and JSONL fallback. Cover newest-first mixed pagination, exact ties, duplicate Session IDs, opaque cursor contents, semantic revision change, no-op resync, process-epoch invalidation, JSONL double-fingerprint retry and capacities, forged/rotated/corrupt/collision-only/wrong-kind locators, and output containing `displayCwd=wirePath` but no internal fields.

- [ ] **Step 2: Write history/open/fork RED tests**

Cover newest and older pages, count/byte caps, strict message schema, cursor replay and parameter mismatch, snapshot change, archived fork rejection, stable remote fork, unchanged source bytes, and a child that remains history-only. Instrument production constructors to prove remote open/fork creates no Runtime, Agent, SSE owner, Browser Runtime, local filesystem call, Git operation, hook/plugin/skill discovery, or PTY.

- [ ] **Step 3: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/services/session-surface-service.test.ts tests/unit/services/session-service-fork.test.ts tests/unit/services/session-service-remote.test.ts
```

- [ ] **Step 4: Add narrow SessionService primitives**

Do not expose remote roots publicly. Add internal operations that return validated candidate records or stable snapshots only to `SessionSurfaceService`:

```ts
static async listValidatedRemoteSurfaceCandidates(): Promise<
  readonly ValidatedRemoteSurfaceCandidate[]
>;
static async readValidatedLocalSurfaceSnapshot(
  sessionId: string,
  projectPath: string
): Promise<readonly SessionEvent[]>;
static async readValidatedRemoteSurfaceSnapshot(
  candidate: ValidatedRemoteSurfaceCandidate
): Promise<readonly SessionEvent[]>;
```

Keep `ValidatedRemoteSurfaceCandidate` outside the public API. It may contain a parsed descriptor and branded scope but is never serialized.

- [ ] **Step 5: Implement the owned service instance**

```ts
export class SessionSurfaceService {
  constructor(options: SessionSurfaceServiceOptions = {});
  listPage(options: SurfaceListOptions): Promise<SessionSurfacePage>;
  open(
    locator: SessionLocatorV2,
    options?: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceOpenResult>;
  historyPage(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceHistoryPage>;
  fork(locator: SessionLocatorV2): Promise<SessionSurfaceOpenResult>;
  close(reason?: string): Promise<void>;
}
```

Use one bounded admission gate. `close()` is idempotent, rejects new work, aborts reads, waits for settlement, and clears cursors/snapshots. Validate every public output against its runtime schema before returning.

- [ ] **Step 6: Run GREEN and regressions**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/services/session-surface-service.test.ts tests/unit/services/session-service-catalog.test.ts tests/unit/services/session-service-fork.test.ts tests/unit/services/session-service-remote.test.ts tests/unit/context/sqlite/projection.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/services/SessionSurfaceService.ts src/services/SessionService.ts tests/unit/services/session-surface-service.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/services/SessionSurfaceService.ts packages/cli/src/services/SessionService.ts packages/cli/tests/unit/services/session-surface-service.test.ts
git commit -m 'feat(session): add unified history surface service'
```

---

### Task 7: Add V2 Hono routes and shutdown ownership

**Files:**
- Create: `packages/cli/src/server/routes/sessionSurface.ts`
- Modify: `packages/cli/src/server/server.ts`
- Create: `packages/cli/tests/unit/agent-runtime/server/session-surface-routes.test.ts`
- Create: `packages/cli/tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Write route RED tests around real state**

Mount the production route controller around temporary local/remote state. Test catalog/open/history/fork, strict request rejection including unknown and duplicate query fields, exact `400/403/404/409/429/500/503` mapping, response-schema validation, no remote private fields/canaries, unchanged V1 local routes, and idempotent shutdown that rejects new work and drains active reads.

- [ ] **Step 2: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/server/session-surface-routes.test.ts tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts tests/unit/agent-runtime/server/session-routes.test.ts
```

- [ ] **Step 3: Implement a separate route controller**

```ts
export interface SessionSurfaceRouteController {
  app: Hono<{ Variables: { directory: string } }>;
  getStats(): {
    accepting: boolean;
    active: number;
    cursors: number;
  };
  shutdown(reason?: string): Promise<void>;
}
```

Call `safeParseSchema`, map only known surface errors, and log only method/path/code/kind plus a bounded locator digest. Mount `/sessions/v2` before `/sessions`. Add the controller to startup-failure cleanup and graceful shutdown. The route module must not import Runtime, Agent, Bus/SSE, Browser, file, or terminal modules.

- [ ] **Step 4: Run GREEN and server regressions**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/integrations/api/session-surface-schemas.test.ts tests/unit/agent-runtime/server/session-surface-routes.test.ts tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts tests/unit/agent-runtime/server/session-routes.test.ts tests/unit/agent-runtime/server/session-ref.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/server/routes/sessionSurface.ts src/server/server.ts tests/unit/agent-runtime/server/session-surface-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/server/routes/sessionSurface.ts packages/cli/src/server/server.ts packages/cli/tests/unit/agent-runtime/server/session-surface-routes.test.ts packages/cli/tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git commit -m 'feat(server): expose bounded session history surfaces'
```

---

### Task 8: Reject protected remote state roots at legacy local path boundaries

**Files:**
- Modify: `packages/cli/src/server/sessionRef.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/src/server/routes/suggestions.ts`
- Modify: `packages/cli/src/server/routes/terminal.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-ref.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Create: `packages/cli/tests/unit/agent-runtime/server/suggestions-routes.test.ts`
- Create: `packages/cli/tests/unit/agent-runtime/server/terminal-routes.test.ts`

- [ ] **Step 1: Write adversarial RED tests**

Submit a syntactically valid protected ACP state root through V1 `projectPath`,
`directory`, `x-blade-directory`, suggestions file tree/content inputs, and
terminal `cwd`. Assert a fixed `400` response before Session lookup, host `fs`,
Git, project resource discovery, or PTY spawn. Assert ordinary local absolute
paths remain accepted.

- [ ] **Step 2: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/server/session-ref.test.ts tests/unit/agent-runtime/server/session-routes.test.ts tests/unit/agent-runtime/server/suggestions-routes.test.ts tests/unit/agent-runtime/server/terminal-routes.test.ts
```

- [ ] **Step 3: Add one local-path guard and apply it before side effects**

Use `isAcpRemoteHostStateRoot()` in a shared strict local-path validator. The
guard only rejects the protected namespace; it never resolves a remote locator
or grants remote authority. Apply it in the touched Session, suggestions, and
terminal V1 entry points before any path-based operation.

- [ ] **Step 4: Run GREEN and local compatibility tests**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/server/session-ref.test.ts tests/unit/agent-runtime/server/session-routes.test.ts tests/unit/agent-runtime/server/session-fork-routes.test.ts tests/unit/agent-runtime/server/suggestions-routes.test.ts tests/unit/agent-runtime/server/terminal-routes.test.ts
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/server/sessionRef.ts src/server/routes/session.ts src/server/routes/suggestions.ts src/server/routes/terminal.ts tests/unit/agent-runtime/server
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/server/sessionRef.ts packages/cli/src/server/routes/session.ts packages/cli/src/server/routes/suggestions.ts packages/cli/src/server/routes/terminal.ts packages/cli/tests/unit/agent-runtime/server/session-ref.test.ts packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts packages/cli/tests/unit/agent-runtime/server/session-fork-routes.test.ts packages/cli/tests/unit/agent-runtime/server/suggestions-routes.test.ts packages/cli/tests/unit/agent-runtime/server/terminal-routes.test.ts
git commit -m 'fix(server): reject remote state roots from local routes'
```

---

### Task 9: Add the Web V2 client, opaque navigation, and isolated store

**Files:**
- Modify: `packages/cli/web/src/services/sessionService.ts`
- Modify: `packages/cli/web/src/store/session/sessionIdentity.ts`
- Modify: `packages/cli/web/src/store/session/sessionNavigation.ts`
- Modify: `packages/cli/web/src/store/session/types.ts`
- Create: `packages/cli/web/src/store/session/slices/historySurfaceSlice.ts`
- Modify: `packages/cli/web/src/store/session/slices/index.ts`
- Modify: `packages/cli/web/src/store/session/index.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Modify: `packages/cli/web/tests/store/session/sessionIdentity.test.ts`
- Modify: `packages/cli/web/tests/store/session/sessionNavigation.test.ts`
- Modify: `packages/cli/web/tests/store/session/sessionSlice.test.ts`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`
- Modify: `packages/cli/web/tests/lib/http.test.ts`

- [ ] **Step 1: Write client/navigation/store RED tests**

Assert runtime parsing and fixed errors; locator keys that distinguish duplicate Session IDs; the exact remote URL; absence of `displayCwd/project/workspace/cwd` from remote URLs; invalid query cleanup without fetch; sibling history state separate from `currentSessionRef`; generation fencing; one page in flight per locator and four globally; cursor/snapshot recovery; and close returning to an unchanged local interactive Session. Feed live/global Session, task, terminal, and Browser event fixtures while remote history is selected and prove `eventHandlers.ts` neither treats the locator as `currentSessionRef` nor mutates the history-only messages.

- [ ] **Step 2: Run RED**

```bash
cd packages/cli/web && bun x vitest run --config vitest.config.ts tests/lib/http.test.ts tests/store/session/sessionIdentity.test.ts tests/store/session/sessionNavigation.test.ts tests/store/session/sessionSlice.test.ts tests/store/session/eventHandlers.test.ts
```

- [ ] **Step 3: Implement V2 client methods**

Add `listSurfaceCatalog`, `openSurface`, `loadSurfaceHistoryPage`, and `forkSurface`. Every response passes the shared schema. Never call `withSessionRef()` or `sessionDirectoryHeaders()` for a remote locator.

- [ ] **Step 4: Implement locator helpers and sibling store slice**

Keep `currentSessionRef` local-only. Store catalog, selection, bounded messages, cursor/snapshot, generation, load state, and errors. Add `loadSurfaceCatalog`, `openHistorySurface`, `loadOlderSurfaceHistory`, `forkHistorySurface`, and `closeHistorySurface`. Keep admission/concurrency state private to the slice. Add an explicit early boundary in shared event handlers: history-only state is not an SSE target and cannot be resolved through path-based Session events.

- [ ] **Step 5: Run GREEN and Web checks**

```bash
cd packages/cli/web && bun x vitest run --config vitest.config.ts tests/lib/http.test.ts tests/store/session/sessionIdentity.test.ts tests/store/session/sessionNavigation.test.ts tests/store/session/sessionSlice.test.ts tests/store/session/eventHandlers.test.ts
cd packages/cli/web && bun run type-check
cd packages/cli/web && bun x biome check src/services/sessionService.ts src/store/session tests/lib/http.test.ts tests/store/session
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/web/src/services/sessionService.ts packages/cli/web/src/store/session/sessionIdentity.ts packages/cli/web/src/store/session/sessionNavigation.ts packages/cli/web/src/store/session/types.ts packages/cli/web/src/store/session/slices/historySurfaceSlice.ts packages/cli/web/src/store/session/slices/index.ts packages/cli/web/src/store/session/index.ts packages/cli/web/src/store/session/handlers/eventHandlers.ts packages/cli/web/tests/lib/http.test.ts packages/cli/web/tests/store/session/sessionIdentity.test.ts packages/cli/web/tests/store/session/sessionNavigation.test.ts packages/cli/web/tests/store/session/sessionSlice.test.ts packages/cli/web/tests/store/session/eventHandlers.test.ts
git commit -m 'feat(web): add isolated session history state'
```

---

### Task 10: Build the Web history-only GUI and action gates

**Files:**
- Create: `packages/cli/web/src/components/history/SessionHistorySurface.tsx`
- Create: `packages/cli/web/src/components/history/SessionHistoryBanner.tsx`
- Modify: `packages/cli/web/src/components/layout/Sidebar.tsx`
- Modify: `packages/cli/web/src/components/layout/SidebarSessionList.tsx`
- Modify: `packages/cli/web/src/components/layout/SessionRow.tsx`
- Modify: `packages/cli/web/src/components/layout/Layout.tsx`
- Modify: `packages/cli/web/src/components/chat/ChatView.tsx`
- Modify: `packages/cli/web/src/components/chat/ChatInput.tsx`
- Modify: `packages/cli/web/src/components/preview/FilePreview.tsx`
- Modify: `packages/cli/web/src/components/terminal/TerminalPanel.tsx`
- Modify: `packages/cli/web/src/components/tasks/TaskArtifactBar.tsx`
- Modify: `packages/cli/web/src/i18n/en.ts`
- Modify: `packages/cli/web/src/i18n/zh.ts`
- Modify: `packages/cli/web/tests/components/layout/Sidebar.test.tsx`
- Modify: `packages/cli/web/tests/components/layout/Layout.test.tsx`
- Modify: `packages/cli/web/tests/components/chat/ChatView.test.tsx`
- Modify: `packages/cli/web/tests/components/chat/ChatInput.test.tsx`
- Modify: `packages/cli/web/tests/components/preview/FilePreview.test.tsx`
- Modify: `packages/cli/web/tests/components/tasks/TaskArtifactBar.test.tsx`
- Modify: `packages/cli/web/tests/App.test.tsx`

- [ ] **Step 1: Write remote-row and viewer RED tests**

Render a merged catalog with duplicate Session IDs. Assert locator-based React keys, `Remote`, online/offline, `History only`, canonical `displayCwd`, bounded top loading, loaded-page-only search, fork-to-child, refresh restoration, and close-to-local behavior. Assert DOM text excludes host-state and descriptor canaries.

- [ ] **Step 2: Write presentation and handler gate RED tests**

Assert the composer is visibly disabled and direct submit-handler invocation performs no request. Assert Files, Terminal, Browser Runtime, review, rewind, Goal/task dispatch, and subagent actions are absent or disabled and direct handlers fail closed. Spy on fetch and WebSocket construction to prove no `/suggestions/files`, `/terminal/ws`, per-Session SSE, or Browser route is attempted.

- [ ] **Step 3: Run RED**

```bash
cd packages/cli/web && bun x vitest run --config vitest.config.ts tests/components/layout/Sidebar.test.tsx tests/components/layout/Layout.test.tsx tests/components/chat/ChatView.test.tsx tests/components/chat/ChatInput.test.tsx tests/components/preview/FilePreview.test.tsx tests/components/tasks/TaskArtifactBar.test.tsx tests/App.test.tsx
```

- [ ] **Step 4: Implement the dedicated history view**

Render strict `SessionSurfaceMessage[]` without adapting them to the live Session message store. Use an explicit top sentinel to request one older page per cursor. Add fixed English and Chinese copy for remote status, history-only mode, unavailable actions, cursor reset, and snapshot refresh.

- [ ] **Step 5: Implement every action gate twice**

Use capabilities to disable or hide controls and add imperative checks in every action handler. A history-only action reports `session_surface_read_only` and never translates `displayCwd` into a V1 ref.

- [ ] **Step 6: Run GREEN, full Web tests, type-check, and build**

```bash
cd packages/cli/web && bun x vitest run --config vitest.config.ts tests/components/layout/Sidebar.test.tsx tests/components/layout/Layout.test.tsx tests/components/chat/ChatView.test.tsx tests/components/chat/ChatInput.test.tsx tests/components/preview/FilePreview.test.tsx tests/components/tasks/TaskArtifactBar.test.tsx tests/App.test.tsx
cd packages/cli/web && bun x vitest run --config vitest.config.ts
cd packages/cli/web && bun run type-check
cd /Users/bytedance/Documents/GitHub/Blade && bun run build
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/web/src/components/history/SessionHistorySurface.tsx packages/cli/web/src/components/history/SessionHistoryBanner.tsx packages/cli/web/src/components/layout/Sidebar.tsx packages/cli/web/src/components/layout/SidebarSessionList.tsx packages/cli/web/src/components/layout/SessionRow.tsx packages/cli/web/src/components/layout/Layout.tsx packages/cli/web/src/components/chat/ChatView.tsx packages/cli/web/src/components/chat/ChatInput.tsx packages/cli/web/src/components/preview/FilePreview.tsx packages/cli/web/src/components/terminal/TerminalPanel.tsx packages/cli/web/src/components/tasks/TaskArtifactBar.tsx packages/cli/web/src/i18n/en.ts packages/cli/web/src/i18n/zh.ts packages/cli/web/tests/components/layout/Sidebar.test.tsx packages/cli/web/tests/components/layout/Layout.test.tsx packages/cli/web/tests/components/chat/ChatView.test.tsx packages/cli/web/tests/components/chat/ChatInput.test.tsx packages/cli/web/tests/components/preview/FilePreview.test.tsx packages/cli/web/tests/components/tasks/TaskArtifactBar.test.tsx packages/cli/web/tests/App.test.tsx
git commit -m 'feat(web): add remote session history surfaces'
```

---

### Task 11: Build the TUI remote history selector and viewer

**Files:**
- Modify: `packages/cli/src/ui/components/sessionSelectorModel.ts`
- Modify: `packages/cli/src/ui/components/SessionSelector.tsx`
- Create: `packages/cli/src/ui/components/SessionHistoryViewer.tsx`
- Create: `packages/cli/src/ui/services/SessionHistoryController.ts`
- Modify: `packages/cli/src/ui/components/BladeInterface.tsx`
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/store/slices/appSlice.ts`
- Modify: `packages/cli/src/store/selectors/index.ts`
- Modify: `packages/cli/src/ui/utils/slashCommandRouter.ts`
- Modify: `packages/cli/tests/unit/platform/ui/components/session-selector-model.test.ts`
- Create: `packages/cli/tests/unit/platform/ui/SessionHistoryViewer.test.tsx`
- Modify: `packages/cli/tests/integration/cli/session-selector-fork.test.tsx`
- Create: `packages/cli/tests/integration/cli/session-history-surface.test.tsx`

- [ ] **Step 1: Write selector-model RED tests**

Change candidate inputs to `SessionSurfaceSummary`. Assert remote/local labels, locator compound keys, duplicate Session IDs, offline/history badges, archived fork filtering, and no internal path formatting for remote rows.

- [ ] **Step 2: Write viewer and real Ink RED tests**

With real `TerminalInputRouter`, typed `PassThrough` stdin/stdout, and a real temporary `SessionSurfaceService`, cover remote selection without `path.resolve`, `restoreSession`, or `cleanupAgent`; unchanged live local Session state; initial history, page-up loading, search, copy, fork, close; remote child staying history-only; unavailable-action footer; late completion after close; and no host-state/descriptor canary in stdout or errors.

- [ ] **Step 3: Run RED**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/platform/ui/components/session-selector-model.test.ts tests/unit/platform/ui/SessionHistoryViewer.test.tsx
cd packages/cli && bun x vitest run --config vitest.config.ts --project=cli tests/integration/cli/session-selector-fork.test.tsx tests/integration/cli/session-history-surface.test.tsx
```

- [ ] **Step 4: Implement the owned TUI history controller**

The controller owns one `SessionSurfaceService`, request generation, abort controller, and page state. Add `sessionHistoryViewer` to `ActiveModal` with typed state. `closeModal()` closes viewer state without mutating the live Session slice; application unmount calls controller `close()`.

- [ ] **Step 5: Implement viewer and selector dispatch**

Reuse pure transcript layout/search/copy helpers, not live `TranscriptPager` store selectors. Local rows continue through `activateSessionSelection`. Remote rows open `SessionHistoryViewer` and never invoke `restoreSession()` or provide a workspace root.

- [ ] **Step 6: Run GREEN and TUI regressions**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/platform/ui/components/session-selector-model.test.ts tests/unit/platform/ui/SessionHistoryViewer.test.tsx tests/unit/platform/ui/TranscriptPager.test.tsx tests/unit/platform/ui/utils/sessionActivation.test.ts
cd packages/cli && bun x vitest run --config vitest.config.ts --project=cli tests/integration/cli/session-selector-fork.test.tsx tests/integration/cli/session-history-surface.test.tsx tests/integration/tui-batched-input.test.tsx
cd packages/cli && bun run type-check
cd packages/cli && bun x biome check src/ui src/store tests/unit/platform/ui tests/integration/cli/session-history-surface.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/ui/components/sessionSelectorModel.ts packages/cli/src/ui/components/SessionSelector.tsx packages/cli/src/ui/components/SessionHistoryViewer.tsx packages/cli/src/ui/services/SessionHistoryController.ts packages/cli/src/ui/components/BladeInterface.tsx packages/cli/src/ui/utils/slashCommandRouter.ts packages/cli/src/store/types.ts packages/cli/src/store/slices/appSlice.ts packages/cli/src/store/selectors/index.ts packages/cli/tests/unit/platform/ui/components/session-selector-model.test.ts packages/cli/tests/unit/platform/ui/SessionHistoryViewer.test.tsx packages/cli/tests/integration/cli/session-selector-fork.test.tsx packages/cli/tests/integration/cli/session-history-surface.test.tsx
git commit -m 'feat(tui): browse remote session history safely'
```

---

### Task 12: Qualify production GUI, TUI, and real ACP/Provider behavior

**Files:**
- Reuse: `packages/cli/tests/support/acp/remoteFilesystemQualification.ts`
- Reuse: `packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts`
- Reuse: `packages/cli/tests/integration/real-api/browser-preview-trajectory.test.ts`
- Reuse: `packages/cli/tests/integration/real-api/tui-session-fork-trajectory.test.tsx`
- Create: `packages/cli/tests/support/launch-session-surface-gui.ts`
- Create: `packages/cli/tests/integration/real-api/session-surface-history-trajectory.test.ts`
- Create: `packages/cli/tests/integration/real-api/session-surface-tui-trajectory.test.tsx`
- Reuse unchanged: `packages/cli/tests/integration/real-api/testConfig.ts`

- [ ] **Step 1: Build one paired-ACP production fixture**

Reuse the paired SDK client/agent patterns and bounded evidence helpers from `acp-remote-filesystem-trajectory.test.ts` and `tests/support/acp/remoteFilesystemQualification.ts`. Use production `BladeAgent`, `SessionService`, server routes, Web bundle, and paired ACP NDJSON. Create a remote transcript through a real model tool trajectory, record bounded request counts and hashes, disconnect the owner, and return only redacted fixture coordinates. Do not mock Agent, Runtime, ACP connection, SessionService, or Provider.

- [ ] **Step 2: Add production Chromium assertions**

Reuse the production-build/server/browser lifecycle from `browser-preview-trajectory.test.ts` and the child-process environment materialization from `launch-session-archive-gui.ts`. Launch Playwright Chromium. Intercept requests and WebSocket construction. Assert merged list, remote badge, canonical display cwd, offline history mode, bounded pagination, disabled submit, no Files/Terminal request, fork, refresh restoration, and no host canary in DOM, URL, response body, console, or server log. Save one screenshot as supporting evidence, not the only assertion.

- [ ] **Step 3: Add production TUI/raw-PTY assertions**

Reuse the real Ink/stdin/stdout and release-model selection patterns from `tui-session-fork-trajectory.test.tsx`; use the existing raw-PTY readiness protocol when a spawned production CLI is required. Select remote history, page/search/copy/fork/close, and prove the original local Session stays unchanged. Do not claim computer-use automation unless an actual desktop-control tool is available and used.

- [ ] **Step 4: Run deterministic qualification**

```bash
cd packages/cli && bun x vitest run --config vitest.config.ts --project=unit tests/unit/integrations/api/session-surface-schemas.test.ts tests/unit/integrations/api/schemas.test.ts tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts tests/unit/agent-runtime/acp/service-context.test.ts tests/unit/services/session-surface-projection.test.ts tests/unit/services/session-surface-cursor-registry.test.ts tests/unit/services/session-surface-service.test.ts tests/unit/context/sqlite/projection.test.ts tests/unit/agent-runtime/server/session-surface-routes.test.ts tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts tests/unit/agent-runtime/server/session-ref.test.ts tests/unit/agent-runtime/server/session-routes.test.ts tests/unit/agent-runtime/server/session-fork-routes.test.ts tests/unit/agent-runtime/server/suggestions-routes.test.ts tests/unit/agent-runtime/server/terminal-routes.test.ts
cd packages/cli && bun x vitest run --config vitest.config.ts --project=cli tests/integration/cli/session-history-surface.test.tsx tests/integration/cli/session-selector-fork.test.tsx
cd packages/cli/web && bun x vitest run --config vitest.config.ts tests/store/session/sessionIdentity.test.ts tests/store/session/sessionNavigation.test.ts tests/store/session/sessionSlice.test.ts tests/store/session/eventHandlers.test.ts tests/components/layout/Sidebar.test.tsx tests/components/layout/Layout.test.tsx tests/components/chat/ChatView.test.tsx tests/components/chat/ChatInput.test.tsx tests/components/preview/FilePreview.test.tsx tests/App.test.tsx
```

- [ ] **Step 5: Run the zero-retry two-model release cell**

Load credentials only through the existing real-API configuration path and never print them:

```bash
cd packages/cli && REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run --config vitest.config.ts --project=real-api --retry=0 tests/integration/real-api/session-surface-history-trajectory.test.ts tests/integration/real-api/session-surface-tui-trajectory.test.tsx
```

Expected: both `deepseek-v4-flash` and `deepseek-v4-pro` pass with framework retry `0` and model `maxRetries=0`. History-only actions produce no second Provider request and no remote file/terminal request.

- [ ] **Step 6: Commit qualification tests**

```bash
git add packages/cli/tests/support/launch-session-surface-gui.ts packages/cli/tests/integration/real-api/session-surface-history-trajectory.test.ts packages/cli/tests/integration/real-api/session-surface-tui-trajectory.test.tsx
git commit -m 'test(gui): qualify remote session history surfaces'
```

---

### Task 13: Review, evidence, and publish v0.10.129

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`
- Create: `docs/testing/remote-session-surface-identity-evidence.md`
- Create: `docs/en/testing/remote-session-surface-identity-evidence.md`
- Create: `docs/reference/remote-session-history-surfaces.md`
- Create: `docs/en/reference/remote-session-history-surfaces.md`

- [ ] **Step 1: Run independent specification and quality/security/concurrency reviews**

Review the complete range from `v0.10.128` through the final code candidate. Fix every Critical and Important finding with its own TDD commit, then have the same reviewer re-review the fix.

- [ ] **Step 2: Run final repository gates**

The repository's required release baseline remains `bun run build && bun run
test:all` from `AGENTS.md`. This patch adds format, lint, type-check, and complete
coverage as stronger qualification because it changes public schemas, Web/TUI,
SQLite projection, and security boundaries.

```bash
bun run format:check
bun run lint
bun run type-check
bun run build
bun run test:all
CI=true bun run --filter blade-code test:coverage
```

If a wrapper reaches a fixed outer budget, run its exact complete Vitest collection to natural completion and keep the wrapper result explicit. The tag-triggered GitHub coverage job must still pass before publication. Describe a verified transient in unchanged code only as `intermittent failure in unchanged sources`.

- [ ] **Step 3: Write bounded bilingual evidence and release notes**

Record exact commands, HEAD, commit responsibility, deterministic counts, Chromium assertions, raw-PTY/Ink scope, real-model durations and retry counts, review verdicts, limitations, and hashes of bounded artifacts. Never record credentials, raw remote content, descriptors, host roots, or raw workspace references.

- [ ] **Step 4: Bump only the CLI package and commit release metadata**

Set `packages/cli/package.json` to `0.10.129`. Do not change root `package.json`, `bun.lock`, `docs/changelog.md`, or `docs/en/changelog.md`. Commit the exact release set:

```bash
git commit -m 'chore: release v0.10.129'
```

- [ ] **Step 5: Create and publish the annotated tag**

Extract the exact English `0.10.129` section into a file under `mktemp -d`, then run:

```bash
git tag -a --cleanup=verbatim v0.10.129 -F "$release_notes_path"
git push origin main
git push origin v0.10.129
```

Do not run `packages/cli/scripts/release.js` and do not run `npm publish` manually.

- [ ] **Step 6: Watch and verify publication**

Locate `.github/workflows/publish.yml` by exact peeled tag SHA and run:

```bash
gh run watch <run-id> --exit-status --interval 15
```

Verify local HEAD, `origin/main`, local and remote peeled tag SHA, workflow `headSha`, npm `version/gitHead/latest`, GitHub Release, and a clean worktree.

---

## Final requirement-to-evidence checklist

| Requirement | Direct evidence required |
| --- | --- |
| Remote locator has no private path or descriptor | Runtime-schema negative tests plus response/DOM/URL/log canary scan |
| Random public reference is stable and protected | Sidecar mode, symlink, concurrency, restart, rotation, transplant, and capacity tests |
| Mixed catalog is stable and bounded | SQLite epoch/revision plus JSONL frozen-snapshot pagination tests |
| History is bounded and whitelisted | Message schema, byte/count tests, and no-full-materialization query evidence |
| Remote open/fork creates no live authority | Constructor/request spies around real SessionService and route tests |
| Web history-only is fail closed | Component state, direct handler tests, and Chromium network assertions |
| TUI history-only preserves live local Session | Real Ink/raw-PTY state assertions |
| Exact owner status cannot transfer | Generation/exact-identity tests with duplicate Session IDs |
| Local and ACP-local parity | Existing V1 server, Web, and TUI focused regressions |
| Real integration | Paired ACP and two real DeepSeek models at zero retry |
| Production readiness | Full gates, independent reviews, tag workflow, npm/GitHub/SHA verification |

Passing a proxy test, manifest, or green aggregate does not close a row. Every row requires the named direct artifact or command evidence.
