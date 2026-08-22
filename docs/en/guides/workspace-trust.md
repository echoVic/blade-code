# Workspace Trust

Workspace Trust is a project-level security boundary. A repository can carry model endpoints, MCP processes, permission rules,
environment variables, plugins, and model-invocable instruction resources; Blade does not apply these sources until the user trusts the directory.

## Project Sources Blocked by Default

- `.blade/config.json`
- `.blade/settings.json`
- `.blade/settings.local.json`
- `package.json` that contains `scripts`
- `.blade/plugins/`, `.claude/plugins/`
- `.blade/commands/`, `.claude/commands/`
- `.blade/skills/`, `.claude/skills/`
- `.blade/agents/`, `.claude/agents/`
- `CLAUDE.md`, `AGENTS.md`, `BLADE.md`

When untrusted, Blade only uses user-level config, built-in resources, and explicit CLI arguments. The project cannot:

- replace the current model or send API keys to a project endpoint;
- launch a stdio MCP or connect to a project HTTP/SSE MCP;
- launch a project LSP executable;
- append `permissions.allow`, switch to yolo, or inject environment variables such as `BASH_ENV`;
- load project plugins, commands, skills, or agents;
- inject repo instructions into the system prompt;
- automatically run the project `type-check` script after a file write.

The `package.json` review only shows script names, not the command bodies. Automatic verification of project code also requires the current
Session to use `yolo` permissions; `default` and `autoEdit` do not implicitly launch execute-class commands after an approved write.
When no `type-check` is declared, Blade does not guess the tool, nor does it download and execute it via `npx`.
ACP files are held by the client, so Blade does not launch a local verification process for ACP writes.

Project Hooks use a stricter, independent digest trust. Settings files containing only `hooks` do not trigger
Folder Trust, but command/http/prompt Hooks must still be approved by their SHA-256 digest in
`Settings → Hooks` or via `/hooks trust`. Folder Trust does not bypass
Hook digest review.

## Trust Decisions

Blade uses a canonical project identity. Git linked worktrees map to the common checkout,
while preserving the relative path of monorepo subprojects. Parent-directory trust is inherited by subdirectories; a more specific subdirectory revoke
takes precedence over the parent directory.

Decisions are saved at:

```text
~/.blade/workspace-trust/<sha256(path)>.json
```

The directory permission is `0700`, decision files are `0600`, and atomic writes are used. Symlinks, wrong owner,
loose permissions, corrupted schema, the user home, and the filesystem root all fail closed.

## CLI, TUI, and ACP

The TUI shows a review prompt before initializing project resources:

```text
[Enter/T] Trust and load
[S/Esc] Continue safely
```

You can also use:

```text
/trust
/trust review
/trust approve
/trust revoke
```

ACP returns the same review via the standard slash-command callback. Automated or headless launches can explicitly
authorize:

```bash
blade --trust-workspace
blade --headless --trust-workspace "run the task"
blade --acp --trust-workspace
```

`--trust-workspace` is an explicit security decision and should not be added automatically by repository scripts.

## Web

Web shows in `Settings → Security`:

- config source paths;
- MCP command or URL with query/credentials stripped;
- LSP command and file extensions, without returning args or env;
- model and Provider endpoint;
- permission rules and permission mode;
- environment variable names, without returning values;
- package script names, without returning command bodies;
- project plugins, commands, skills, agents, and instructions.

Both Trust and Revoke require a secondary confirmation. After a decision, Blade immediately reloads the filtered Store, disconnects the global MCP, and
cleans up the project resource registry. Model runtimes that have already been created require a process restart to be fully replaced, so the UI
keeps a restart prompt.

## Safe Mode

Choosing `Continue safely` does not trust the directory. Blade can continue starting up with user config, but the project sources
remain invisible. You can authorize later via `/trust approve` or the Web Security panel.

## Related Resources

- [Config System](/en/configuration/config-system.md)
- [Permission Control](/en/configuration/permissions.md)
- [Hooks](/en/guides/hooks.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
