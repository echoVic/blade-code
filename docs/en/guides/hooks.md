# Hooks System

Hooks run automated checks at tool, session, and control-flow boundaries. Configuration-based Hooks may run shell
commands or access the network, so by default Blade does not execute Hooks from untrusted projects.

## Supported Events

| Event | Trigger Boundary |
| --- | --- |
| `PreToolUse` | Before tool execution; can reject or modify the input |
| `PostToolUse` | After a tool succeeds; can append context or modify the output |
| `PostToolUseFailure` | After a tool fails |
| `PermissionRequest` | When requesting user authorization |
| `Elicitation` | Before an MCP request is displayed; can provide or reject input |
| `ElicitationResult` | Before MCP input is returned to the server; can review or modify it |
| `UserPromptSubmit` | When the user submits a message |
| `SessionStart` / `SessionEnd` | Session start and end |
| `Stop` / `SubagentStop` | When the main Agent or a sub-agent is about to stop |
| `Notification` | When a notification is delivered |
| `Compaction` | Before context compaction |

Configuration-based Hooks support `command`, `http`, and `prompt`. `function` Hooks can only be registered by the app or a plugin
via `HookManager.registerFunction()` and cannot be written into JSON.

## Configuration

Hooks can be configured at the user level in `~/.blade/settings.json`, or at the project level in
`.blade/settings.json` or `.blade/settings.local.json`:

```json
{
  "hooks": {
    "enabled": true,
    "defaultTimeout": 60,
    "timeoutBehavior": "ignore",
    "failureBehavior": "ignore",
    "maxConcurrentHooks": 4,
    "PostToolUse": [
      {
        "name": "format-typescript",
        "matcher": {
          "tools": ["Write", "Edit"],
          "paths": ["**/*.ts", "**/*.tsx"]
        },
        "hooks": [
          {
            "type": "command",
            "command": "bunx biome format --write .",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Both `timeout` and `defaultTimeout` are in seconds. The matcher supports:

- `tools`: tool name, array, pipe-separated values, or regex.
- `paths`: file glob.
- ApplyPatch passes all source, destination, and Move-to paths to the matcher;
  `ApplyPatch(src/**)` or `paths: ["src/**"]` triggers when any file matches.
- `commands`: Bash command regex.

Command Hooks are launched in the target workspace. The HookInput is written to stdin as JSON, and only
`BLADE_PROJECT_DIR`, `BLADE_SESSION_ID`, `BLADE_HOOK_EVENT`,
`BLADE_TOOL_NAME`, `BLADE_TOOL_USE_ID`, and the necessary system environment are exposed. Sensitive environment
variables such as API keys and tokens are not passed to the Hook subprocess. stdin is limited to 100 KiB, and stdout/stderr are each limited to 1 MiB;
a timeout or abort reclaims the entire process tree.

The `ElicitationResult` Hook can see the MCP Form content. Forms may only be used for non-sensitive data;
API keys, OAuth, payment, and other secrets should use URL elicitation. Configuration-based Elicitation Hooks
are still protected by the exact Hook Trust digest, and returned content is re-validated against the MCP requested schema.

HTTP Hooks always use POST JSON. HTTPS is required by default, and redirects, loopback, link-local,
and private network addresses are rejected; only an explicit `httpPolicy.allowedHosts` or the corresponding policy switch can allow them.

## Project Trust

Blade performs a stable normalization of the effective Hook config and computes a SHA-256. The digest covers all configuration-based
Hooks, matchers, timeout/failure policies, and the HTTP policy, but not in-process Function Hooks.

This layer is independent of [Workspace Trust](/en/guides/workspace-trust.md): Folder Trust controls whether project config and
resources can load, while Hook Trust controls whether the current exact Hook digest can execute. Trusting a workspace does not
automatically approve new or modified Hooks.

Trust states:

| State | Behavior |
| --- | --- |
| `disabled` | Hooks configuration is turned off |
| `not_required` | Only app-registered Function Hooks |
| `untrusted` | Configuration-based Hooks are not executed |
| `trusted` | The current digest can be executed |
| `modified` | The config changed; the old trust is invalidated immediately |
| `error` | The trust store is abnormal; configuration-based Hooks fail closed |

Trust is saved per canonical project path in `~/.blade/hook-trust.json`. The file uses atomic writes and
`0600` permissions; symlinks, wrong owner, loose permissions, unknown fields, or corrupted content all fail closed.
A Git linked worktree uses the common checkout as its trust identity, so the source project and the execution worktree
share the same digest trust; monorepo subprojects keep their path relative to the repo root, do not overwrite each other, and do not
rely on the global current Session.

Usage in the TUI, headless, or ACP:

```text
/hooks status
/hooks list
/hooks enable
/hooks disable
/hooks trust
/hooks revoke
```

ACP returns the same status via standard callbacks. Web shows each event,
matcher, Hook type, bounded target preview, and digest in `Settings → Hooks`; HTTP URLs do not project credentials, query, or fragment.
Both Trust and Revoke require an explicit secondary confirmation.

`/hooks enable|disable` only toggles the current Session; it does not modify the project Hook config, nor does it affect other Sessions in the same
workspace. The source project and the Session worktree map to the same session state; when the
Runtime is released, that state is cleaned up with the Session and is not written to a config file. The TUI Hooks Manager and Web
`Settings → Hooks` use the same session-level switch. If the workspace config, Session snapshot, or host
policy has already disabled Hooks, Web shows an unavailable state and does not render an invalid switch as enabled.

Trust operations carry a reviewed digest. If the config changes between review and submission, the service returns `409`, requiring
a reload before confirming again. Any config change moves to `modified` and does not inherit the old approval.

## Execution Order

```text
User request → PreToolUse → permission merge/confirm → tool execution
                                      → PostToolUse
                                      → PostToolUseFailure
MCP tool → Elicitation → user/Hook response → ElicitationResult → MCP server
```

PreToolUse and PermissionRequest Hooks can only tighten tool permissions; they cannot bypass deny rules. Multiple shared tools
that require user confirmation are approved serially to avoid overwriting Web's pending permission.

## Error Policy

- exit code `0`: success.
- exit code `1`: non-blocking error.
- exit code `2`: blocking error.
- exit code `124`: timeout.
- `timeoutBehavior` / `failureBehavior` can be set to `ignore`, `deny`, or `ask`.

Do not review Hooks in a repository as ordinary config. Trust means allowing those commands, prompts, and HTTP
targets to run with the current user's permissions; you must inspect the full definition first. Personal Hooks should go in
`settings.local.json`, and do not commit credentials or tokens.

## Related Resources

- [Config System](/en/configuration/config-system.md)
- [Permission Control](/en/configuration/permissions.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
