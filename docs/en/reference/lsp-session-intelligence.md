# Session-scoped LSP Code Intelligence

Blade can provide definition, references, hover, symbols, implementation, call hierarchy, and incremental diagnostics through the Language Server Protocol. LSP is not a process-global service: each `SessionRuntime` holds its own configuration snapshot, connections, open file versions, and diagnostic deduplication state.

## Configuration

LSP can be configured in user or trusted project `config.json` / `settings.json`:

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      },
      "initializationOptions": {},
      "settings": {},
      "startupTimeout": 10000,
      "shutdownTimeout": 2000,
      "requestTimeout": 10000,
      "diagnosticWaitTimeout": 750,
      "maxRestarts": 3
    }
  }
}
```

`command` is launched via an argument array, not through a shell. The environment inherits only the frozen Session environment and that server's `env`; arbitrary host credentials are not copied. Extensions are uniformly normalized to lowercase with a leading `.`. Server counts, arguments, extension mappings, JSON options, timeouts, and restart counts all have hard upper limits; unknown fields fail closed.

Plugins may provide `.lsp.json` in the root directory. Server names become `plugin:<plugin-name>:<server-name>`; `${BLADE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` are expanded within the immutable plugin package root.

## Workspace and Session

- User configuration is always available; project `lspServers` and project plugins must first pass Workspace Trust.
- On Session creation, the source `projectRoot` is resolved and the configuration is frozen.
- Git worktrees or task worktrees initialize the server with the execution `workspaceRoot` and do not fall back to the source checkout.
- Foreground/background Tasks, Teams, and resumed children explicitly inherit the parent Session snapshot.
- Even when multiple Sessions use servers with the same name, each holds independent processes, environments, open files, and diagnostics.
- ACP files are held by the client; Blade does not start local LSPs on the host machine for ACP Sessions.

## Tools and Diagnostics

`LSP` is a deferred read-only tool. The model first loads the schema via `ToolSearch`, then can call:

- `goToDefinition`
- `findReferences`
- `hover`
- `documentSymbol`
- `workspaceSymbol`
- `goToImplementation`
- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`
- `diagnostics`

Each provider request re-resolves activated deferred schemas, so the next turn after ToolSearch can actually invoke LSP.

Successful `Edit` / `Write` sends `didOpen`, `didChange`, and `didSave` to the same Session connection. `publishDiagnostics` are sorted by severity, deduplicated across turns, limited to 10 per file and 30 total, and attached to tool results as `<new-diagnostics>`. After LSP is configured, AutoVerify package scripts are no longer run redundantly.

## Lifecycle

Servers are lazily started by file extension. Concurrent starts of the same server share a Promise; ContentModified requests use bounded backoff; requests support timeouts and turn abort. After a crash, open file state is cleaned up and the server is restarted on the next call; after exceeding `maxRestarts`, it fails closed.

`SessionRuntime.dispose()` first sends LSP `shutdown` / `exit`, then completes `SIGTERM` / `SIGKILL` or Windows tree cleanup via the owned process tree, and waits for process exit. Initialization failures, request cancellations, Web terminal task terminal states, and sub-Session ends all go through the same reclamation protocol.

## Qualification Verification

Deterministic tests use real stdio JSON-RPC subprocesses to verify the protocol, diagnostics, dual-Session isolation, ACP disabling, crash restart, cancellation, and PID reclamation. Real GPT must complete ToolSearch → LSP hover → Write → passive diagnostics; production DeepSeek Web GUI must demonstrate Trust review, semantic tool calls, diagnostic reinjection, terminal process zeroing, and fresh-tab zero console errors.
