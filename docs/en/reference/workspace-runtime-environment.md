# Workspace Runtime Settings and Environment

Blade resolves execution settings from the source project that owns a Session.
The resulting configuration is copied into the Session runtime and does not
depend on the process's current working directory after initialization.

## Session-scoped settings

The following settings are resolved for each source project:

- `env`
- `maxTurns`
- `permissionMode`
- `disableAllHooks`

User configuration is always eligible. Project configuration is eligible only
after Workspace Trust is granted. An untrusted project cannot inject
environment variables, change permissions, or change turn limits. It may set
`disableAllHooks: true` so hook execution can fail closed.

Project configuration does not control `maxConcurrentTasks`,
`maxQueuedTasks`, `maxQueuedTaskBytes`, `maxResidentSessionRuntimes`,
`sessionRuntimeIdleMs`, `maxResidentSessionProjections`, or
`sessionProjectionIdleMs`. Those values configure process-wide task admission,
[Session Runtime residency](/en/reference/session-runtime-residency.md), and
Session projection residency from the startup configuration.

## Environment lifecycle

`SessionRuntime` starts with the resolved workspace environment and runs
`SessionStart` hooks once during initialization. Valid environment values
returned by those hooks are merged into the Session snapshot. Hook output wins
over the base workspace value.

Blade never writes Session environment values to `process.env`.

Environment names must match:

```text
[A-Za-z_][A-Za-z0-9_]*
```

Values must be strings without NUL characters. The same validation applies to
configuration and `SessionStart` hook output.

## Execution boundaries

The Session environment is propagated through the shared runtime contract to:

- Foreground and background Bash
- ACP terminal execution
- Stdio MCP servers
- Command, Prompt, HTTP, and Function Hooks
- Foreground, background, Team, worktree, and resumed child Sessions
- CLI/TUI, headless, Web, and ACP Session owners

For Bash, an explicit tool-call `env` value overrides the Session default. For
stdio MCP, the server-specific `env` value overrides the Session default.
Command Hooks receive only the Session environment plus a minimal host shell
environment and canonical `BLADE_*` hook variables; arbitrary process
credentials are not copied.

## Snapshot semantics

Runtime settings and model/provider resources are resolved together before the
Session begins. Editing project configuration afterward affects only future
Sessions. Child Sessions inherit a copy of their parent's finalized resource
snapshot, including values produced by `SessionStart`.

Web idle eviction releases the initialized Runtime snapshot but not durable
Session state. A later access creates a fresh Runtime owner and restores durable
history and persisted Session choices. ACP retains its Runtime owner until the
client sends `session/close`; a later `session/load` reconstructs another owner
from the same durable Session.

## Qualification

Deterministic tests cover trusted A/B workspaces, untrusted filtering, invalid
environment rejection, SessionStart isolation, Bash override order, MCP
inheritance, Hook process isolation, and scheduler policy.

The real API trajectory uses GPT with the production Bash tool to prove:

- Two live workspaces with the same environment key retain different values.
- Runtime snapshots survive project configuration changes on disk.
- Host process values do not replace Session values.
- Web and ACP execute with the environment of the exact owning workspace.
