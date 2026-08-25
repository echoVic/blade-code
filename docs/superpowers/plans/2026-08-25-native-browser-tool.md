# Native Browser Tool Implementation Plan

> **For agentic workers:** Execute this plan task by task. Keep every checkbox
> current, run the stated RED and GREEN commands, and do not start release work
> until the implementation commit is fixed.

**Goal:** Ship `blade-code@0.10.87` with six native, deferred Playwright Browser
tools that are Session-isolated, permissioned by origin, bounded, cancellable, and
qualified with real DeepSeek Flash/Pro across Headless, raw PTY TUI, production Web,
and ACP.

**Architecture:** `SessionRuntime` owns a lazy `SessionBrowserRuntime`.
`SessionBrowserRuntime` serializes page operations, owns one ephemeral
`BrowserContext`, page IDs, snapshot/ref authority, and diagnostic rings.
`BrowserProcessPool` single-flight launches one process-wide Chromium and closes it
when its final context lease is released. Native Browser tools adapt this Runtime to
Blade's existing ToolRegistry, permissions, hooks, admission, persistence, and
surface projection.

**Tech Stack:** TypeScript strict mode, TypeBox, Bun, Vitest, Playwright `1.62.1`,
React/Ink generic tool surfaces, Hono/SSE, ACP SDK, real DeepSeek Flash/Pro APIs.

**Frozen design:**
`docs/superpowers/specs/2026-08-25-native-browser-tool-design.md`

**Implementation record:** Tasks 1-14 are implemented in `64c60b5e`,
`2862d099`, `4553d089`, `90fad7fe`, and `0ea1cc50`. The final fixed-source
Browser Tool matrix passed 8/8 with framework retry `0`.

---

## Execution Constraints

- Release baseline is annotated tag `v0.10.86` at
  `3b786d3796747d39013d591290fa5d35e8005343`.
- Work directly in the current checkout. Do not create a git worktree.
- Keep `packages/cli/package.json` at `0.10.86` until the release-candidate task.
- Follow RED -> verify RED -> minimal GREEN -> verify GREEN for each behavior.
- Unit tests may inject fake Playwright adapters. Integration and release
  qualification must use the real pinned Chromium and real Provider APIs.
- Do not import from `playwright-core/lib/*`, `coreBundle.js`, Playwright MCP, or
  unexported Playwright modules.
- Do not add Stagehand or another model call.
- Do not add arbitrary selector, evaluate, upload, download, cookie, storage-state,
  or credential-entry escape hatches.
- Do not implicitly download Chromium from startup, tool execution, tests,
  `browser status`, or package installation.
- Never place Provider keys in commands, source, snapshots, fixtures, logs,
  evidence, browser state, transcripts, or artifacts.
- Every queue, collection, text field, timeout, page, context, and artifact introduced
  by this feature must have a tested bound.
- Every Browser operation must be abort-aware and must settle during
  `SessionRuntime.dispose()`.
- Keep the Browser Preview iframe independent; no screencast or takeover code belongs
  in this release.
- Preserve unrelated user changes if the worktree becomes dirty.
- Each task gets its own focused commit unless two adjacent tasks only complete one
  indivisible invariant.
- Framework retry remains `0` in release-blocking real API tests.
- Each Local/Production Qualification run targets one fixed HEAD. Any source or test
  change invalidates that run. The repository evidence commit is followed by a
  final no-edit qualification whose exact HEAD and log hashes live in the tag and
  GitHub Release attestation.

## File Responsibility Map

### Runtime

| File | Responsibility |
| --- | --- |
| `packages/cli/src/browser/constants.ts` | Frozen resource and timeout bounds |
| `packages/cli/src/browser/types.ts` | Closed Browser inputs, observations, diagnostics, errors, and adapter types |
| `packages/cli/src/browser/BrowserSecurity.ts` | URL normalization, origin classification, safe URL projection, key allowlist, launch environment |
| `packages/cli/src/browser/BrowserOperationGate.ts` | Abort-aware bounded FIFO serialization per Session |
| `packages/cli/src/browser/BrowserProcessPool.ts` | Lazy Chromium single-flight, context leases, generation, capacity, disposal |
| `packages/cli/src/browser/BrowserSnapshotAuthority.ts` | AI snapshot bounds, ref parsing, fingerprints, stale validation |
| `packages/cli/src/browser/SessionBrowserRuntime.ts` | Context, pages, origin gate, diagnostics, interactions, screenshots, lifecycle |
| `packages/cli/src/browser/BrowserInstallation.ts` | Pinned executable status and explicit install process |
| `packages/cli/src/browser/index.ts` | Public browser-module exports |

### Tools And Projection

| File | Responsibility |
| --- | --- |
| `packages/cli/src/tools/builtin/browser/index.ts` | Export Browser tool factory |
| `packages/cli/src/tools/builtin/browser/browserTools.ts` | Six TypeBox schemas and Tool adapters |
| `packages/cli/src/tools/builtin/index.ts` | Register Session-bound Browser tools |
| `packages/cli/src/tools/types/ToolTypes.ts` | Typed Browser metadata |
| `packages/cli/src/ui/utils/toolFormatters.ts` | Bounded canonical Browser summaries/details |
| `packages/cli/src/tools/execution/ToolApprovalController.ts` | Browser origin/action approval preview and risks |
| `packages/cli/src/server/routes/session.ts` | Explicit Browser metadata allowlist |
| `packages/cli/src/prompts/sections.ts` | Treat Browser page content as untrusted data |
| `packages/cli/src/agent/runtime/SessionRuntime.ts` | Browser Runtime ownership, tool injection, cleanup order |
| `packages/cli/src/services/SessionService.ts` and `packages/cli/src/context/storage/PersistentStore.ts` | Remove Browser artifacts on explicit Session deletion |

### Artifacts And CLI

| File | Responsibility |
| --- | --- |
| `packages/cli/src/tools/artifacts/SessionArtifactStore.ts` | Generic private content-addressed Session artifact storage |
| `packages/cli/src/mcp/McpToolArtifactStore.ts` | Compatibility wrapper using the generic store |
| `packages/cli/src/browser/BrowserArtifactStore.ts` | Browser screenshot namespace and quotas |
| `packages/cli/src/commands/browser.ts` | `blade browser status/install` |
| `packages/cli/src/blade.tsx` | Lazy Browser command registration |
| `packages/cli/scripts/browser-check.ts` | Developer/qualification status adapter |
| `packages/cli/package.json` | Runtime Playwright dependency and existing aliases |
| `bun.lock` | Locked runtime dependency graph |

### Deterministic Tests

| File | Responsibility |
| --- | --- |
| `packages/cli/tests/unit/browser/browser-security.test.ts` | URL, origin, redaction, keys, environment |
| `packages/cli/tests/unit/browser/browser-operation-gate.test.ts` | FIFO, capacity, abort, close |
| `packages/cli/tests/unit/browser/browser-process-pool.test.ts` | Launch, lease, capacity, crash, disposal |
| `packages/cli/tests/unit/browser/browser-snapshot-authority.test.ts` | Bounds, refs, fingerprints, stale state |
| `packages/cli/tests/unit/browser/session-browser-runtime.test.ts` | Page/context/action/diagnostic lifecycle with injected adapters |
| `packages/cli/tests/unit/browser/browser-artifact-store.test.ts` | Mode, ownership, hash, quotas |
| `packages/cli/tests/unit/tooling/tools/builtin/browser-tools.test.ts` | Schemas, kinds, signatures, results |
| `packages/cli/tests/unit/cli/commands/browser.test.ts` | Status/install command contract |
| `packages/cli/tests/integration/browser-tool-chromium.test.ts` | Real keyless Chromium against loopback fixtures |
| existing registry, Runtime, executor, projection, server-route, CLI, build, and qualification tests | Cross-cutting regression assertions |

### Production Qualification

| File | Responsibility |
| --- | --- |
| `packages/cli/tests/integration/real-api/browser-tool-fixture.ts` | Self-contained loopback application and hidden nonce |
| `packages/cli/tests/support/browserToolHeadlessDriver.ts` | Production Headless entry |
| `packages/cli/tests/support/browserToolPtyDriver.ts` | Isolated raw PTY subprocess wrapper |
| `packages/cli/tests/support/browserToolPtyRunner.ts` | Real raw PTY TUI entry |
| `packages/cli/tests/support/browserToolWebDriver.ts` | Outer production Chromium Web entry |
| `packages/cli/tests/support/browserToolAcpDriver.ts` | Real ACP SDK entry |
| `packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts` | Fixed two-model x four-surface matrix |
| `packages/cli/scripts/test-config.js` | Release-blocking manifest entry |
| `packages/cli/scripts/test-config.d.ts` | Manifest shape if changed |
| `packages/cli/tests/unit/scripts/test-runner.test.ts` | Source gate for fixed qualification inclusion |

### Documentation And Evidence

| File | Responsibility |
| --- | --- |
| `README.md`, `README.en.md`, `packages/cli/README.md` | Browser Tool capability and install entry |
| `docs/getting-started/installation.md` | Chinese browser installation/status |
| `docs/en/getting-started/installation.md` | English browser installation/status |
| `docs/tools.md` or current Chinese tool catalog | Chinese six-tool contract |
| `docs/en/tools.md` or current English tool catalog | English six-tool contract |
| `docs/testing/qualification.md` | Chinese Browser Tool release matrix |
| `docs/en/testing/qualification.md` | English Browser Tool release matrix |
| `docs/testing/native-browser-tool-evidence.md` | Chinese fixed-HEAD release evidence |
| `docs/en/testing/native-browser-tool-evidence.md` | English fixed-HEAD release evidence |
| `CHANGELOG.md` | English `0.10.87` release notes |
| `CHANGELOG.zh.md` | Chinese `0.10.87` release notes |

Before editing a tool-catalog path, locate its actual current filename with `rg`; do
not create a duplicate catalog when one already exists.

## Targeted Test Command Form

Run targeted tests from `packages/cli` with the repository-pinned Vitest:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit tests/unit/browser/browser-security.test.ts
```

Use `--project=integration` for the keyless real Chromium test and
`--project=real-api` for the Provider trajectory. Run the release matrix only
through:

```bash
bun run test:real-api:qualification
```

Do not claim a release pass from a hand-picked subset.

### Task 1: Make The Pinned Browser Runtime Installable

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `bun.lock`
- Create: `packages/cli/src/browser/BrowserInstallation.ts`
- Create: `packages/cli/tests/unit/commands/browser-installation.test.ts`
- Modify: `packages/cli/scripts/browser-check.ts`
- Modify: `packages/cli/tests/unit/scripts/browser-check.test.ts`

- [x] **Step 1: Write failing dependency and status tests**

Assert:

- `playwright` is an exact runtime dependency at `1.62.1`;
- it is absent from `devDependencies`;
- importing `BrowserInstallation` does not launch a browser;
- status resolves `playwright/package.json`, derives its package-root `cli.js`,
  checks execute access, launches and closes headless Chromium, reports
  `browser.version()`, and performs no download;
- missing executable returns `browser_not_installed` and the exact public command
  `blade browser install`;
- install invokes `process.execPath <pinned-package-root>/cli.js install chromium`
  with `shell: false`, inherited stdio, and the frozen installer environment;
- a non-zero installer exit is propagated.

Run and verify RED:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/commands/browser-installation.test.ts \
  tests/unit/scripts/browser-check.test.ts
```

- [x] **Step 2: Move Playwright and implement the shared installation service**

Use `createRequire(import.meta.url).resolve('playwright/package.json')` to locate the
installed package. Do not resolve an unexported `playwright/cli` subpath and do not
invoke `npx`. Build the installer environment from the exact OS launch allowlist plus
Playwright path/download-host/timeout, HTTP(S) proxy/no-proxy, and Node CA variables;
drop Provider and Blade Session credentials.

- [x] **Step 3: Make `browser-check.ts` a thin adapter**

Keep its keyless launch/close behavior and package script compatibility. Change its
failure guidance to the public CLI command.

- [x] **Step 4: Run GREEN and package metadata checks**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/commands/browser-installation.test.ts \
  tests/unit/scripts/browser-check.test.ts
bun pm ls playwright
```

- [x] **Step 5: Commit**

```bash
git add packages/cli/package.json bun.lock \
  packages/cli/src/browser/BrowserInstallation.ts \
  packages/cli/scripts/browser-check.ts \
  packages/cli/tests/unit/commands/browser-installation.test.ts \
  packages/cli/tests/unit/scripts/browser-check.test.ts
git commit -m "build(browser): ship pinned Playwright runtime"
```

### Task 2: Define Pure Browser Security And Data Contracts

**Files:**
- Create: `packages/cli/src/browser/constants.ts`
- Create: `packages/cli/src/browser/types.ts`
- Create: `packages/cli/src/browser/BrowserSecurity.ts`
- Create: `packages/cli/src/browser/index.ts`
- Create: `packages/cli/tests/unit/browser/browser-security.test.ts`

- [x] **Step 1: Write failing URL and origin tests**

Cover:

- absolute HTTP and HTTPS;
- effective default ports;
- IPv4, IPv6, localhost, private IPv4, and private IPv6 classification;
- userinfo, malformed URLs, oversized URLs, and every prohibited scheme;
- fragment removal;
- query-key retention with every query value redacted in projections;
- exact normalized-origin comparisons;
- public -> private and same-origin redirect classification.

- [x] **Step 2: Write failing launch-environment and input-bound tests**

Use a full synthetic environment containing API keys, bearer tokens, passwords,
proxy credentials, Blade variables, OS-required values, and arbitrary project
values. Assert only the frozen allowlist survives.

Test the non-modifier keyboard allowlist and every constant boundary at `limit - 1`,
`limit`, and `limit + 1`. Include page/snapshot/ref IDs, expected origin, wait text,
select item count/item bytes/total bytes, fingerprints, error messages, metadata
strings, and the 64 KiB Browser `llmContent` cap.

Numeric schemas use the exact integer ranges from the design: snapshot depth
`1..20`, diagnostic limit `1..100`, action timeout `100..30000`, navigation timeout
`100..60000`, wait timeout `100..30000`, and explicit time wait `0..5000`. Assert
that zero is valid only for an immediate time wait.

- [x] **Step 3: Implement closed types and pure helpers**

Use discriminated unions for actions, waits, page operations, diagnostics, and
typed failures. Do not use `any`. Keep Playwright imports out of the pure security
module.

- [x] **Step 4: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser/browser-security.test.ts
bun run type-check
```

- [x] **Step 5: Commit**

```bash
git add packages/cli/src/browser \
  packages/cli/tests/unit/browser/browser-security.test.ts
git commit -m "feat(browser): define bounded security contract"
```

### Task 3: Add The Bounded Session Operation Gate

**Files:**
- Create: `packages/cli/src/browser/BrowserOperationGate.ts`
- Create: `packages/cli/tests/unit/browser/browser-operation-gate.test.ts`

- [x] **Step 1: Write failing gate tests**

Prove:

- strict FIFO execution;
- one in-flight operation;
- maximum 32 pending operations;
- immediate typed `browser_busy` rejection at capacity;
- abort before enqueue and while queued;
- close settles every queued waiter exactly once;
- close during an active operation prevents later starts;
- repeated close is idempotent;
- queue and listener counts return to zero.

- [x] **Step 2: Implement the gate without unbounded promises or listeners**

The active operation owns its caller AbortSignal. Closing the gate aborts a
Runtime-owned signal that Playwright operations combine with the caller signal.

- [x] **Step 3: Run GREEN and leak checks**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser/browser-operation-gate.test.ts
```

- [x] **Step 4: Commit**

```bash
git add packages/cli/src/browser/BrowserOperationGate.ts \
  packages/cli/tests/unit/browser/browser-operation-gate.test.ts
git commit -m "feat(browser): bound session operation ordering"
```

### Task 4: Implement The Process-Wide Chromium Pool

**Files:**
- Create: `packages/cli/src/browser/BrowserProcessPool.ts`
- Create: `packages/cli/tests/unit/browser/browser-process-pool.test.ts`
- Modify: `packages/cli/src/browser/index.ts`

- [x] **Step 1: Write failing pool state-machine tests**

Inject a typed browser adapter and prove:

- no launch during construction or import;
- concurrent first acquisitions share one launch Promise;
- each successful acquisition creates one isolated context;
- the ninth context fails with `browser_capacity`;
- failed launch is not cached;
- lease release is the sole physical BrowserContext closer and closes exactly one
  context;
- final release closes the Browser process;
- acquire racing with final release cannot receive a closing process;
- `disconnected` invalidates one generation and all leases;
- invalidated leases leave capacity exactly once and later release is an idempotent
  no-op;
- explicit disposal rejects future acquisition and settles partial launch;
- stats contain counts only and return to zero.

- [x] **Step 2: Implement launch and context lease ownership**

Dynamic-import `playwright` only inside the default adapter's launch path. Pass the
sanitized environment, `chromiumSandbox: true`, and frozen context options. Assert
the effective Chromium command line does not contain `--no-sandbox`.

Use one internal mutex or single-flight state machine for launch/acquire/release.
The public lease exposes an idempotent async `release()`.

- [x] **Step 3: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser/browser-process-pool.test.ts
bun run type-check
```

- [x] **Step 4: Commit**

```bash
git add packages/cli/src/browser/BrowserProcessPool.ts \
  packages/cli/src/browser/index.ts \
  packages/cli/tests/unit/browser/browser-process-pool.test.ts
git commit -m "feat(browser): add isolated Chromium process pool"
```

### Task 5: Extract A Generic Private Session Artifact Store

**Files:**
- Create: `packages/cli/src/tools/artifacts/SessionArtifactStore.ts`
- Modify: `packages/cli/src/mcp/McpToolArtifactStore.ts`
- Create: `packages/cli/src/browser/BrowserArtifactStore.ts`
- Create: `packages/cli/tests/unit/browser/browser-artifact-store.test.ts`
- Modify: existing MCP artifact tests

- [x] **Step 1: Lock existing MCP behavior before extraction**

Ensure current tests cover:

- `0700` directories and `0600` files;
- owner and symlink rejection;
- SHA-256 content identity;
- idempotent duplicate writes;
- count and byte quotas;
- path omission when `exposePaths` is false.

Add missing tests before changing production code.

- [x] **Step 2: Write failing Browser artifact tests**

Assert Browser artifacts:

- use `browser-artifacts/<session-hash>`;
- accept only PNG screenshot bytes;
- reject files above 8 MiB;
- cap count at 32 and total bytes at 64 MiB;
- return validated SHA-256 descriptors;
- omit paths for ACP;
- never persist an oversized or partial file.

- [x] **Step 3: Extract the generic primitive**

Parameterize namespace, extensions, per-file bytes, count, Session bytes, and path
exposure. Keep `McpToolArtifactStore` as a typed wrapper so its public contract and
on-disk namespace do not change.

Browser artifacts survive Runtime disposal because committed tool results may refer
to them. Wire explicit Session deletion to remove the Browser artifact namespace and
test missing/already-removed directories.

- [x] **Step 4: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser/browser-artifact-store.test.ts \
  tests/unit/integrations/mcp/mcp-tool-result.test.ts
```

If the MCP artifact test has a different current filename, locate and run the full
matching file rather than weakening this gate.

- [x] **Step 5: Commit**

```bash
git add packages/cli/src/tools/artifacts/SessionArtifactStore.ts \
  packages/cli/src/mcp/McpToolArtifactStore.ts \
  packages/cli/src/browser/BrowserArtifactStore.ts \
  packages/cli/src/services/SessionService.ts \
  packages/cli/tests/unit/browser/browser-artifact-store.test.ts \
  packages/cli/tests/unit/integrations/mcp
git commit -m "refactor(artifacts): share private session storage"
```

### Task 6: Implement Snapshot And Ref Authority

**Files:**
- Create: `packages/cli/src/browser/BrowserSnapshotAuthority.ts`
- Create: `packages/cli/tests/unit/browser/browser-snapshot-authority.test.ts`

- [x] **Step 1: Write failing snapshot tests**

Cover:

- AI ARIA snapshot wrapper and untrusted-content markers;
- UTF-8 line-bound truncation at 48 KiB;
- default depth 12 and maximum depth 20;
- exact lowercase alphanumeric ref parsing, including `e12` and frame-prefixed
  `f5e12`;
- bounded role/name fingerprints;
- duplicate/malformed ref rejection;
- one latest authority per page;
- page generation and origin matching;
- attempted-action invalidation;
- attempted-action invalidation on timeout/failure and unchanged authority for
  precondition failures;
- navigation/disconnect/close invalidation;
- fresh fingerprint acceptance and mismatch rejection;
- no CSS, XPath, text, role, coordinate, or nth fallback.

- [x] **Step 2: Implement the pure authority**

The module accepts snapshot strings and page facts. It does not own Playwright
objects. Return typed stale reasons suitable for a single
`browser_snapshot_stale` projection.

- [x] **Step 3: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser/browser-snapshot-authority.test.ts
```

- [x] **Step 4: Commit**

```bash
git add packages/cli/src/browser/BrowserSnapshotAuthority.ts \
  packages/cli/tests/unit/browser/browser-snapshot-authority.test.ts
git commit -m "feat(browser): enforce snapshot ref authority"
```

### Task 7: Build The Session Browser Runtime

**Files:**
- Create: `packages/cli/src/browser/SessionBrowserRuntime.ts`
- Create: `packages/cli/tests/unit/browser/session-browser-runtime.test.ts`
- Modify: `packages/cli/src/browser/index.ts`

- [x] **Step 1: Write failing lifecycle and page tests**

With injected Playwright-shaped fakes, prove:

- first use creates one context and one blank page;
- repeat use reuses that context;
- distinct Session runtimes obtain distinct contexts;
- opaque page IDs never expose Playwright GUIDs;
- open/select/list/close behavior;
- closing the selected page selects the oldest remaining page;
- closing the last page leaves no page;
- next operation creates one blank page;
- popup registration and over-cap immediate closure;
- unexpected page closure invalidates IDs;
- browser disconnect invalidates all state;
- active and queued pre-disconnect operations fail `browser_disconnected` without
  replay;
- only later Navigate/Snapshot/Page-open calls acquire a new generation;
- Wait and Inspect fail with `browser_page_not_found` instead of implicitly
  recreating a Context after reset or disconnect;
- disposal settles while Context acquisition is pending and releases a late lease;
- disposal closes the gate and releases the sole context-closing lease exactly once.

- [x] **Step 2: Write failing origin-gate tests**

Use two origins and assert:

- explicit navigation authorizes only its normalized target origin;
- new `about:blank` pages have `authorizedOrigin=null` and reject interaction;
- explicit navigation uses a transient target grant and adopts it when the target
  document commits, even when a later load wait times out;
- navigation without a granted document commit retains the previous authorization
  only when the current page still has that origin; any other state clears it;
- every completed, failed, timed-out, aborted, or redirected navigation clears the
  transient grant and invalidates snapshots;
- same-origin redirect succeeds;
- cross-origin redirect is aborted before target document load;
- a click-triggered same-origin navigation succeeds;
- a click-triggered cross-origin navigation is blocked;
- popup top-level origin follows the same rule even before Chromium exposes its
  Frame; same-origin popups register and cross-origin popups close;
- cross-origin iframe refs are visible but rejected before interaction;
- same-origin `about:blank` and `about:srcdoc` frames inherit the nearest safe
  HTTP(S) ancestor while sandboxed opaque frames remain rejected;
- blocked output includes only the candidate origin;
- background script navigation without an active tool call is checked against the
  authorized origin, recorded as a diagnostic, and reported by the next Browser
  operation;
- subresources do not become top-level pages or new approvals.

Use `BrowserContext.route()` only for the internal top-level navigation guard. Tests
must prove the model has no route registration/fulfillment API and cannot bypass or
replace this handler.

- [x] **Step 3: Write failing diagnostics and download tests**

Prove bounded console, page-error, request, response, failure, dialog, popup-cap, and
download events. A click dialog policy applies to exactly one dialog, and a blocked
download fails the initiating interaction with `browser_download_blocked`. Assert no
headers, bodies, cookies, query values, object handles, or raw stacks survive.

- [x] **Step 4: Implement context/page/diagnostic ownership**

Attach every listener exactly once per page, detach it on close, and use one
Session-wide ring per diagnostic class with page IDs on entries. Bound all rings at
insertion time. Use the Browser operation gate around every public method.

- [x] **Step 5: Implement snapshot, action, wait, and inspection methods**

Use only public Playwright APIs. Before interaction:

1. validate page/snapshot/origin authority;
2. capture a fresh AI snapshot;
3. verify the ref fingerprint;
4. resolve `page.locator('aria-ref=<ref>')`;
5. require exactly one match;
6. use the public owner-frame API and reject a cross-origin frame;
7. reject the exact credential-control classes frozen in the design;
8. invalidate snapshot authority before Playwright invocation;
9. run the action with the combined AbortSignal and bounded timeout.

Return the exact discriminated result union from the design. If the action resolves
but observation fails, return
`outcome='applied_observation_failed'`, `actionApplied=true`, and
`sideEffectsUncertain=false`. If Playwright throws after invocation starts, return
`outcome='uncertain'`, `actionApplied='unknown'`,
`sideEffectsUncertain=true`, and apply exact precedence:
`browser_cross_origin_navigation`, `browser_disconnected`, `browser_timeout`, then
`browser_action_uncertain`. Never advise blind retry.

Non-timeout navigation failures after Playwright starts also retain
`browser_action_uncertain` and `sideEffectsUncertain=true`; validation failures
before invocation do not invalidate the existing snapshot authority.

Credential-control tests apply NFKC, whitespace collapse, trim, lowercase, the exact
ASCII pattern, accessible-name handling, lowercase autocomplete tokens, and
fail-closed 1 KiB candidate bounds. A non-empty `aria-labelledby` whose computed
name is omitted from the AI snapshot also fails closed for text entry.

`BrowserWait` uses exact visible text and exact fragment-free normalized URL
matching, and ref-state waits use the latest snapshot authority. Diagnostics return
the newest bounded entries in ascending sequence without consuming them; `find`
returns matching lines from a fresh snapshot. `BrowserPage(open)` selects its blank
page, while `reset` closes the complete Context; same-origin popups register without
changing selection and cross-origin popups close. Click may accept or dismiss one
expected dialog, and page-scoped scrolling is bounded.

- [x] **Step 6: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser/session-browser-runtime.test.ts \
  tests/unit/browser/browser-snapshot-authority.test.ts \
  tests/unit/browser/browser-operation-gate.test.ts \
  tests/unit/browser/browser-process-pool.test.ts
bun run type-check
```

- [x] **Step 7: Commit**

```bash
git add packages/cli/src/browser \
  packages/cli/tests/unit/browser/session-browser-runtime.test.ts
git commit -m "feat(browser): add session-isolated page runtime"
```

### Task 8: Add The Six Deferred Native Tools

**Files:**
- Create: `packages/cli/src/tools/builtin/browser/index.ts`
- Create: `packages/cli/src/tools/builtin/browser/browserTools.ts`
- Create: `packages/cli/tests/unit/tooling/tools/builtin/browser-tools.test.ts`
- Modify: `packages/cli/src/tools/builtin/index.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/registry/deferred-tool-manager.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/registry/tool-registry.test.ts`

- [x] **Step 1: Write failing schema and declaration tests**

Lock exact names, discriminated unions, defaults, bounds, descriptions, and
deferred ordering for:

- `BrowserNavigate`;
- `BrowserSnapshot`;
- `BrowserInteract`;
- `BrowserWait`;
- `BrowserInspect`;
- `BrowserPage`.

Assert none are added to `ALWAYS_LOADED_TOOLS`, and one exact `ToolSearch` call loads
all six schemas:

```json
{
  "query": "select:BrowserNavigate,BrowserSnapshot,BrowserInteract,BrowserWait,BrowserInspect,BrowserPage",
  "max_results": 6
}
```

- [x] **Step 2: Write failing ToolKind and permission-signature tests**

Assert:

- Navigate, Interact, and Page are `Execute`;
- Snapshot, Wait, and Inspect are `ReadOnly`;
- every tool is `parallelism: 'exclusive'`;
- Navigate and Interact signatures contain normalized origin only;
- Page signatures contain action only;
- signatures omit URL query values, fill/type values, ref, snapshot text, and title;
- project permission abstraction remains origin-scoped.

Add a negative hook test: a PreToolUse hook that changes an already-approved
Navigate or Interact origin must trigger permission recomputation and cannot inherit
the old approval.

- [x] **Step 3: Implement one Session-bound factory**

`createBrowserTools(runtime)` returns all six tools. Adapters only validate schemas,
call Runtime methods, and map typed Browser failures into canonical `ToolResult`.
Do not duplicate Playwright logic in tool files.

- [x] **Step 4: Register through `getBuiltinTools`**

Add a typed optional `browserRuntime` parameter. Registration must preserve tests
that call `getBuiltinTools` without a Runtime by omitting Browser tools in that
explicit legacy/test path.

- [x] **Step 5: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/browser-tools.test.ts \
  tests/unit/tooling/tools/registry/deferred-tool-manager.test.ts \
  tests/unit/tooling/tools/registry/tool-registry.test.ts
```

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/tools/builtin/browser \
  packages/cli/src/tools/builtin/index.ts \
  packages/cli/tests/unit/tooling/tools/builtin/browser-tools.test.ts \
  packages/cli/tests/unit/tooling/tools/registry
git commit -m "feat(tools): register deferred browser controls"
```

### Task 9: Bind Browser Ownership To SessionRuntime

**Files:**
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Modify: any SessionRuntime factory fixture that requires the new typed option

- [x] **Step 1: Write failing Runtime ownership tests**

Assert:

- constructing/initializing a SessionRuntime does not launch Chromium;
- built-in registration receives one exact SessionBrowserRuntime;
- root Agent, side conversation, and executor clones share that Session Runtime;
- separate SessionRuntime instances do not share BrowserContexts;
- tool whitelist/blacklist filters Browser tools normally;
- initialization failure disposes a partially acquired context;
- normal disposal closes browser resources before Session lease release;
- SessionBrowserRuntime releases its context lease but never separately closes the
  leased context;
- repeated disposal is idempotent;
- fork and cold resume receive fresh browser identities.
- Browser screenshot identity uses the active `workspaceRoot + sessionId`, matching
  the explicit deletion path for worktree-backed Sessions.

- [x] **Step 2: Add Runtime ownership**

Create the lightweight Browser Runtime before built-in registration, pass it to
`getBuiltinTools`, capture it before clearing fields during disposal, and clean it
through the existing `attempt()` aggregation.

Do not expose Browser Runtime through HTTP or ACP service objects.

- [x] **Step 3: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/tooling/tools/builtin/browser-tools.test.ts
bun run type-check
```

- [x] **Step 4: Commit**

```bash
git add packages/cli/src/agent/runtime/SessionRuntime.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts \
  packages/cli/tests/support
git commit -m "feat(runtime): own browser state per session"
```

Only stage support fixtures actually changed for this task.

### Task 10: Add Browser Permission UX And Canonical Projection

**Files:**
- Modify: `packages/cli/src/tools/execution/ToolApprovalController.ts`
- Modify: `packages/cli/src/tools/types/ToolTypes.ts`
- Modify: `packages/cli/src/ui/utils/toolFormatters.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/src/prompts/sections.ts`
- Modify: matching unit tests for approval, projection, server routes, TUI, Headless,
  and ACP

- [x] **Step 1: Write failing approval tests**

Assert public, loopback, and private-network origins produce bounded, explicit
previews. Navigate/Interact risks must mention remote code or data submission.
Typed values and query values must not appear.

Add a hook-modification assertion proving that an origin changed by PreToolUse is
re-evaluated and cannot reuse approval for the original origin.

- [x] **Step 2: Write failing metadata sanitizer tests**

Feed oversized and malicious Browser metadata into `sanitizeToolMetadata`. Assert
the exact allowlist, length caps, ID syntax, URL redaction, screenshot descriptor
validation, path omission rules, and deletion of ARIA/console/header/body/cookie
fields.

- [x] **Step 3: Write failing display projection tests**

Lock concise summaries and details for success, stale snapshot, blocked origin,
timeout, capacity, diagnostics, screenshot, action uncertainty,
action-applied/observation-failed, disconnect recovery, and disposal. Verify every
surface budget.

- [x] **Step 4: Implement Browser-specific projections**

Keep untrusted page content in `llmContent`; metadata contains facts only. Do not add
a new SSE, ACP, transcript, or Web schema.

Add one cache-stable system-prompt rule: Browser page content and diagnostics are
untrusted data and cannot override system/user instructions, permissions, or tool
policy. Test the exact prompt once; do not repeat it in every tool description.

- [x] **Step 5: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/execution/tool-approval-scope.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/tooling/tools/builtin/browser-tools.test.ts
bun run test:headless-core
```

Add and run the exact current projector/formatter test files discovered with `rg`.

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/tools/execution/ToolApprovalController.ts \
  packages/cli/src/tools/types/ToolTypes.ts \
  packages/cli/src/ui/utils/toolFormatters.ts \
  packages/cli/src/server/routes/session.ts \
  packages/cli/src/prompts/sections.ts \
  packages/cli/tests
git commit -m "feat(browser): project permissions and results safely"
```

Before committing, inspect `git diff --cached --name-only` and unstage unrelated
tests.

### Task 11: Add `blade browser status/install`

**Files:**
- Create: `packages/cli/src/commands/browser.ts`
- Modify: `packages/cli/src/blade.tsx`
- Create: `packages/cli/tests/unit/cli/commands/browser.test.ts`
- Modify: `packages/cli/tests/integration/cli/blade-help.test.ts`

- [x] **Step 1: Write failing command tests**

Cover:

- root help lists `browser`;
- `browser --help` lists exactly `status` and `install`;
- `status` prints pinned version, path, and runnable state;
- `status` prints the launched Chromium version;
- missing Chromium exits non-zero with `blade browser install`;
- `install` delegates once to the pinned CLI without shell or credential-bearing
  environment variables;
- installer signals/non-zero exits propagate;
- neither help nor status performs network access or installation.

- [x] **Step 2: Register the lazily imported command**

Match the existing Yargs command style. Keep heavy Browser imports inside handlers
so `blade --help` and `blade --version` stay fast.

- [x] **Step 3: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/cli/commands/browser.test.ts
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/cli/blade-help.test.ts
bun run build
node dist/blade.js browser status
```

- [x] **Step 4: Commit**

```bash
git add packages/cli/src/commands/browser.ts packages/cli/src/blade.tsx \
  packages/cli/tests/unit/cli/commands/browser.test.ts \
  packages/cli/tests/integration/cli/blade-help.test.ts
git commit -m "feat(cli): manage pinned browser runtime"
```

### Task 12: Prove The Contract With Real Keyless Chromium

**Files:**
- Create: `packages/cli/tests/integration/browser-tool-chromium.test.ts`
- Create only if reusable: `packages/cli/tests/support/browserToolFixtureServer.ts`
- Modify: test cleanup helpers only when a missing generic primitive is proven

- [x] **Step 1: Build two self-contained loopback fixture origins**

Fixtures must:

- use random reserved ports;
- load no external resource;
- expose buttons, textboxes, checkbox, select, same-origin route, cross-origin link,
  popup, dialog, console marker, page error, and attempted download;
- replace a referenced DOM node to test stale detection;
- retain bounded server-side request evidence;
- own explicit shutdown and port-release assertions.

- [x] **Step 2: Write the complete real Chromium test**

Use the default Playwright adapter, not fakes. Cover every item in the spec's keyless
Chromium sequence, including viewport screenshot file verification.

Prove `page.ariaSnapshot({ mode: 'ai' })` emits refs and
`page.locator('aria-ref=<ref>')` operates the intended element on the pinned version.

Also prove:

- cross-origin iframe refs are rejected;
- same-origin popups remain registered, cross-origin popups close, and popup
  capacity is enforced;
- one dialog authorization is consumed once and a blocked download returns
  `browser_download_blocked`;
- invalid navigation arguments leave the latest snapshot usable;
- non-timeout navigation failure reports uncertain side effects;
- Wait and Inspect do not recreate a Context after reset;
- a resolved action followed by snapshot failure reports `actionApplied=true`;
- a thrown/timed-out action reports `sideEffectsUncertain=true` and is not replayed;
- an empty browser cache plus blocked installer/network makes tool calls fail
  `browser_not_installed` without download activity.

- [x] **Step 3: Add failure-path cleanup**

The test `finally` block must close the Session Runtime, then explicitly dispose the
pool test singleton, fixture servers, and temporary roots. It must not close pages
or BrowserContexts directly; context leases are their sole physical close authority.
After cleanup assert:

- both ports are reusable;
- Browser pool counts are zero;
- no owned Chromium process remains;
- no screenshot outside the owned temporary storage root was created;
- no expected download file exists.

- [x] **Step 4: Run GREEN repeatedly without framework retry**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/browser-tool-chromium.test.ts
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/browser-tool-chromium.test.ts
```

Two clean first-attempt runs check lifecycle stability; do not encode retry.

- [x] **Step 5: Commit**

```bash
git add packages/cli/tests/integration/browser-tool-chromium.test.ts \
  packages/cli/tests/support/browserToolFixtureServer.ts
git commit -m "test(browser): verify real Chromium controls"
```

Only include the support file when created.

### Task 13: Build The Real-API Multi-Surface Harness

**Files:**
- Create: `packages/cli/tests/integration/real-api/browser-tool-fixture.ts`
- Create: `packages/cli/tests/support/browserToolHeadlessDriver.ts`
- Create: `packages/cli/tests/support/browserToolPtyDriver.ts`
- Create: `packages/cli/tests/support/browserToolPtyRunner.ts`
- Create: `packages/cli/tests/support/browserToolWebDriver.ts`
- Create: `packages/cli/tests/support/browserToolAcpDriver.ts`
- Create: `packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts`
- Modify: `packages/cli/tests/unit/scripts/test-runner.test.ts`

- [x] **Step 1: Freeze the prompt and hidden evidence**

The nonce exists only in the post-submit DOM. The prompt explicitly requires:

1. the exact ToolSearch request frozen in the design;
2. navigation to the supplied loopback fixture;
3. snapshot-only ref discovery;
4. form interaction;
5. explicit wait;
6. console/network inspection;
7. second-page open/select/list/close;
8. final nonce response.

The prompt must not contain the nonce, expected final response, target refs, or an
alternative shell/fetch route.

The trace may contain a fail-closed `browser_snapshot_stale` interaction only when a
later successful `BrowserSnapshot` and successful `BrowserInteract` prove recovery.
No other Browser failure is accepted, and the harness does not cap legitimate stale
recoveries with an arbitrary count threshold.

- [x] **Step 2: Build shared host assertions**

Use the existing canonical transcript helpers from
`sessionForkTrajectoryHarness.ts` in the trajectory and prove:

- all six schemas were loaded once;
- the expected tools and order were used;
- page/snapshot/ref/origin values form one valid chain;
- no selector or evaluate fields exist;
- no unexpected tool or browser request occurs;
- every interaction result is durable exactly once;
- live and fresh-load surface projections agree;
- Browser pool and Session coordination return to zero;
- complete credential and temporary-resource scans pass.

- [x] **Step 3: Add Headless and raw PTY drivers**

Headless uses the production entry and canonical output. TUI uses real `bun-pty`,
visible permission behavior or explicit YOLO configuration, and waits on durable
turn completion rather than terminal-history polling.

- [x] **Step 4: Add Web and ACP drivers**

Web:

- builds and serves production assets;
- uses an outer pinned Chromium;
- submits through the real composer;
- observes inner Browser Tool cards;
- reloads and verifies durable results;
- distinguishes expected EventSource abort from actual request faults.

ACP:

- uses the real SDK over paired NDJSON-compatible streams;
- observes canonical tool updates;
- closes the Session through the standard protocol;
- receives no local screenshot artifact path.

- [x] **Step 5: Define the fixed eight-cell matrix**

Use exact catalog IDs `deepseek-v4-flash` and `deepseek-v4-pro`, the repository's
release qualification sampling configuration, and all four surfaces. Set test-level
and host deadlines with cleanup margin, but keep Provider and framework retry at
zero. Provider nondeterminism is a release signal; an independently evidenced
Provider outage blocks release rather than converting a rerun into a first-pass
success.

- [x] **Step 6: Run harness source gates and the complete real matrix**

The source gate fixes all four surfaces, both model IDs, the exact ToolSearch
selection, and all six tool names. The complete Provider matrix, not a dry path, is
the release evidence.

- [x] **Step 7: Commit**

```bash
git add packages/cli/tests/integration/real-api/browser-tool-fixture.ts \
  packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts \
  packages/cli/tests/support/browserToolHeadlessDriver.ts \
  packages/cli/tests/support/browserToolPtyDriver.ts \
  packages/cli/tests/support/browserToolPtyRunner.ts \
  packages/cli/tests/support/browserToolWebDriver.ts \
  packages/cli/tests/support/browserToolAcpDriver.ts \
  packages/cli/tests/unit
git commit -m "test(browser): qualify native tools across surfaces"
```

Inspect the staged unit-test set before commit.

### Task 14: Wire Qualification And Source Gates

**Files:**
- Modify: `packages/cli/scripts/test-config.js`
- Modify if required: `packages/cli/scripts/test-config.d.ts`
- Modify: `packages/cli/tests/unit/scripts/test-runner.test.ts`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`
- Modify: `packages/cli/tests/unit/scripts/browser-check.test.ts`

- [x] **Step 1: Add failing manifest/source tests**

Assert:

- `browser-tool-trajectory.test.ts` is present in
  `realApiQualification.files`;
- framework retry is zero;
- Chromium preflight precedes paid Provider tests;
- Playwright is a runtime dependency;
- the six tools remain deferred;
- no private Playwright import, arbitrary evaluate, persistent context, storage
  state, upload, or download-enabling call exists in production Browser sources;
- production Browser tools do not inherit `process.env`;
- Browser logs never emit raw Playwright stacks, page text, or unredacted URLs.

- [x] **Step 2: Add the trajectory to the manifest**

Do not create an optional flag that lets the normal release command skip it.

- [x] **Step 3: Run GREEN**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/test-runner.test.ts \
  tests/unit/scripts/qualification.test.ts \
  tests/unit/scripts/browser-check.test.ts
```

- [x] **Step 4: Commit**

```bash
git add packages/cli/scripts/test-config.js \
  packages/cli/scripts/test-config.d.ts \
  packages/cli/tests/unit/scripts
git commit -m "test(qualification): require native browser matrix"
```

Do not stage `test-config.d.ts` if it did not change.

### Task 15: Document The Browser Tool Contract

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/getting-started/installation.md`
- Modify: `docs/en/getting-started/installation.md`
- Modify: current Chinese and English tool-catalog files
- Modify: Chinese and English CLI-command and permission references
- Modify: `docs/testing/qualification.md`
- Modify: `docs/en/testing/qualification.md`
- Modify only if needed: `AGENTS.md`

- [x] **Step 1: Locate canonical documentation paths**

Use `rg` before editing. The docs site is bilingual; do not edit generated
`docs/changelog.md` or `docs/en/changelog.md`.

- [x] **Step 2: Update installation and status**

Document:

```bash
npm install --global blade-code@0.10.87
blade browser install
blade browser status
```

State that npm installation does not download Chromium automatically.

- [x] **Step 3: Document tool selection and safety**

Explain:

- WebSearch for indexed discovery;
- WebFetch for static retrieval;
- Browser tools for JavaScript, forms, DOM state, and UI verification;
- six tool names and deferred ToolSearch loading;
- Session isolation and ephemeral state;
- origin permission and stale-snapshot rules;
- unsupported actions and data;
- independence from Browser Preview.

- [x] **Step 4: Document qualification**

Add the keyless Chromium contract and fixed Flash/Pro x four-surface matrix in both
languages.

- [x] **Step 5: Check links, headings, and generated-file exclusions**

```bash
rg -n "BrowserNavigate|blade browser install|Browser Preview" \
  README.md docs packages/cli/README.md
git diff --check
```

- [x] **Step 6: Commit**

```bash
git add README.md docs AGENTS.md
git commit -m "docs(browser): document native automation contract"
```

Do not stage `AGENTS.md` when no durable project rule changed.

### Task 16: Run Deterministic Completion Gates And Review

**Files:**
- Modify only defects found by review
- No version or changelog change

- [ ] **Step 1: Run focused Browser suites**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/browser \
  tests/unit/tooling/tools/builtin/browser-tools.test.ts \
  tests/unit/cli/commands/browser.test.ts
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/browser-tool-chromium.test.ts \
  tests/integration/cli/blade-help.test.ts
```

- [ ] **Step 2: Run static and build gates**

From repository root:

```bash
bun run type-check
bun run format:check
bun run lint
bun run build
```

- [ ] **Step 3: Run complete local test classes**

```bash
bun run test:unit
bun run test:integration
bun run test:cli
bun run test:headless-core
bun run test:e2e
bun run test:snapshot
bun run test:security
bun run test:performance
bun run test:web
bun run type-check:web
bun run test:coverage
```

- [ ] **Step 4: Run browser and package checks**

```bash
bun run --filter blade-code browser:check
node packages/cli/dist/blade.js browser status
npm pack --dry-run --workspace packages/cli
```

Inspect the tarball manifest and dependency metadata. Verify no browser binary,
profile, screenshot, trace, credentials, or test fixture is packed.

If the installed npm version does not support `--workspace` for this command, run
`npm pack --dry-run` from `packages/cli`; do not skip package-content inspection.

Install the local tarball with the default environment into a fresh HOME and
Playwright cache. Do not set a skip-download variable. Assert the cache stays empty,
the installed Playwright package has no lifecycle install script, Browser tool calls
fail `browser_not_installed`, and no installer child or network request starts.
Remove the temporary install root afterward.

- [ ] **Step 5: Perform two-axis code review**

Review all changes since the planning commit for:

- spec compliance;
- process/context/page ownership;
- abort and disposal races;
- permission bypasses;
- redirect and popup origin bypasses;
- stale ref and selector fallback;
- unbounded output or queues;
- metadata/transcript credential leakage;
- private Playwright imports;
- cross-surface divergence;
- missing negative tests.

Fix findings in focused commits and rerun affected gates.

- [ ] **Step 6: Run Local Qualification**

```bash
bun run qualify:local
```

Record the exact candidate SHA. Any later source/test change requires rerunning this
task.

### Task 17: Freeze The `0.10.87` Release Candidate

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`

- [ ] **Step 1: Verify scope and version**

Confirm:

- previous public version is `0.10.86`;
- target is exactly `0.10.87`;
- commits since `v0.10.86` contain only this Browser Tool feature and its docs/tests;
- no breaking public API is claimed;
- npm package files and runtime dependency graph are correct.

- [ ] **Step 2: Write synchronized release notes**

Both changelogs must cover:

- native deferred Browser tools;
- Session-isolated shared Chromium architecture;
- ARIA snapshot/ref and origin permission safety;
- browser install/status commands;
- output/artifact/resource bounds;
- deterministic Chromium and eight-cell real API qualification.

- [ ] **Step 3: Set package version**

Update only `packages/cli/package.json` to `0.10.87`. Do not edit generated docs
changelog files.

- [ ] **Step 4: Validate release diff**

```bash
git diff --check
git diff -- packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md
git commit -m "chore: release v0.10.87"
```

The resulting commit becomes the fixed qualification candidate.

### Task 18: Run Fixed-HEAD Production Qualification

**Files:**
- Create after the release-candidate qualification:
  - `docs/testing/native-browser-tool-evidence.md`
  - `docs/en/testing/native-browser-tool-evidence.md`

- [ ] **Step 1: Capture and freeze candidate identity**

```bash
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Worktree must be clean before starting. Do not rebase, amend, or edit during the
qualification run.

- [ ] **Step 2: Run browser preflight before paid APIs**

```bash
bun run --filter blade-code browser:check
```

Missing Chromium requires the explicit install command followed by a fresh
preflight. The check itself must not download.

- [ ] **Step 3: Run Production Qualification**

Use the repository's restricted credential materializer. Optional Provider channels
may be explicitly disabled when they are not part of the required DeepSeek matrix;
do not print or rewrite credentials.

```bash
bun run qualify:production
```

Required evidence:

- every local check passed;
- Browser preflight passed;
- every release-blocking real API file passed;
- all eight Browser Tool cells passed in the final fixed-source run with framework
  retry zero;
- candidate HEAD did not change.

- [ ] **Step 4: Write bilingual pre-seal evidence**

Record:

- exact release-candidate source SHA and timestamp;
- toolchain versions;
- commands and exit status;
- deterministic test counts;
- eight-cell model/surface durations;
- Browser process/context/page/queue maxima and final zeros;
- outer/inner Chromium facts for Web cells;
- request, secret, transcript, artifact, and cleanup assertions;
- retry count;
- log hashes, not credentials or raw Provider payloads.

- [ ] **Step 5: Commit evidence**

Evidence files change HEAD. Commit them:

```bash
git add docs/testing/native-browser-tool-evidence.md \
  docs/en/testing/native-browser-tool-evidence.md
git commit -m "docs(testing): record native browser qualification"
```

The evidence explicitly labels its SHA as the pre-seal release-candidate source
commit. It also states that the final annotated tag will carry the final-HEAD seal.
It must not claim that its own commit hash was known in advance.

- [ ] **Step 6: Run the final seal at the evidence commit**

Capture the new HEAD, then rerun Local and Production Qualification without editing
the worktree. Write command output to restricted temporary logs and calculate their
hashes. A failure reopens the candidate: fix it, regenerate pre-seal evidence, and
repeat this task. A pass freezes this HEAD; do not edit repository files afterward.

The final HEAD, final qualification result/counts, zero retry count, timestamps, and
log hashes go into the annotated tag and GitHub Release attestation in Task 19. This
out-of-tree attestation avoids an impossible commit-SHA self-reference.

### Task 19: Audit Completion, Tag, Push, And Verify Publication

- [ ] **Step 1: Build the prompt-to-artifact completion checklist**

Use the checklist below and actual source/test/evidence paths. No sampled audit is
accepted.

- [ ] **Step 2: Verify final repository state**

```bash
git status --short --branch
git rev-parse HEAD
git log v0.10.86..HEAD --oneline
git diff v0.10.86..HEAD --stat
```

Confirm the final HEAD equals the last fully qualified SHA.

- [ ] **Step 3: Create release notes and final qualification attestation**

Extract the `0.10.87` section from `CHANGELOG.md` into a UTF-8 temporary file, then
append the final qualification attestation from Task 18. The attestation contains
the exact final HEAD and restricted-log hashes without secrets.

```bash
git tag -a v0.10.87 -F <release-notes-file>
git cat-file -t v0.10.87
git rev-list -n 1 v0.10.87
```

The type must be `tag`, and dereferencing must equal qualified HEAD.

- [ ] **Step 4: Push main and tag**

```bash
git push origin main
git push origin v0.10.87
```

- [ ] **Step 5: Monitor all publication workflows**

Require success for:

- CI/CD, including Coverage;
- Publish on Tag;
- Deploy Docs;
- GitHub Release creation.

Verify the remote tag dereferences to the fixed SHA. If the publish workflow creates
release notes from the changelog only, update the GitHub Release with the same
temporary notes-and-attestation file used for the annotated tag.

- [ ] **Step 6: Verify npm with a cold install**

Use a fresh temporary root and public registry:

```bash
npm view blade-code version
npm view blade-code@0.10.87 dist.tarball
```

Install with the default environment into a fresh HOME/cache, then verify:

- installed package version is `0.10.87`;
- `blade --version` is `0.10.87`;
- `blade browser --help` exposes status/install;
- `blade browser status` uses the pinned runtime and fails with the explicit install
  command when that fresh cache is empty;
- package installation created no browser download or Playwright cache entry;
- the installed Playwright package has no lifecycle install script.

Then point `PLAYWRIGHT_BROWSERS_PATH` at the already-qualified pinned browser cache
and verify `blade browser status` reports the expected Playwright and launched
Chromium versions. Do not download another browser during cold-install verification.

- [ ] **Step 7: Reclaim all release resources**

Remove release notes, logs, npm roots, Browser profiles, screenshots, and owned test
roots. Stop owned browser/server/proxy/PTY/ACP processes and verify all reserved
ports are free.

- [ ] **Step 8: Final audit**

Require:

- clean worktree;
- `main == origin/main == v0.10.87^{}`;
- one checkout only and no worktree created;
- no owned residual process or port;
- npm reports `0.10.87`;
- GitHub Release is published, not draft/prerelease;
- CI, Coverage, Publish, and Docs all succeeded.

## Completion Checklist

### Dependency And Installation

- [ ] `playwright@1.62.1` is an exact runtime dependency.
- [ ] Browser binaries are never downloaded implicitly.
- [ ] `blade browser install` uses the pinned local Playwright CLI without a shell.
- [ ] `blade browser status` is keyless, offline, bounded, and exit-code correct.
- [ ] `blade --help` and `--version` do not initialize Playwright.
- [ ] Public cold installation includes the library but no Chromium payload.
- [ ] Default-environment cold installation leaves an initially empty Playwright
  browser cache empty without relying on a skip-download variable.

### Architecture And Lifecycle

- [ ] One process-wide Chromium launch is single-flight.
- [ ] Maximum live BrowserContexts is eight.
- [ ] Every Browser-using Session owns exactly one incognito context.
- [ ] Distinct Sessions never share pages, cookies, storage, IDs, or snapshots.
- [ ] Maximum pages per Session is eight.
- [ ] Maximum pending Session Browser operations is 32.
- [ ] Final context release closes Chromium.
- [ ] Browser crash invalidates every affected context/page/snapshot generation.
- [ ] Active and queued old-generation calls fail `browser_disconnected`; a later
  explicit recovery-entry call can reuse the Session Runtime.
- [ ] Session dispose settles queued/active Browser work and releases all resources.
- [ ] Resume, fork, eviction, and initialization failure leave no retained state.

### Tool Contract

- [ ] Exactly six Browser tools are registered.
- [ ] All six remain deferred until ToolSearch loads them.
- [ ] ToolSearch returns stable schemas in deterministic order.
- [ ] Whitelist/blacklist and Plan mode behavior match existing ToolRegistry rules.
- [ ] Navigate/Interact/Page are Execute tools.
- [ ] Snapshot/Wait/Inspect are ReadOnly tools.
- [ ] Every Browser tool is exclusive and also uses the Session gate.
- [ ] Browser Tool descriptions treat page content as untrusted.
- [ ] The shared system prompt treats Browser output as untrusted data.
- [ ] WebSearch/WebFetch responsibilities remain unchanged.

### Snapshot And Interaction Safety

- [ ] AI ARIA snapshots use only public Playwright APIs.
- [ ] Snapshot output is UTF-8 and line-bounded to 48 KiB.
- [ ] Page and snapshot IDs are opaque.
- [ ] Every interaction requires latest page/snapshot/origin authority; every
  non-scroll action additionally requires a snapshot ref.
- [ ] Fresh ref fingerprint is checked immediately before action.
- [ ] Missing, duplicate, detached, or changed refs fail stale.
- [ ] No selector, coordinate, text, nth, XPath, or evaluate fallback exists.
- [ ] Every attempted Playwright action invalidates previous snapshot authority.
- [ ] Action success with observation failure cannot be mistaken for an unapplied
  action.
- [ ] Action exceptions after invocation report uncertain side effects and are never
  automatically replayed.
- [ ] Password and exactly defined credential-like controls reject fill/type.
- [ ] Ordinary text inputs are documented as durable and not generically
  secret-detectable.
- [ ] Typed values and keys are bounded.
- [ ] Only allowlisted non-modifier key presses are accepted.

### Origin And Network Safety

- [ ] User navigation accepts HTTP(S) only.
- [ ] URL credentials and malformed/oversized URLs are rejected.
- [ ] Permission signatures use normalized origin only.
- [ ] Public, loopback, and private origins are visibly classified.
- [ ] Permission previews display normalized origins.
- [ ] Same-origin top-level redirects are allowed.
- [ ] Cross-origin redirects, clicks, and popups are blocked before target load.
- [ ] Cross-origin iframe refs cannot inherit top-level origin approval.
- [ ] Same-origin inherited frames remain interactable; sandboxed opaque frames do
  not inherit approval.
- [ ] Background cross-origin navigation is reported by the next Browser operation.
- [ ] Internal route guarding cannot be configured or bypassed by the Agent.
- [ ] A new explicit BrowserNavigate call is required for a new origin.
- [ ] No Provider secret enters Chromium's process environment.
- [ ] No arbitrary project Session environment enters Chromium.
- [ ] Browser diagnostics omit headers, bodies, cookies, and query values.
- [ ] Browser errors and debug logs omit raw stacks, page text, and unredacted URLs.
- [ ] Downloads, uploads, clipboard, browser permissions, and persistent profiles are
  unavailable.

### Bounds And Artifacts

- [ ] Console, page-error, and network rings each cap at 256.
- [ ] Diagnostic output caps at 100 entries and 4 KiB per entry.
- [ ] Every Browser Tool total `llmContent` caps at 64 KiB.
- [ ] Navigation/action/wait timeouts enforce frozen maxima.
- [ ] Browser snapshot output stays below generic ToolResult disk offload.
- [ ] Screenshot is viewport-only and capped at 8 MiB.
- [ ] Screenshot count is 32 and Session bytes are 64 MiB.
- [ ] Artifact directories/files enforce `0700`/`0600`, owner, and no-symlink rules.
- [ ] Artifact write and deletion identities resolve equivalent workspace paths to
  one namespace.
- [ ] ACP omits local screenshot paths.
- [ ] ACP receives screenshot identity only and cannot retrieve PNG bytes through
  Browser tools.
- [ ] Metadata uses a Browser-specific allowlist.
- [ ] Metadata never contains snapshot, typed value, console, header, body, cookie,
  or raw Playwright stack content.

### Surface Consistency

- [ ] TUI consumes canonical Browser ToolResult.
- [ ] Headless text/JSON/JSONL consumes canonical Browser ToolResult.
- [ ] Web live SSE and durable reload show the same Browser result.
- [ ] ACP consumes the same result without filesystem-only detail.
- [ ] Tool cards and output stay within existing surface budgets.
- [ ] Browser Preview remains independent and unchanged.

### Deterministic Verification

- [ ] Pure policy tests cover every boundary and rejection.
- [ ] Pool tests cover single-flight, capacity, failure, crash, and release races.
- [ ] Gate tests cover FIFO, abort, capacity, close, and listener cleanup.
- [ ] Runtime tests cover every page and diagnostic lifecycle.
- [ ] Snapshot tests cover refs, fingerprints, stale state, and no fallback.
- [ ] Artifact tests cover ownership, symlink, hash, file, count, and byte bounds.
- [ ] Permission, hook, registry, sanitizer, and surface tests pass.
- [ ] Real keyless Chromium covers two origins and all six tool capabilities.
- [ ] Runtime launch options and the effective Chromium command line prove sandbox
  enforcement.
- [ ] Empty-cache package and tool-call tests prove no implicit Chromium download.
- [ ] Real keyless Chromium leaves zero process, port, page, context, and temp residue.
- [ ] Full unit, integration, CLI, Headless, E2E, snapshot, security, performance,
  Web, type, format, lint, build, and coverage gates pass.

### Real API Qualification

- [ ] The Browser Tool trajectory is fixed in `realApiQualification.files`.
- [ ] DeepSeek Flash passes Headless, raw PTY, production Web, and ACP.
- [ ] DeepSeek Pro passes Headless, raw PTY, production Web, and ACP.
- [ ] Every cell discovers all six tools through ToolSearch.
- [ ] Every cell uses only snapshot-issued IDs and refs.
- [ ] Web cells prove outer and inner Chromium coexist and clean up.
- [ ] Framework retry is zero.
- [ ] Credentials are absent from every browser, surface, transcript, and log sink.
- [ ] All contexts, pages, browsers, servers, ports, PTYs, ACP links, Session leases,
  and temporary roots are reclaimed.

### Documentation And Release

- [x] Chinese and English install, tools, and qualification docs agree.
- [x] README names the capability and install command.
- [x] Generated docs changelog files were not edited.
- [ ] `CHANGELOG.md` and `CHANGELOG.zh.md` describe the same `0.10.87` release.
- [ ] Package version is exactly `0.10.87`.
- [ ] Local Qualification passed at final HEAD.
- [ ] Production Qualification passed at the same final HEAD.
- [ ] Repository evidence records the pre-seal source SHA, counts, matrix, retries,
  and cleanup.
- [ ] Annotated tag and GitHub Release attestation record the exact final qualified
  HEAD and log hashes without changing that HEAD.
- [ ] Annotated `v0.10.87` tag dereferences to final qualified HEAD.
- [ ] `main`, `origin/main`, and the tag agree.
- [ ] npm, GitHub Release, CI, Coverage, Publish, and Docs are successful.
- [ ] Public-registry cold install and CLI smoke pass.
- [ ] Final worktree, process, port, profile, and temporary-root audit is clean.

## Plan Self-Review Checklist

- [x] The plan implements the frozen sibling design without expanding scope.
- [x] Every stateful action passes through existing permission and hook machinery.
- [x] Session isolation and process sharing have separate owners.
- [x] Cross-executor races are closed inside SessionBrowserRuntime.
- [x] Context, page, queue, diagnostics, output, artifact, and timeout bounds are
  explicit.
- [x] Cross-origin top-level transitions cannot inherit prior approval.
- [x] Snapshot IDs defend against stale tool history, with fresh ref fingerprint
  validation for live DOM changes.
- [x] No arbitrary evaluate or selector escape hatch is present.
- [x] Playwright runtime packaging and explicit browser installation are covered.
- [x] Browser process environment excludes Provider and project secrets.
- [x] Browser metadata has a server-side allowlist.
- [x] The generic artifact extraction preserves existing MCP behavior.
- [x] The real Chromium test is keyless and uses no Playwright mock.
- [x] The real API matrix covers two models and all four production surfaces.
- [x] Production Web explicitly tests nested outer/inner Chromium ownership.
- [x] Qualification precedes tag/push and runs at one fixed HEAD.
- [x] Evidence, npm cold install, workflow monitoring, and resource reclamation are
  release-blocking.
- [x] No git worktree is created.
