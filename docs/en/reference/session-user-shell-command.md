# Session-owned User Shell Command

Blade supports explicit user shell command execution via `! <command>` in the input box. This path belongs to the Session Runtime; it does not create an Agent, nor does it initiate a model request.

```text
! pwd
! npm test
! git status --short
```

TUI, Web, print, headless, and ACP all share the same persistence and output boundaries.

## Execution Semantics

- Commands run in the current Session's execution workspace;
- Normal Sessions use the project workspace; Task Sessions use a frozen worktree;
- Task worktrees do not roll back the source checkout;
- The environment comes from the SessionStart frozen environment, augmented with `BLADE_CLI=1` and `BLADE_USER_SHELL=1`;
- Shell commands do not go through the `UserPromptSubmit` Hook, do not invoke the model, and do not create model tool calls;
- Only one user shell command runs at a time per Session;
- Entering `!` in Web Task Home creates a normal Session, not an independent worktree Task.

`!` is a command directly authorized for execution by the user and does not go through the Agent's Bash permission flow. TUI and Web switch to a yellow `$` shell mode to avoid mistaking it for a normal model message.

## Persistence and Model Context

Execution results are written to Session JSONL first, then returned to the caller. The model side uses explicit boundaries:

```xml
<user_shell_command>
<command>pwd</command>
<result>
Status: completed
Exit code: 0
Duration: 0.004 seconds
Output:
/workspace
</result>
</user_shell_command>
```

XML is escaped and only enters model history. TUI/Web/ACP, Session resume, and Markdown export read `metadata.userShellCommand`, displaying a structured command card or console block without exposing internal XML.

When `!` is executed during an active Agent turn, the result is persisted first, then injected as auxiliary steering into the next safe provider boundary of the current turn; if the turn is already sealed, it enters the next turn. The durable inbox only stores references and does not duplicate the same shell message.

## Output and Cancellation

The command length limit is 32 KiB. stdout and stderr use independent UTF-8 decoders with:

- ANSI escape cleaning;
- split code point-safe streaming output;
- 512 KiB capture budget per stdout/stderr;
- 64 KiB live stream budget per stdout/stderr;
- First 4 KiB NUL sniff; binary streams retain only a byte count summary;
- head/tail truncation with omitted byte counts;
- async output callback drain; `completed` never arrives before the last output event.

Terminal states are:

```text
completed
failed
aborted
timed_out
spawn_error
```

Local execution uses an owned process group. Session abort, TUI cancel, Web `POST /sessions/:id/abort`, and ACP cancel terminate the full process tree, not just the direct child process.

## Cross-Platform Protocol

Web uses:

```text
POST /sessions/:sessionId/shell
```

The request contains `command` and an exact `projectPath`. SSE events are:

```text
user.shell.started
user.shell.output
user.shell.completed
```

headless `--output-format jsonl` uses a stable snake_case wire contract:

```text
user_shell_started
user_shell_output
user_shell_completed
```

print examples:

```bash
blade --print '! pwd'
blade --print --output-format stream-json '! npm test'
```

ACP projects the lifecycle as a `kind: execute` tool call and executes it through the IDE terminal. When the IDE terminal is unavailable, it fails closed, forbidding fallback execution of remote commands on the Blade host shell.

## Limitations

- User shell commands do not accept image attachments;
- `!` cannot be combined with headless `--task-isolation`;
- Current Runtime initialization still requires a usable model configuration, but executing `!` itself does not use credentials or access the provider;
- Binary output does not enter the model or UI;
- Users must still review command contents; Blade does not treat an explicit `!` as an Agent-generated safe command.
