# ⚡ Slash Commands

Slash commands are Blade's shortcut entry point for quick actions. Type `/` to trigger suggestions, `Tab` to complete, and `Enter` to execute.

## Built-in Commands

| Command | Alias | Description |
|------|------|------|
| `/help` | `/h` | Show all available commands |
| `/clear` | `/cls` | Clear the message area (same as `Ctrl+L`) |
| `/exit` | `/quit`, `/q` | Exit the program |
| `/version` | `/v` | Show version information |
| `/status` | - | Show the current project/config status |
| `/context` | - | Show context usage |
| `/init` | - | Analyze the project and generate BLADE.md |
| `/model` | - | Model management |
| `/effort [level]` | - | View or switch the current Session's reasoning effort |
| `/speed [tier]` | `/fast [on\|off]` | View or switch the current Session's Provider service tier |
| `/verbosity [level]` | `/detail [level]` | View or switch the current Session's response verbosity |
| `/style [name]` | `/personality [name]` | View or switch the current Session's communication style |
| `/theme` | - | Switch theme |
| `/permissions` | - | Manage permission rules |
| `/mcp` | - | Show MCP status |
| `/agents` | - | Manage subagents |
| `/tasks` | - | View background tasks and resume finished subagents |
| `/team [action]` | - | Inspect teams, send messages, or delete a team |
| `/skills` | - | Manage Skills |
| `/plugins` | - | Manage plugins |
| `/hooks` | - | Manage Hooks |
| `/resume` | - | Resume a historical session |
| `/archive [sessionId]` | - | Archive the current or a specified inactive session tree |
| `/unarchive <sessionId>` | - | Restore an archive root session |
| `/export [path] [--reasoning]` | - | Export the current durable session as safe Markdown |
| `/btw <question>` | - | Ask a one-turn question in an isolated side conversation |
| `/compact` | - | Manually compact the context |
| `/memory` | - | Manage project memory |
| `/git` | `/g` | Git operations |
| `/login` | - | Log in to the OAuth service |
| `/logout` | - | Log out of the OAuth service |

## Command Details

### /init

Analyze the current project and generate or improve the `BLADE.md` config file:

```bash
/init
```

- If `BLADE.md` does not exist, the project structure is analyzed automatically and one is generated
- If it already exists, the current content is analyzed and improvement suggestions are offered

### /model

Model management command:

```bash
/model              # Open the model selector (interactive switching)
/model add          # Add a new model configuration (interactive wizard)
/model remove <name> # Remove the specified model (fuzzy match by name)
```

Example:
```bash
/model remove qwen   # Remove models whose name contains "qwen"
```

### /effort

```bash
/effort
/effort auto
/effort off
/effort minimal
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

Without arguments, it shows the current selected/effective level and the levels the model supports. Explicit selections that are unsupported
fail closed; `auto` resolves based on model capability but is still persisted as a Session policy. It cannot be switched during an active turn. For the full contract, see
[Session Reasoning Effort](/en/reference/session-reasoning-effort.md).

### /speed and /fast

```bash
/speed
/speed auto
/speed standard
/speed fast
/speed flex
/fast
/fast on
/fast off
```

`auto` keeps the Provider default policy, `standard` explicitly returns to the baseline, `fast` requests a priority/low-latency
channel, and `flex` requests a low-cost, deferrable channel. `/fast on` is equivalent to `/speed fast`, and
`/fast off` is equivalent to `/speed standard`. When the model does not support an explicit tier it fails closed, and it cannot be switched during an active
turn. For the full contract, see
[Session Service Tier](/en/reference/session-service-tier.md).

### /verbosity and /detail

```bash
/verbosity
/verbosity auto
/verbosity low
/verbosity medium
/verbosity high
/detail high
```

`auto` keeps the Provider default policy; explicit `low/medium/high` uses the model's native response verbosity capability.
`/detail` is a full alias. When the model does not support an explicit value it fails closed, and it cannot be switched during an active turn.
For the full contract, see
[Session Response Verbosity](/en/reference/session-response-verbosity.md).

### /style and /personality

```bash
/style
/style auto
/style pragmatic
/style friendly
/style explanatory
/style project:review:strict
/personality friendly
```

`auto` keeps Blade's default communication rules; other values only change tone and the explanation framing, not permissions, tool behavior,
task scope, or the Provider's native response verbosity. `/personality` is a full alias. It cannot be switched during an active turn.
For the full contract, see
[Session Communication Style](/en/reference/session-communication-style.md) and
[Trusted Custom Output Styles](/en/reference/trusted-output-styles.md).

### /git

Git repository queries and AI assistance:

```bash
/git            # Show Git status (default)
/git status     # Show Git status
/git log [n]    # Show the most recent n commits (default 5)
/git diff       # Show the staged diff
/git review     # Native read-only review (same as /review uncommitted)
/git commit     # AI generates a commit message and commits
/git pre-commit # AI generates a commit message (does not commit)
```

### /review

Review the current changes, the base branch, or a single commit in an isolated read-only reviewer:

```bash
/review
/review uncommitted
/review base main
/review commit <sha>
```

The reviewer cannot write files, modify Git, or access the network; results are persisted in a structured form with P0-P3 findings, relative path,
line range, and confidence. See
[Native Read-Only Code Review](/en/reference/native-code-review.md).

### /agents

Subagent management:

```bash
/agents         # Open the agent manager
/agents list    # List all agents
/agents create  # Create a new agent
/agents help    # Show help
```

### /resume

Session resume:

```bash
/resume         # Open the session selector
```

### /archive and /unarchive

```bash
/archive                    # Release the current idle Runtime, archive the current session, and exit
/archive <sessionId>        # Archive another session tree not held by its owner
/unarchive <sessionId>      # Restore a direct archive root
```

Archiving preserves the transcript, task evidence, Goal, Snapshot, worktree metadata, and fork/subagent
lineage. After a parent session is archived, descendants atomically inherit the archived state via lineage; the default catalog and
`/resume` no longer show them. If any descendant is still queued/running or holds a Session lease, the entire
archive operation fails with zero writes. For the full contract, see [Durable Session Archive](/en/reference/session-archive.md).

### /export

```bash
/export
/export reports/conversation.md
/export --reasoning
```

Exports the materialized durable history, including user/assistant text, image tags, compaction
summaries, and sanitized tool/subagent/file activity. Reasoning is omitted by default; `--reasoning`
is an explicit visibility switch. The TUI uses `0600` exclusive create, so an existing file is not overwritten; ACP
does not write host files but returns inline Markdown of up to 1 MiB. On Web you can download from the active Session row
or the Archive Popover. For the full contract, see
[Portable Session Markdown Export](/en/reference/session-markdown-export.md).

### /tasks

View the background Shells and Subagents owned by the current parent session and workspace:

```bash
/tasks
/tasks resume <agentId> <follow-up prompt>
/tasks clean
```

`resume` only accepts finished agents. Blade keeps the source run and creates a new child ID that inherits the source
transcript, model, permissions, tools, and isolation config; the `Lineage` column in the list shows the source and resume depth.
When the parent session is executing a turn or has durable pending input, a direct resume is rejected.

### /btw

Ask one side question using the current Session's persisted context:

```bash
/btw What caused the last test failure?
```

The side request runs for one turn and cannot execute tools. It can run beside an
active main Agent turn, and its answer appears in a separate transient TUI or Web
panel. Neither the question nor the answer is written to the main Session JSONL or
included in later model context. ACP returns the same transient answer through
`/btw`. Headless mode has no interactive Session runtime and rejects the command
explicitly.

### /compact

Manually compact the context to generate a summary and save tokens:

```bash
/compact
```

### /memory

Manage the project's automatic memory system. Project knowledge that the Agent records automatically during work (build commands, code patterns, debugging insights, etc.) persists across sessions.

```bash
/memory              # Same as /memory list
/memory list         # List all memory files
/memory show         # Show the MEMORY.md index content
/memory show <topic> # Show the content of a specific topic file
/memory edit         # Edit MEMORY.md with $EDITOR
/memory edit <topic> # Edit a specific topic file with $EDITOR
/memory clear        # Clear all memory files
```

Memory files are stored under `~/.blade/projects/{project}/memory/`.

You can disable the automatic memory feature with the environment variable `BLADE_AUTO_MEMORY=0`.

### /permissions

Open the permission manager to edit `.blade/settings.local.json`:

```bash
/permissions
```

### /mcp

Show MCP server status and available tools:

```bash
/mcp
/mcp logs [server] [limit]
/mcp log-level <server> <debug|info|notice|warning|error|critical|alert|emergency>
/mcp instructions [server]
/mcp complete <server> <prompt|resource> <reference> <argument> [value] [key=value...]
/mcp tasks [server]
/mcp task <mcp_task_*>
/mcp task-cancel <mcp_task_*>
```

Log queries and level adjustments apply only to the current Session; logs do not enter the model context.
`instructions` shows the server tool documentation, processed through the security budget for the current connection, along with the SHA-256.
`complete` only queries the prompt arguments or resource template variables declared in the current Session catalog.
The `tasks` commands only read or cancel the opaque MCP tasks created by the current Session; the server's raw task IDs
are not exposed.

### /skills

Manage the Skills system:

```bash
/skills         # List all available Skills
/skills list    # List all Skills
/skills info <name>  # View Skill details
```

### /plugins

Manage the plugin system:

```bash
/plugins        # List installed plugins
/plugins list   # List all plugins
/plugins install <source|name@marketplace> --trust [--ref <ref>]
/plugins update <name> --trust
/plugins uninstall <name> --confirm
/plugins enable <name> [--scope local|project|global]
/plugins disable <name> [--scope local|project|global]
/plugins marketplace add <source> [--ref <ref>]
/plugins marketplace list
/plugins marketplace update [name]
/plugins marketplace remove <name> --confirm
/plugins policy show
/plugins policy set --restrict true --require-sha true \
  --hosts github.com,git.corp.example \
  --marketplaces team-market \
  --local-roots /opt/approved/plugins \
  --scope global
/plugins refresh
```

Install and update require an explicit `--trust`, because plugins can provide Hooks, MCP, Skills, Agents,
and Commands. Local sources also require the current Workspace to be trusted. Marketplace removal is rejected while
managed plugins still depend on it. A project-level source policy can only tighten the global policy; once
`--require-sha` is enabled, remote Git sources must be pinned to a full 40-character commit SHA.

### /hooks

Manage the Hooks system:

```bash
/hooks          # Show the current Hooks configuration
/hooks list     # List all Hooks
```

### /theme

Open the theme selector:

```bash
/theme
```

### /context

Show the current context usage:

```bash
/context
```

Example output:

```
📊 Context Usage

Current session:
- Message count: 15
- Token usage: 12,345 / 128,000
- Utilization: 9.6%
- Remaining capacity: 90.4%

Model info:
- Model: qwen-max
- Context window: 128,000 tokens

Status: 🟢 Normal
```

### /status

Show the current project and config status:

```bash
/status
```

Example output:

```
📊 Current Status

Project info:
- Name: blade-code
- Type: Node.js project
- Path: /path/to/project

Config status:
- BLADE.md: ✅ Configured

Environment info:
- Working directory: /path/to/project
- Node.js: v22.19.0 or higher
```

### /version

Show version information:

```bash
/version
```

Example output:

```
🗡️ Blade Code vX.Y.Z

Build info:
- Node.js: v22.19.0 or higher
- Platform: darwin
- Architecture: arm64

Features:
- 🤖 Intelligent AI conversation
- 🔧 Automatic project analysis
- 📝 Custom system prompts
- 🎯 Multi-tool integration support
```

## Custom Commands

Blade supports custom slash commands defined via Markdown files:

### Command Location

```
~/.blade/commands/          # User-level commands
<project>/.blade/commands/  # Project-level commands
```

### Command Format

Create a `.md` file and use YAML frontmatter to define metadata:

```markdown
---
name: review
description: Code review command
argumentHint: <file_path>
---

Please perform a code review on the following file:

{{args}}

Focus on:
1. Code quality
2. Potential bugs
3. Performance issues
```

### Metadata Fields

| Field | Description |
|------|------|
| `name` | Command name (required) |
| `description` | Command description |
| `argumentHint` | Argument hint |

### Using Custom Commands

```bash
/review src/agent/Agent.ts
```

## Completion and Navigation

- Type `/` to automatically show suggestions
- Keep typing for fuzzy matching
- `Tab` selects the currently highlighted item
- `↑/↓` moves through the suggestion list
- Once your input contains a space, command suggestions are no longer shown

## Typical Usage

```bash
# Project initialization
/init

# Git workflow
/git status
/git review
/git commit

# Model switching
/model

# Session management
/resume
/compact

# Config management
/permissions
/theme

# Extension management
/skills
/plugins
/hooks
/agents

# Status inspection
/status
/context
/mcp
```

## Related Resources

- [Quick Start](/en/getting-started/quick-start.md) - Basic usage
- [Subagents](/en/guides/subagents.md) - Subagent system
- [CLI Commands](/en/reference/cli-commands.md) - Command-line arguments
