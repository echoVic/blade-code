# Native Browser Tool Design

**Target:** `blade-code@0.10.87`

**Status:** Frozen for implementation

## Objective

Add a Playwright-backed Browser Tool that lets the Agent inspect and operate real
web pages from every Blade execution surface.

The release must:

- expose browser automation through Blade's native ToolRegistry rather than MCP;
- use the public `playwright` package pinned by Blade;
- share one lazily launched Chromium process while isolating every Session in its
  own incognito `BrowserContext`;
- provide deterministic ARIA snapshots with opaque page and snapshot identities;
- reject stale element references and unexpected origin changes before acting;
- run every operation through existing permissions, hooks, admission, cancellation,
  persistence, and surface projection;
- keep browser output, diagnostics, pages, contexts, artifacts, and processes
  explicitly bounded;
- fail closed when the pinned Chromium executable is unavailable;
- provide explicit `blade browser install` and `blade browser status` commands;
- qualify the same tool contract through Headless, raw PTY TUI, production Web, and
  real ACP with DeepSeek Flash and Pro.

## Current Gap

Blade currently has three browser-adjacent capabilities, none of which gives the
Agent an interactive browser:

1. `WebSearch` discovers indexed content.
2. `WebFetch` performs bounded HTTP retrieval.
3. The Web UI Browser Preview displays a user-controlled sandboxed iframe.

The Preview cannot be addressed by Agent tools, many sites refuse framing through
CSP or `X-Frame-Options`, and neither network tool owns a DOM, JavaScript runtime,
page history, tabs, actionability checks, console stream, or screenshot.

The Browser Tool is therefore a new Runtime capability. It does not turn the
existing iframe into an automation target and does not replace `WebSearch` or
`WebFetch`.

## Reference Audit

### Playwright

Blade already pins Playwright `1.62.1` for production Chromium qualification. Its
public API provides:

- isolated `BrowserContext` instances;
- deterministic locator actionability;
- `page.ariaSnapshot({ mode: 'ai' })`, including `[ref=eN]` references;
- `page.locator('aria-ref=eN')` lookup for those references;
- page, popup, dialog, console, request, response, and failure lifecycle events;
- cancellation-aware snapshot calls and bounded action timeouts.

A local probe against the pinned package verified that an AI ARIA snapshot ref can
be resolved through `page.locator('aria-ref=...')`. Product code must not import
`playwright-core/lib/*`, `coreBundle.js`, Playwright MCP internals, or other private
modules.

### Playwright MCP

Playwright MCP demonstrates that an accessibility snapshot plus short-lived refs is
a compact Agent-facing interaction protocol. Blade adopts that interaction shape,
not the MCP server or its private implementation. Native tools preserve Blade's
permission, Session, hook, transcript, and cancellation semantics.

### Claude Code And Codex

Leading coding agents keep browser automation separate from passive fetch/search
and gate stateful browser actions explicitly. Blade follows the same separation:
search and static retrieval stay cheap, while a real browser is loaded only when a
task needs JavaScript, DOM state, forms, or UI verification.

## Scope

`v0.10.87` includes:

- one process-wide Chromium owner;
- one ephemeral BrowserContext per Session that uses Browser Tools;
- six deferred tools:
  - `BrowserNavigate`;
  - `BrowserSnapshot`;
  - `BrowserInteract`;
  - `BrowserWait`;
  - `BrowserInspect`;
  - `BrowserPage`;
- ARIA-ref interaction;
- tab creation, selection, listing, and closure;
- viewport screenshots stored as private bounded artifacts;
- bounded console, page-error, request, response, and request-failure diagnostics;
- explicit browser install/status CLI commands;
- generic TUI, Headless, Web, and ACP tool-result presentation;
- deterministic and real-API release gates.

## Non-Goals

The first release does not include:

- synchronizing the Agent browser with the Web UI Browser Preview;
- screencast streaming, headful mode, DevTools, or human takeover;
- persistent profiles, cookies, local storage, login state, or cross-Session reuse;
- extension loading;
- arbitrary CSS/XPath selectors supplied by the model;
- arbitrary JavaScript or `page.evaluate`;
- file upload, download retention, clipboard access, geolocation, camera, or
  microphone access;
- password-field and detected credential-control entry;
- response bodies, request bodies, request headers, cookies, or storage-state
  inspection;
- interaction with refs owned by a cross-origin iframe;
- PDF generation, tracing, HAR recording, Agent-authored network mocking, or
  Agent-authored route handlers;
- browser CPU, RSS, network-byte, request-count, or remote-content isolation beyond
  the documented Playwright timeouts and Blade-owned retention bounds;
- automatic Chromium downloads;
- an additional LLM layer such as Stagehand;
- replacing `WebSearch` or `WebFetch`.

Screencast-to-Preview observation and human takeover require a later patch with a
separate transport, authorization, and UI lifecycle.

## Architecture

```text
Agent loop
  -> ToolExecutor
       -> permission rules / approval / hooks / admission / cancellation
       -> deferred native Browser tools
            -> SessionBrowserRuntime
                 -> bounded per-Session operation gate
                 -> page registry + snapshot authority + diagnostic rings
                 -> one ephemeral BrowserContext
                      -> BrowserProcessPool
                           -> one lazy Playwright Chromium process
```

### BrowserProcessPool

`BrowserProcessPool` is the only owner of the Playwright `Browser` process.

It provides:

- single-flight lazy launch;
- a hard maximum of eight live BrowserContexts;
- one context lease per `SessionBrowserRuntime`; the lease is the sole authority
  that physically closes its BrowserContext and decrements pool capacity;
- generation tracking across browser crashes;
- immediate process closure when the last context lease is released;
- explicit global disposal for graceful shutdown and tests;
- aggregate statistics containing counts only.

The pool never queues context allocation. Capacity failure is immediate and typed as
`browser_capacity`, allowing the Agent to retry after another Session releases its
context.

The Browser process is shared only while at least one Session owns a context. It is
not kept alive after the last Session closes, so Headless, print, TUI, Web, and ACP
processes retain their existing exit behavior.

### SessionBrowserRuntime

Every initialized `SessionRuntime` owns one lightweight
`SessionBrowserRuntime`. Construction does not launch Chromium.

The first Browser operation lazily acquires:

1. one process-pool context lease;
2. one incognito BrowserContext;
3. one `about:blank` page.

The Runtime owns the exclusive right to use one context lease and owns:

- the BrowserContext;
- a maximum of eight pages;
- opaque page IDs;
- the selected page ID;
- the latest snapshot authority per page;
- the approved top-level origin per page;
- bounded diagnostic rings;
- a FIFO operation gate with at most 32 pending operations.

All six tools use the same exclusive Session operation gate, including tools marked
`ReadOnly`. This prevents races across root turns, side conversations, or distinct
ToolExecutor instances that share one SessionRuntime.

`SessionRuntime.dispose()` closes the Browser operation gate, aborts queued work,
invalidates every page and snapshot ID, and releases the context lease before
releasing the Session lease. The lease closes the BrowserContext exactly once.
Initialization failure uses the same cleanup path.

An unexpected Browser disconnect increments both pool and Session browser
generations. The active operation and every operation queued under the old generation
fail with `browser_disconnected`; none is replayed against new state. The operation
gate remains usable. A later `BrowserNavigate`, `BrowserSnapshot`, or
`BrowserPage(open)` call may explicitly acquire a fresh context generation. Calls
carrying old page or snapshot IDs fail stale/not-found without creating state.
Invalidated leases are already removed from pool capacity; later `release()` calls
are idempotent no-ops.

A resumed or forked Session receives a new BrowserContext. Browser state is never
reconstructed from the transcript.

## Runtime Bounds

The first release fixes these constants:

| Resource | Bound |
| --- | ---: |
| BrowserContexts per Blade process | 8 |
| Pages per Session | 8 |
| Pending browser operations per Session | 32 |
| Console entries per Session | 256 |
| Page errors per Session | 256 |
| Network entries per Session | 256 |
| Snapshot UTF-8 bytes | 48 KiB |
| Snapshot depth | integer 1..20, default 12 |
| URL input | 8 KiB |
| Projected URL | 2 KiB |
| Fill/type value | 16 KiB |
| Page title | 512 bytes |
| Diagnostic entry text | 4 KiB |
| Diagnostic result entries | integer 1..100, default 50 |
| Total Browser tool `llmContent` | 64 KiB |
| Wait text | 4 KiB |
| Page/snapshot ID input | 128 bytes |
| ARIA ref input | 64 bytes, `e[1-9][0-9]*` |
| Expected origin input | 2 KiB |
| Ref role/name fingerprint | 1 KiB |
| Select values | 16 items, 4 KiB each, 16 KiB total |
| Browser error message | 4 KiB |
| Action timeout | integer 100..30000 ms, default 10000 ms |
| Navigation timeout | integer 100..60000 ms, default 30000 ms |
| Wait timeout | integer 100..30000 ms, default 10000 ms |
| Explicit time wait | integer 0..5000 ms; zero snapshots immediately |
| Screenshot artifact | 8 MiB each |
| Screenshot artifacts per Session | 32 |
| Screenshot bytes per Session | 64 MiB |

Bounds are product constants in this slice, not public configuration. Invalid bounds
fail schema validation. Capacity and quota exhaustion return typed errors and never
evict another Session's live state. The process-wide pending-operation bound derives
from the existing resident SessionRuntime limit multiplied by 32; a Session without
a resident Runtime cannot retain a Browser queue.

These are Blade-owned retention and operation bounds, not an OS or network sandbox.
Playwright timeouts do not cap a remote page's CPU, RSS, response bytes, cache, DOM,
or request count. Strong browser-process resource isolation remains future work.

## Browser Launch Contract

`playwright@1.62.1` moves from `devDependencies` to exact runtime `dependencies`.
The backend build already externalizes runtime dependencies, so Playwright is not
inlined into Blade's JavaScript bundle.

Importing Browser Tool modules must not launch Chromium or resolve an executable.
Launch happens only on first Runtime use.

Chromium launches:

- headless;
- without a persistent `userDataDir`;
- without extensions;
- without `--no-sandbox` added by Blade;
- with a minimal cross-platform environment allowlist rather than raw
  `process.env`.

The runtime environment allowlist is exactly:

```text
PATH, Path, PATHEXT,
HOME, USERPROFILE, LOCALAPPDATA, PROGRAMDATA,
TMPDIR, TMP, TEMP,
LANG, LC_ALL, LC_CTYPE, TZ,
SystemRoot, SYSTEMROOT, WINDIR, COMSPEC,
XDG_RUNTIME_DIR
```

Unknown keys are dropped and retained values are capped at 32 KiB. Provider keys,
tokens, passwords, proxy credentials, Blade Session environment, and arbitrary
project variables are not inherited.

Each context uses:

- viewport `1440x900`;
- device scale factor `1`;
- locale `en-US`;
- timezone `UTC`;
- `acceptDownloads: false`;
- no granted browser permissions;
- default TLS verification;
- no storage state.

Missing or non-runnable Chromium returns `browser_not_installed` with:

```text
Install with: blade browser install
```

No tool call, startup path, test, or `browser status` command downloads a browser.

## CLI Contract

Blade adds:

```text
blade browser status
blade browser install
```

`status` reports the pinned Playwright version, expected executable path, and whether
Chromium can launch and close, including `browser.version()` from the launched
binary. The Playwright package/version is the authority for its expected browser
revision; Blade does not invent a second binary hash manifest. `status` performs no
network access and exits non-zero when the executable is missing or unusable.

`install` invokes the `playwright` package's own pinned CLI with
`install chromium`, using `playwright/package.json` to resolve the package root. It
does not use a shell, `npx`, or an unpinned remote package.

The installer receives an explicit environment containing the runtime OS allowlist
plus Playwright browser-path/download-host/timeout variables, standard HTTP(S)
proxy/no-proxy variables, and Node CA variables. It does not inherit Provider or
Blade Session credentials and never prints proxy values. Download integrity,
partial-download cleanup, cache locking, platform support, and browser revision
selection remain the pinned Playwright CLI's responsibility.

The documented public installation path is:

```text
npm install --global blade-code@0.10.87
blade browser install
blade browser status
```

The existing `browser:install` and `browser:check` package scripts remain developer
aliases and delegate to the same implementation.

## Deferred Tool Catalog

All six Browser tools are registered as built-ins but remain deferred. Their names
appear in `<available-deferred-tools>` in deterministic order. The Agent must use
`ToolSearch` before their full schemas enter model context.

The tools must be available through every `SessionRuntime`-backed surface and obey
`toolWhitelist` and `toolBlacklist` exactly like other built-ins.

### Shared Result Envelope

State-producing tools return:

```ts
interface BrowserPageSummary {
  pageId: string;
  selected: boolean;
  url: string;
  origin: string;
  title: string;
}

interface BrowserObservation {
  pageId: string;
  snapshotId: string;
  url: string;
  origin: string;
  title: string;
  tabs: BrowserPageSummary[];
  snapshot: string;
  truncated: boolean;
}

interface BrowserPageResult {
  tabs: BrowserPageSummary[];
  selectedPageId?: string;
  observation?: BrowserObservation;
}

interface BrowserDiagnosticEntry {
  sequence: number;
  pageId: string;
  kind:
    | 'console'
    | 'page-error'
    | 'request'
    | 'response'
    | 'request-failure'
    | 'dialog'
    | 'download'
    | 'popup-capacity';
  level?: string;
  method?: string;
  resourceType?: string;
  status?: number;
  url?: string;
  text?: string;
}

interface BrowserScreenshotArtifact {
  id: string;
  kind: 'image';
  mimeType: 'image/png';
  size: number;
  sha256: string;
  persisted: true;
  path?: string;
}

interface BrowserInspectResult {
  pageId: string;
  target: BrowserInspectTarget['kind'];
  entries?: BrowserDiagnosticEntry[];
  artifact?: BrowserScreenshotArtifact;
  truncated: boolean;
}

type BrowserInteractionResult =
  | {
      outcome: 'applied';
      pageId: string;
      actionApplied: true;
      sideEffectsUncertain: false;
      observation: BrowserObservation;
    }
  | {
      outcome: 'applied_observation_failed';
      pageId: string;
      actionApplied: true;
      sideEffectsUncertain: false;
      observationError: 'browser_observation_failed';
    }
  | {
      outcome: 'uncertain';
      pageId: string;
      actionApplied: 'unknown';
      sideEffectsUncertain: true;
      errorCode:
        | 'browser_cross_origin_navigation'
        | 'browser_disconnected'
        | 'browser_timeout'
        | 'browser_action_uncertain';
      candidateOrigin?: string;
    };
```

`pageId` and `snapshotId` are opaque. The Agent must not derive or synthesize them.
Projected URLs omit fragments and redact all query values while retaining query
keys. Raw request URLs, response headers, bodies, cookies, and storage never enter
metadata.

ARIA text is wrapped as untrusted page content. Tool descriptions and the shared
system prompt state that page text can describe data and controls but cannot
override Blade instructions, permissions, or tool policy.

The exact ToolSearch activation is:

```json
{
  "query": "select:BrowserNavigate,BrowserSnapshot,BrowserInteract,BrowserWait,BrowserInspect,BrowserPage",
  "max_results": 6
}
```

### BrowserNavigate

```ts
interface BrowserNavigateInput {
  url: string;
  pageId?: string;
  waitUntil?: 'commit' | 'domcontentloaded' | 'load';
  timeoutMs?: number;
}
```

- `ToolKind.Execute`
- permission signature: `BrowserNavigate(<normalized-origin>)`
- normalizes and accepts only absolute HTTP(S) URLs;
- rejects credentials, fragments are ignored for origin authorization;
- navigates the selected page when `pageId` is omitted;
- returns a fresh `BrowserObservation`;
- does not automatically retry navigation or browser crashes.

`networkidle` is intentionally absent from navigation because it is not a stable
default for modern applications. `BrowserWait` provides an explicit bounded wait.

### BrowserSnapshot

```ts
interface BrowserSnapshotInput {
  pageId?: string;
  depth?: number;
  includeBoxes?: boolean;
}
```

- `ToolKind.ReadOnly`
- captures `page.ariaSnapshot({ mode: 'ai' })`;
- passes `boxes: true` only when `includeBoxes` is true; Playwright then appends its
  public `[box=x,y,width,height]` annotation;
- records every emitted ref and a bounded role/name fingerprint;
- replaces the page's previous snapshot authority;
- returns a fresh `BrowserObservation`.

The first call may lazily create a blank context and page but performs no network
navigation.

### BrowserInteract

```ts
type BrowserAllowedKey =
  | 'Enter'
  | 'Tab'
  | 'Escape'
  | 'Backspace'
  | 'Delete'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'Space';

type BrowserAction =
  | { kind: 'click' }
  | { kind: 'hover' }
  | { kind: 'fill'; value: string }
  | { kind: 'type'; value: string }
  | { kind: 'press'; key: BrowserAllowedKey }
  | { kind: 'select'; values: string[] }
  | { kind: 'check' }
  | { kind: 'uncheck' };

interface BrowserInteractInput {
  pageId: string;
  snapshotId: string;
  ref: string;
  expectedOrigin: string;
  action: BrowserAction;
  timeoutMs?: number;
}
```

- `ToolKind.Execute`
- permission signature: `BrowserInteract(<expected-origin>)`
- requires the exact latest snapshot ID for that page;
- requires `expectedOrigin` to equal both the snapshot origin and current origin;
- accepts only refs present in the authoritative snapshot;
- refreshes the target's ARIA fingerprint immediately before action;
- rejects refs whose owner frame has a different origin from the top-level page;
- uses Playwright locator strictness and actionability;
- rejects `fill` and `type` when the target is `input[type=password]`, has
  `autocomplete` equal to `current-password`, `new-password`, `one-time-code`,
  `cc-number`, or `cc-csc`, or has a bounded `name`, `id`, `aria-label`, or
  associated label matching
  `password|passwd|passcode|one[-_ ]?time|otp|api[-_ ]?key|secret|token|credential|cvv|cvc`;
- `fill` replaces the control value while `type` appends sequential key input;
- `select` matches option `value`, not label;
- permits only `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`,
  `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`,
  and `Space`;
- invalidates the old snapshot authority immediately before invoking Playwright,
  regardless of action success, timeout, or partial side effect;
- returns `BrowserInteractionResult`.

A missing, duplicated, detached, or fingerprint-changed ref returns
`browser_snapshot_stale` without falling back to text, role, CSS, XPath, or
coordinates. An action failure after Playwright invocation does not return a new
observation; it returns `browser_action_uncertain` with
`sideEffectsUncertain: true`, and the Agent must inspect a new snapshot rather than
blindly repeating the action. When the Playwright action succeeds but the follow-up
snapshot fails, the tool returns success with `actionApplied: true`,
`observationError: 'browser_observation_failed'`, and no observation. This also
requires an explicit snapshot before another interaction.

Credential-control detection is deterministic. Attribute values and the accessible
name from the stored ref fingerprint are normalized with Unicode NFKC, collapsed
whitespace, trimming, and lowercase conversion before the case-insensitive ASCII
pattern is applied. `aria-labelledby` and multiple HTML labels are represented by
Playwright's computed accessible name; Blade does not traverse them separately.
`type` and whitespace-separated `autocomplete` tokens are compared lowercase.
Each candidate is limited to 1 KiB UTF-8; an oversized candidate fails closed
instead of being truncated before classification.

### BrowserWait

```ts
type BrowserWaitCondition =
  | { kind: 'load'; state: 'domcontentloaded' | 'load' | 'networkidle' }
  | { kind: 'text'; text: string }
  | { kind: 'url'; value: string }
  | { kind: 'time'; milliseconds: number };

interface BrowserWaitInput {
  pageId?: string;
  expectedOrigin?: string;
  condition: BrowserWaitCondition;
  timeoutMs?: number;
}
```

- `ToolKind.ReadOnly`
- waits once with a bounded timeout and no polling loop exposed to the Agent;
- exact-origin checks apply when `expectedOrigin` is provided;
- text wait uses visible exact text through `getByText(text, { exact: true })`;
- URL wait compares the exact normalized HTTP(S) URL after removing its fragment;
- explicit time wait accepts `0..5000` milliseconds;
- returns a fresh `BrowserObservation`;
- timeout is a typed failure, not a successful empty snapshot.

### BrowserInspect

```ts
type BrowserInspectTarget =
  | { kind: 'console'; limit?: number }
  | { kind: 'page-errors'; limit?: number }
  | { kind: 'network'; limit?: number }
  | { kind: 'screenshot' };

interface BrowserInspectInput {
  pageId?: string;
  expectedOrigin?: string;
  target: BrowserInspectTarget;
}
```

- `ToolKind.ReadOnly`
- reads bounded diagnostic rings or captures one viewport PNG;
- never exposes headers, bodies, cookies, storage, or raw query values;
- returns diagnostics in `llmContent`, not metadata;
- returns the newest `limit` matching entries in ascending sequence order without
  consuming them;
- stops adding entries when the 64 KiB result budget is reached and sets
  `truncated`;
- stores screenshots in a private content-addressed Session artifact store;
- returns only a bounded descriptor and path when the surface may expose local
  paths.

Screenshots are viewport-only in this release. An oversized image is rejected before
being committed as an artifact. ACP receives the descriptor without a path and
cannot retrieve screenshot bytes through Browser tools in this release; ARIA remains
the portable Agent observation channel.

### BrowserPage

```ts
type BrowserPageAction =
  | { kind: 'list' }
  | { kind: 'open' }
  | { kind: 'select'; pageId: string }
  | { kind: 'close'; pageId: string };

interface BrowserPageInput {
  action: BrowserPageAction;
}
```

- `ToolKind.Execute`
- permission signature includes the action kind;
- `open` creates and selects only `about:blank`; navigation still requires
  `BrowserNavigate`;
- `select` changes the default page and returns a fresh observation;
- `close` invalidates all IDs for that page;
- closing the final page leaves no page until the next operation lazily creates a
  blank one;
- `list` returns `BrowserPageResult` without creating or selecting a page;
- `open` and `select` return `BrowserPageResult.observation`;
- `close` returns the remaining tabs and the newly selected page observation when
  one remains.

Same-origin popups are registered but do not replace the selected page. A
cross-origin popup is blocked and closed. A popup above the eight-page limit is
closed immediately and recorded as a bounded diagnostic.

## Snapshot And Ref Authority

Snapshot safety uses a Blade-owned authority rather than trusting model-provided
refs directly.

For each page, the Runtime stores:

```ts
interface BrowserSnapshotAuthority {
  snapshotId: string;
  pageGeneration: number;
  origin: string;
  refs: ReadonlyMap<string, string>;
}
```

The map value is a bounded role/name fingerprint parsed from the ARIA snapshot.

An interaction is accepted only when:

1. the page exists and is open;
2. the supplied snapshot ID is the latest ID for that page;
3. the page generation has not changed;
4. expected, snapshot, and current origins are equal;
5. the ref was emitted by that snapshot;
6. a fresh AI snapshot still maps the ref to the same fingerprint;
7. Playwright resolves exactly one actionable locator.

Main-frame navigation, reload, page closure, browser disconnect, context disposal,
and every attempted Playwright interaction increment the page generation and
invalidate previous snapshot IDs. Precondition failures before Playwright invocation
leave the authority unchanged. Failed actions do not create an alternative selector
path.

This contract narrows, but cannot eliminate, browser-side time-of-check/time-of-use
races. Playwright's final locator resolution and actionability check remain the last
authority.

## Origin And Network Boundary

User-supplied navigation accepts only `http:` and `https:`. It rejects:

- URL usernames or passwords;
- `file:`, `data:`, `javascript:`, `blob:`, browser-internal, and extension URLs;
- empty or oversized URLs;
- malformed hosts or ports.

Loopback and private-network origins are supported because local application testing
is a primary use case. Permission previews label them explicitly.

The permission boundary is the normalized origin:

```text
scheme://hostname:effective-port
```

Project or Session approval for one origin does not authorize another.

Every page stores an `authorizedOrigin` and, only during an active navigation,
one transient navigation grant. A new `about:blank` page has
`authorizedOrigin = null` and cannot be interacted with.

Explicit `BrowserNavigate` sets the transient grant to the approved target origin.
The page adopts that origin as `authorizedOrigin` as soon as a main-frame document
commits at the granted origin, even if a later `load` wait times out. When no granted
document committed, failure/abort retains the previous authorized origin if the
current HTTP(S) page still has that origin. Any other resulting state clears
authorization to `null`. Every navigation attempt clears the transient grant and
invalidates snapshot authority.

`BrowserInteract` grants only the page's non-null authorized origin for the duration
of its action. Outside an active tool call, page-script navigation is checked
against the authorized origin. A blocked background navigation is aborted and
appended to the Session diagnostics; the next Snapshot, Wait, Inspect, or
interaction result reports that fact because there is no active tool call to receive
it directly.

The Runtime permits same-origin top-level redirects. A top-level redirect, popup, or
interaction navigation to another origin is aborted and returned as
`browser_cross_origin_navigation`, including only the normalized candidate origin.
The Agent must call `BrowserNavigate` for that destination, creating a new permission
decision.

`BrowserContext.route()` is used only as an internal fail-closed navigation guard.
The model cannot install routes, fulfill requests, modify responses, or bypass the
guard. This security route is distinct from the Agent-authored network mocking that
is outside this release.

Cross-origin subframes and subresources required by the approved page are not an
origin authorization grant and are not exposed as interactable top-level pages.
Their content may appear in a snapshot, but `BrowserInteract` rejects refs owned by
a cross-origin frame. Same-origin frames remain interactable.

This Browser Tool is not a network sandbox: an approved page can issue its own
network requests, including requests to other network classes. Hostname
classification does not claim DNS-rebinding protection. The isolation guarantees
are ephemeral browser state, stripped process environment, bounded retained output,
and explicit top-level origin authorization.

## Permissions And Hooks

Web-content-changing browser tools use `ToolKind.Execute`; observation tools use
`ToolKind.ReadOnly`. `BrowserPage` is Execute because its union contains local page
mutations, but page open/select/close authorization is scoped to the local action,
not a web origin. Every tool sets `parallelism: 'exclusive'` and is additionally
serialized by the Session browser gate.

The standard order remains:

```text
schema validation
  -> worktree guard
  -> permission rule
  -> PreToolUse hooks
  -> permission recomputation after hook edits
  -> user approval
  -> global Tool admission
  -> Session browser operation gate
  -> Playwright operation
  -> PostToolUse hooks
  -> durable ToolResult
```

Permission UI adds Browser-specific previews and risks:

- normalized target or expected origin;
- public, loopback, or private-network classification;
- action kind;
- warning that the page may execute remote code or submit data.

Permission signatures never include fill/type values, query values, page text, or
credentials. Project rules can authorize one tool and origin without authorizing
all browser activity.

Plan mode exposes only the read-only Browser tools. It cannot navigate, interact, or
manage pages.

## Artifact And Metadata Boundary

The existing secure MCP artifact implementation is extracted into a generic private
Session artifact primitive. MCP keeps its current wrapper and behavior. Browser
screenshots use a separate `browser-artifacts/<session-hash>` namespace and Browser
quotas.

Artifact requirements remain:

- directories `0700`;
- files `0600`;
- no symlinks;
- content-addressed SHA-256 identity;
- owner verification where supported;
- count and byte quotas checked before commit;
- ACP descriptors omit local paths.

Browser tool metadata uses an explicit allowlist in
`sanitizeToolMetadata`. Allowed values are limited to:

- action and status;
- opaque page and snapshot IDs;
- sanitized origin and URL;
- bounded title;
- truncation and diagnostic counts;
- typed browser error code;
- validated screenshot artifact descriptors.

ARIA snapshots, typed values, console text, page errors, request URLs with query
values, headers, bodies, and raw Playwright errors are prohibited from metadata.
Every metadata string is capped by the corresponding table bound; IDs additionally
use their closed syntax and artifact hashes are exactly 64 lowercase hex characters.

Every Browser Tool bounds total `llmContent` to 64 KiB, below the generic
ToolResultBudget persistence threshold. Observation serialization reserves space
for bounded page facts and at most eight tab summaries, then line-truncates the
snapshot to the remaining budget; the standalone snapshot ceiling of 48 KiB is
therefore reduced when envelope data consumes more space. A large page is truncated
in memory; Blade does not silently save the complete page text to
`~/.blade/tool-results`.

Browser screenshot artifacts are durable Session artifacts: Runtime disposal does
not delete files referenced by committed tool results. Explicit Session deletion
removes the Browser artifact namespace. Quotas bound retained data before deletion.

ARIA text, titles, URL paths/query keys, diagnostics, tool input values, and
screenshots are user-authorized page data and may contain sensitive application
content. They enter
the durable ToolResult and may reach ACP. Blade does not claim generic content-level
secret redaction, and cannot prove that a value entered into an ordinary text field
is not a secret. Instead it rejects detected credential controls, strips Browser
process credentials, redacts query values, bounds all projections, and documents
that Browser tool inputs and page output are durable.

## Diagnostics

The Session records bounded rings whose entries include a page ID:

- console messages with level and text;
- uncaught page errors;
- request method, sanitized URL, and resource type;
- response status and sanitized URL;
- request-failure category.

Arguments, stack traces, headers, post bodies, response bodies, security details,
and object handles are omitted. Browser diagnostics are untrusted page content.
Browser errors are sanitized and bounded before every tool result and log write; raw
Playwright stacks, page text, and unredacted URLs are not logged, including in debug
mode.

Dialogs are dismissed to prevent a blocked Runtime and recorded as diagnostics.
Downloads are cancelled and reported as `browser_download_blocked`.

Aggregate Runtime statistics expose only process/context/page/queue counts through
an in-process test seam. They are not added to HTTP, ACP, CLI JSON, Session events,
or persisted schemas.

## Failure Contract

Expected failures use stable codes:

| Code | Meaning | Retry |
| --- | --- | --- |
| `browser_not_installed` | Pinned Chromium is missing or cannot launch | after install/fix |
| `browser_capacity` | Process context limit is full | later |
| `browser_busy` | Session operation queue is full | later |
| `browser_disconnected` | Chromium generation crashed; old queued work was cancelled | navigate/snapshot |
| `browser_disposed` | Session Browser Runtime was closed | new Runtime |
| `browser_page_not_found` | Page ID is unknown or closed | list/select |
| `browser_snapshot_stale` | Snapshot/ref authority no longer matches | snapshot |
| `browser_origin_mismatch` | Expected origin differs from current state | snapshot/navigate |
| `browser_cross_origin_navigation` | Unapproved top-level origin was blocked | navigate target |
| `browser_cross_origin_frame` | Ref belongs to an unapproved iframe origin | navigate target |
| `browser_timeout` | Bounded Playwright operation timed out | inspect/retry |
| `browser_action_uncertain` | Playwright action started but its final effect is unknown | snapshot, do not repeat |
| `browser_download_blocked` | Page attempted a prohibited download | none |
| `browser_unsupported` | Requested action is outside the v1 contract | none |

Messages are bounded and strip filesystem internals except the explicit executable
path from `blade browser status`. Raw Playwright stacks are never projected or
logged.

`browser_observation_failed` is a success warning, not a Tool error:
`outcome='applied_observation_failed'` proves the action completed and requires a
new snapshot before further interaction.

For an interaction, failures detected after Playwright invocation use this
precedence:

1. a route-guard block returns uncertain
   `browser_cross_origin_navigation` with the candidate origin;
2. a browser-generation loss returns uncertain `browser_disconnected`;
3. an operation deadline returns uncertain `browser_timeout`;
4. any other action exception returns uncertain `browser_action_uncertain`.

All four set `actionApplied='unknown'` and `sideEffectsUncertain=true`. Precondition
failures happen before invocation and use their ordinary error without an uncertain
interaction result.

Browser crashes do not replay actions automatically. The pool invalidates its
generation, active and already queued operations fail `browser_disconnected`, and
all affected Session runtimes discard contexts/pages/snapshots. A new recovery-entry
call may launch a fresh browser in the same SessionBrowserRuntime.

## Surface Projection

No surface receives a second browser implementation.

- TUI shows the canonical Browser tool card and bounded detail.
- Headless text/JSON/JSONL uses the canonical ToolResult.
- Web receives sanitized durable metadata and bounded detail through existing SSE
  projection.
- ACP receives the same canonical result and no local artifact path.

Browser-specific display formatters summarize origin, page, action, snapshot,
truncation, diagnostics, and artifact identity. They do not duplicate the full ARIA
snapshot in metadata.

The existing right-side Browser Preview remains user-controlled and independent.
Its sandbox and iframe URL rules are unchanged.

## Deterministic Verification

Unit tests cover:

- URL normalization, credential rejection, scheme rejection, origin
  classification, output URL redaction, and redirect decisions;
- launch-environment allowlisting and secret removal;
- process launch single-flight, context capacity, crash generation, final-lease
  closure, and idempotent disposal;
- Session operation FIFO, queue bound, abort before launch, dispose during action,
  and independent Session concurrency;
- page cap, popup registration, active-page replacement, and page ID invalidation;
- snapshot byte/depth bounds, ref parsing, fingerprint stability, stale IDs,
  origin mismatch, cross-origin frame rejection, and no selector fallback;
- action schemas, key allowlist, value bounds, password-field rejection, and
  download blocking;
- action-applied/observation-failed and action-side-effect-uncertain results;
- diagnostic ring bounds and omission of headers/bodies/query values;
- screenshot ownership, mode, hash, per-file limit, and Session quota;
- deferred registration, ToolSearch activation, whitelist/blacklist behavior,
  ToolKind, hooks, permission signatures, and Browser approval previews;
- metadata allowlisting and all surface display bounds;
- Session deletion cleanup for Browser artifact namespaces;
- CLI install/status resolution without shell or implicit network;
- SessionRuntime initialization failure and disposal cleanup.

A real, keyless Chromium integration uses two loopback fixture origins and proves:

1. lazy launch and one context per Session;
2. navigate -> AI snapshot -> ref interaction -> wait -> fresh snapshot;
3. form fill, click, select, check, keyboard action, and same-origin navigation;
4. console, page-error, network, and screenshot inspection;
5. page open/select/list/close and popup capacity;
6. stale ref rejection after DOM replacement;
7. cross-origin redirect and click navigation blocked before target load;
8. cross-origin iframe refs rejected without interaction;
9. empty-cache missing-browser calls fail without installer or network activity;
10. no external requests, downloads, residual pages, contexts, processes, ports, or
   temporary roots.

## Real API Qualification

One release-blocking trajectory runs the fixed matrix:

| Provider | Headless | raw PTY TUI | production Web | real ACP |
| --- | --- | --- | --- | --- |
| DeepSeek V4 Flash | required | required | required | required |
| DeepSeek V4 Pro | required | required | required | required |

Every cell:

1. starts a deterministic loopback application with a hidden nonce;
2. uses the exact catalog IDs `deepseek-v4-flash` and `deepseek-v4-pro` with the
   repository's release qualification sampling configuration;
3. requires the model to discover all six deferred Browser tools through the exact
   `ToolSearch` request above;
4. navigates with `BrowserNavigate`;
5. reads an AI snapshot and uses only returned page/snapshot/ref identities;
6. fills and submits a form through `BrowserInteract`;
7. waits for the resulting DOM state through `BrowserWait`;
8. inspects bounded console/network state through `BrowserInspect`;
9. opens, selects, lists, and closes a second page through `BrowserPage`;
10. returns the nonce observed only after the interaction;
11. uses framework retry `0`.

The production Web cells intentionally run an outer qualification Chromium for the
Blade UI and an inner Browser Tool Chromium owned by the server process.

Host assertions prove:

- one successful ToolSearch activation and valid tool-call order;
- no CSS/XPath/evaluate fallback;
- exact snapshot/origin preconditions on interactions;
- expected fixture requests and zero external browser requests;
- identical canonical tool results after live display and durable reload;
- no Provider credential in browser launch environment, fixture requests, DOM,
  tool output, metadata, transcript, ACP frames, PTY output, or logs;
- browser/context/page/operation statistics return to zero;
- all servers, ports, process trees, browser children, PTYs, ACP connections,
  Session leases, and temporary roots are reclaimed.

The file enters `realApiQualification.files`; it cannot be replaced by mocked
Playwright or a keyless-only test.

## Documentation

Implementation updates:

- `README.md`;
- Chinese and English installation documentation;
- Chinese and English tools documentation;
- Chinese and English qualification documentation;
- `CHANGELOG.md` and `CHANGELOG.zh.md`.

Documentation must state:

- when to prefer WebSearch/WebFetch;
- how to install and check Chromium;
- that browser state is ephemeral and Session-isolated;
- which actions and data classes are intentionally unsupported;
- that the Agent browser and Browser Preview are independent in `v0.10.87`;
- the permission and top-level origin model.

## Release Gate

Before version/tag creation:

1. implementation tasks and completion checklist are fully checked;
2. targeted browser tests pass;
3. `bun run type-check`, format, lint, build, full tests, Web tests, CLI tests,
   security tests, performance tests, and coverage pass;
4. `blade browser status` passes with the pinned Chromium;
5. an npm pack/cold-install smoke proves Playwright is a runtime dependency and no
   browser is downloaded implicitly;
6. fixed-HEAD Local Qualification passes;
7. fixed-HEAD Production Qualification passes all checks and the eight Browser Tool
   cells;
8. evidence is written in Chinese and English;
9. version and both changelogs are updated to `0.10.87`;
10. the exact qualified commit is tagged, pushed, published, and cold-installed from
    the public registry;
11. CI, Coverage, Docs, npm, and GitHub Release all succeed;
12. worktree, browser, process, port, profile, and temporary-root audits are clean.

## Acceptance Criteria

The Browser Tool is complete only when all of the following are true:

- all six tools are deferred native Blade tools;
- no private Playwright module is imported;
- Chromium is lazy, shared, bounded, explicit to install, and fully reclaimed;
- every Session has isolated ephemeral browser state;
- all web navigation and interaction actions are permissioned by normalized origin;
- Browser-local page open/select/close actions are permissioned by action kind and
  cannot navigate;
- cross-origin top-level transitions require a new navigation permission;
- every ref action is guarded by page ID, latest snapshot ID, expected origin, and
  a fresh fingerprint check;
- cross-origin iframe refs cannot inherit top-level origin approval;
- no arbitrary selector, script execution, upload, download, persistent login, or
  detected credential-control entry path exists;
- outputs, diagnostics, artifacts, metadata, queues, pages, contexts, and timeouts
  are bounded;
- Browser state disappears on Session disposal, eviction, fork, and process crash;
- Headless, TUI, Web, and ACP observe one canonical contract;
- deterministic real Chromium and eight-cell real API qualification pass at one
  fixed commit;
- `blade-code@0.10.87` installs and runs from the public npm registry without
  downloading Chromium unless the user explicitly requests installation.
