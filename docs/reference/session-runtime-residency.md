# Session Runtime Residency

Blade bounds the number of fully initialized Session Runtime graphs retained by
long-running Web and ACP processes. The boundary covers the Runtime, Agent,
model resources, MCP/LSP connections, hooks, Session lease, background process
ownership, and in-memory projections associated with a Session.

Durable Session history is not a cache entry. Eviction and close release runtime
resources without deleting transcript, inbox, Goal, task, permission, model, or
worktree state.

## Startup Settings

The user-level startup configuration accepts:

```json
{
  "maxResidentSessionRuntimes": 32,
  "sessionRuntimeIdleMs": 300000
}
```

| Setting | Minimum | Default | Maximum |
| --- | ---: | ---: | ---: |
| `maxResidentSessionRuntimes` | 1 | 32 | 256 |
| `sessionRuntimeIdleMs` | 30000 | 300000 | 3600000 |

Both values must be safe integers in the closed ranges. Zero does not disable
the boundary or idle reclamation. The values are frozen when the Web or ACP
process starts; project and Session-local configuration cannot override them.

Equivalent CLI overrides are:

```bash
blade serve --max-resident-session-runtimes 32 \
  --session-runtime-idle-ms 300000

blade --acp --max-resident-session-runtimes 32 \
  --session-runtime-idle-ms 300000
```

## Capacity Accounting

A slot is reserved before Runtime initialization, MCP/LSP connection, Agent
construction, or ACP task/worktree creation. Pending reservations and committed
residents share the same hard limit, so concurrent initialization cannot exceed
the configured capacity.

Every operation acquires a lease before reading a resident. A leased resident is
pinned and cannot be reclaimed. Access and release promote it to the most
recently used position.

A Runtime is not reclaimable while it owns any of the following:

- an active turn or turn owner;
- pending steering or durable input;
- a foreground or background shell;
- a running background agent;
- an unadopted terminal child completion;
- a nonterminal MCP task;
- an attached tool executor catalog.

If Runtime disposal fails, the entry remains capacity-charged and unavailable.
Blade will not reuse or repeatedly evict a partially disposed Runtime.

## Web Lifecycle

Web uses pin-safe least-recently-used reclamation when a new Session needs a
slot. A periodic unreferenced timer also removes idle Web residents after
`sessionRuntimeIdleMs`. Active or otherwise pinned residents are skipped.

Opening an evicted Session cold-rehydrates a new Runtime from durable state.
History, pending input, Goal state, Session settings, and task metadata remain
available. Idle eviction never archives or deletes the Session.

If all resident slots are active or pinned, a message or task request returns:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Session runtime capacity is full",
    "details": {
      "resource": "resident_runtimes",
      "limit": 32
    }
  }
}
```

The HTTP status is `429`. A rejected task is removed before Provider, Runtime,
worktree, or durable task side effects. Queued-task crash recovery treats the
condition as deferred capacity instead of a terminal task failure.

## ACP Lifecycle

Blade advertises ACP 1.3 `sessionCapabilities.close`. ACP clients must call:

```text
session/close
```

when a Session is no longer active. Close:

1. serializes with same-ID load and replacement;
2. cancels and settles active prompts or user shells;
3. acknowledges explicitly cancelled pending input;
4. closes bounded ACP update egress;
5. destroys Agent, Runtime, ACP context, and Session-owned resources;
6. releases the exact resident slot.

Closing a missing Session is idempotent. The durable transcript remains
loadable through `session/load`.

ACP does not silently evict idle Sessions because the protocol has an explicit
close lifecycle and no standard asynchronous eviction notification. At
capacity, new, fork, or load requests fail before Session construction with a
bounded JSON-RPC error:

```text
Internal error: Session runtime capacity is full
```

The error data contains `resource=resident_runtimes`, the configured `limit`,
and `retryable=true`. Closing an existing Session immediately makes its slot
available for another Session.

## CLI, TUI, Print, and Headless

Root CLI, TUI, print, and Headless commands own one Runtime per process and
dispose it at command or process teardown. They do not register with the
multiplexed Web/ACP residency manager. Setting the resident limit to one
therefore does not reject an ordinary root turn.

Top-level task admission and Provider request admission remain independent:

- task admission bounds active and waiting task work;
- Provider admission bounds physical model streams and pending request memory;
- Session Runtime residency bounds fully initialized Web/ACP resource graphs.

See also:

- [Configuration System](../configuration/config-system.md)
- [CLI Commands](cli-commands.md)
- [Task Admission](task-admission.md)
- [Workspace Runtime Settings and Environment](workspace-runtime-environment.md)
