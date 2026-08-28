# 📋 CLI Command Reference

This document details all command-line options and subcommands for Blade Code.

## Default Entry Point

```bash
# Start interactive interface
blade

# Send initial message on startup
blade "Help me create a README"
```

Without subcommands, launches the Ink interface. If no model is configured, it automatically enters the model configuration wizard.

## Global Options

### Debug Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--debug [filters]` | `-d` | Enable debug logging, supports category filtering |

Debug category filtering examples:
```bash
# Show only agent and ui logs
blade --debug "agent,ui"

# Exclude chat and loop logs
blade --debug "!chat,!loop"
```

Supported categories: `agent`, `ui`, `tool`, `service`, `config`, `context`, `execution`, `loop`, `chat`, `general`

### Output Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--print` | `-p` | Print mode, exit after outputting result |
| `--output-format <format>` | | Output format: `text` / `json` / `stream-json` |
| `--include-partial-messages` | | Include streaming message fragments |
| `--json-schema <json>` | | Set inline JSON Schema for the current print/headless turn |
| `--output-schema <file>` | | Load JSON Schema for the current turn from a file |

### Input Options

| Option | Description |
|--------|-------------|
| `--input-format <format>` | Input format: `text` / `stream-json` |
| `--replay-user-messages` | Replay user messages from stdin |

### Security Options

| Option | Description |
|--------|-------------|
| `--permission-mode <mode>` | Permission mode: `default` / `autoEdit` / `yolo` / `plan` |
| `--yolo` | Equivalent to `--permission-mode=yolo` |
| `--allowed-tools <tools>` | Allowed tools list (comma or space separated) |
| `--disallowed-tools <tools>` | Disallowed tools list |
| `--add-dir <dirs>` | Additional directories to allow access to |

### Session Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--continue` | `-c` | Continue the most recent session; in print/headless without new input, resume unfinished durable turn / Goal, or replay the final response just fixed by this launch |
| `--resume [id]` | `-r` | Resume a specific session (TUI opens interactive selector without argument); print/headless can omit wakeup prompt, final-ready crash will not call Provider again |
| `--fork-session` | | Used with `--resume`/`--continue`, copies history to an independent child session, parent session remains unchanged |
| `--session-id <id>` | | Specify new session ID; must enable `--fork-session` when used with resume parameters |

### AI Options

| Option | Description |
|--------|-------------|
| `--settings <file-or-json>` | Load temporary settings for the current process; explicit CLI parameters take precedence |
| `--system-prompt <prompt>` | Replace system prompt |
| `--append-system-prompt <prompt>` | Append to system prompt |
| `--max-turns <n>` | Conversation turn limit (-1: unlimited, 0: disabled, N: limit) |
| `--no-verification-agent` | Disable built-in independent verification Subagent in Headless mode; explicit test requests will still execute |
| `--agents <json>` | Inject custom Subagents for this run; CLI definitions have highest priority |
| `--max-resident-session-runtimes <n>` | Upper limit of initialized Session Runtimes within Web/ACP process (1-256) |
| `--session-runtime-idle-ms <ms>` | Web idle Runtime reclamation TTL (30000-3600000ms) |

`--settings` supports both file paths and inline JSON. File paths are resolved relative to the working directory when Blade is launched; invalid JSON, unknown fields, and type errors will cause startup to fail. This option applies to CLI/TUI, print, and headless modes, and does not persist configuration.

`--agents` accepts inline JSON keyed by agent name, applies to CLI/TUI, print, and headless modes, and does not write to user or project configuration:

```bash
blade --agents '{"reviewer":{"description":"Review code changes","prompt":"Find correctness risks and run tests.","tools":["Read","Grep","Bash"],"maxTurns":6}}'
```

Definitions must include `description` and `prompt`; unknown fields, invalid types, or format errors will cause startup to fail. See [Subagents guide](/en/guides/subagents.md) for full field descriptions.

### Headless Concurrency and Memory

Each `blade --headless` is an independent process that loads the full model, tools, and session runtime; built-in verification Subagent execution also increases single-process peak memory. There is no shared task admission controller between multiple independent CLI processes. CI or batch evaluation should start with concurrency 2, gradually increase based on actual RSS, and leave sufficient headroom for the container/Runner. In memory-constrained environments, use `--no-verification-agent` and have external pipelines execute tests and reviews. When you need Blade to queue uniformly, use `blade serve` with `maxConcurrentTasks` / `maxQueuedTasks` / `maxQueuedTaskBytes`; do not launch many headless processes in parallel. The corresponding CLI overrides are `--max-concurrent-tasks`, `--max-queued-tasks`, and `--max-queued-task-bytes`.

`--max-resident-session-runtimes` and `--session-runtime-idle-ms` only control the multiplexed Runtime registry within the same Web/ACP process. Ordinary CLI/TUI/print/Headless root turns only own one Runtime per process and do not enter this registry. Web performs LRU/TTL reclamation on idle Runtimes and cold-rebuilds from durable state; ACP clients should call standard `session/close` to release capacity. See [Session Runtime Residency](/en/reference/session-runtime-residency.md) for details.

### MCP Options

| Option | Description |
|--------|-------------|
| `--mcp-config <config>` | Load MCP servers from JSON file or string |
| `--strict-mcp-config` | Only use servers specified by --mcp-config |

### Integration Options

| Option | Description |
|--------|-------------|
| `--ide` | Automatically connect to IDE on startup |
| `--acp` | Run in ACP (Agent Client Protocol) mode |

## Print Mode

Use `-p` or `--print` to enter print mode without starting the UI:

```bash
# Output result directly
blade --print "Explain what TypeScript is"

# Pipe input
echo "Please summarize this text" | blade -p

# JSON output
blade -p --output-format json "Generate a function"

# Streaming JSON output
blade -p --output-format stream-json "Write some code"

# Execute directly in Session workspace without calling model
blade -p '! pwd'
blade -p --output-format stream-json '! npm test'
```

`--json-schema` and `--output-schema` are mutually exclusive. Structured output is validated by the host; ordinary JSON prose is not accepted as a successful result. See [Schema-Constrained Structured Output](/en/reference/schema-constrained-output.md) for the complete contract.

## Subcommands

### blade web

Start the Web UI server and automatically open a browser.

```bash
blade web [options]
```

**Options**:

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | Listen port (0 for auto-select) | `0` |
| `--hostname <host>` | Listen hostname | `127.0.0.1` |
| `--cors <domains>` | Additional allowed CORS domains | `[]` |

**Examples**:

```bash
# Default startup (auto-select port, open browser)
blade web

# Specify port
blade web --port 3000

# Allow LAN access
blade web --hostname 0.0.0.0 --port 3000
```

**Security Tip**: Set the `BLADE_SERVER_PASSWORD` environment variable to enable Basic Auth authentication.

### blade serve

Start a headless Web server (without opening a browser), suitable for remote access or integration scenarios.

```bash
blade serve [options]
```

**Options**: Same as `blade web`.

**Examples**:

```bash
# Start headless server
blade serve --port 3000 --hostname 0.0.0.0

# Start with authentication
BLADE_SERVER_PASSWORD=secret blade serve --port 3000
```

### blade doctor

Environment self-check, checks configuration loading, Node version, directory permissions, etc.

```bash
blade doctor
```

Return code: 0 for success, 1 for failure.

### blade update

Check and display current version information.

```bash
blade update
```

### blade browser

Manage the pinned Chromium used by the native Browser Tool. Installing the npm
package does not download a browser automatically.

```bash
blade browser install  # Download Chromium through the installed Playwright CLI
blade browser status   # Offline version, executable-path, and launch check
```

`status` exits non-zero and prints the install command when Chromium is missing or
cannot launch. Ordinary `blade --help`, `blade --version`, and Sessions that do not
use Browser tools never start Chromium.

### blade mcp

Manage MCP servers.

#### mcp list / mcp ls

List registered MCP servers.

```bash
blade mcp list
```

#### mcp add

Add an MCP server.

```bash
blade mcp add <name> <cmdOrUrl> [args...]
```

Options:
- `--transport <type>`: Transport type (stdio / http / sse)
- `--env KEY=VAL`: Environment variable
- `--header "K: V"`: HTTP header
- `--timeout <ms>`: Timeout duration

Examples:
```bash
# Add GitHub MCP server
blade mcp add github -- npx -y @modelcontextprotocol/server-github

# Add server with environment variables
blade mcp add myserver --env API_KEY=xxx -- node server.js

# Add HTTP server
blade mcp add api --transport http https://api.example.com/mcp
```

#### mcp add-json

Pass JSON configuration directly.

```bash
blade mcp add-json <name> '<json>'
```

Examples:
```bash
blade mcp add-json api '{"type":"http","url":"https://api.example.com"}'
```

OAuth servers use standard discovery; do not write tokens, client secrets, or endpoints in the configuration:

```bash
blade mcp add-json remote \
  '{"type":"http","url":"https://mcp.example.com/rpc","oauth":{"enabled":true,"scopes":["mcp:tools"]}}'
blade mcp login remote
```

#### mcp remove / mcp rm

Remove an MCP server.

```bash
blade mcp remove <name>
```

#### mcp get

Get a single server configuration.

```bash
blade mcp get <name>
```

#### mcp login / logout

Explicitly start the OAuth browser flow, or clear credentials for that endpoint/client/scopes identity. Ordinary `mcp list`, connection, and Session startup will not implicitly open a browser.

```bash
blade mcp login <name>
blade mcp logout <name>
```

TUI corresponds to `/mcp login <name>` and `/mcp logout <name>`; headless and ACP will reject host OAuth interactions. See [MCP OAuth Lifecycle](/en/reference/mcp-oauth-lifecycle.md) for the full security contract.

## Interactive Interface

### Keyboard Shortcuts

| Shortcut | Function |
|----------|----------|
| `Ctrl+C` | Interrupt current task |
| `Ctrl+D` | Exit program |
| `Ctrl+L` | Clear screen |
| `Ctrl+T` | Expand/collapse thinking chain |
| `Ctrl+O` | Open/close the read-only transcript pager |
| `Esc` | Close suggestions / interrupt execution |
| `Shift+Tab` | Cycle through permission modes |
| `↑` / `↓` | History command navigation |
| `Tab` | Autocomplete |

The transcript pager supports `↑/↓`, `j/k`, `PageUp/PageDown`, and `g/G` for
top/bottom navigation. Scrolling away from the bottom pauses follow mode and
counts new messages; `G` returns to the latest output and resumes following.
While an approval is visible, `PageUp/PageDown` still browse the transcript.

Inside the pager, press `/`, enter a full-text query, and confirm with `Enter`;
then use `n/N` to cycle forward or backward through matches. Search includes
collapsed tool details and Thinking content and expands the matching item on
jump. Use `Tab`/`Shift+Tab` to select an expandable item and `Enter` or `e` to
toggle it independently. Press `v` to start line selection, extend it with the
navigation keys, and copy with `y` or `Ctrl+C`. `Esc` first cancels search
editing or selection; press it again to leave the pager.

### Input Triggers

- Starting with `/`: Triggers Slash command completion
- Starting with `@`: Triggers file path completion
- Starting with `!`: Executes user shell command in the current Session workspace without calling the model

`! <command>` uses the Session's frozen cwd/env, and results enter durable history. During an active Agent turn, it is injected as persisted auxiliary steering at the next safe provider boundary. TUI shows a yellow `$` prompt; Web shows a structured command card; ACP uses the IDE terminal and does not fall back to host shell when unavailable. See [Session-owned User Shell Command](/en/reference/session-user-shell-command.md) for details.

TUI supports standard bracketed paste, IME/batched multi-character input, and CRLF normalization; terminal paste mode is enabled/restored in pairs on startup and exit, and independent focus CSIs are filtered. See [TUI Terminal Input](/en/reference/tui-terminal-input.md) for details.

### Session Slash Commands

#### `/effort [level]`

View or switch the reasoning effort level for the current Session:

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

Explicit levels must be supported by the current model; `auto` remains a durable policy and resolves the effective level when the Provider is created. Switching is rejected during active turns; if Runtime replacement or metadata writing fails, the original model/effort/tier/verbosity/style quintuple settings are maintained or restored. See [Session Reasoning Effort](/en/reference/session-reasoning-effort.md) for details.

#### `/speed [tier]` and `/fast [on|off]`

View or switch the Provider service tier for the current Session:

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

`auto` does not override Provider defaults; `standard`, `fast`, and `flex` are explicit price/latency semantics, failing closed if the model does not support them. `/fast on` selects `fast`, `/fast off` selects `standard`. Switching is rejected during active turns; if Runtime replacement or metadata writing fails, the original model/effort/tier/verbosity/style quintuple settings are maintained or restored. See [Session Service Tier](/en/reference/session-service-tier.md) for details.

#### `/verbosity [level]` and `/detail [level]`

View or switch the native Provider response verbosity for the current Session:

```bash
/verbosity
/verbosity auto
/verbosity low
/verbosity medium
/verbosity high
/detail high
```

`auto` does not override Provider defaults; explicit `low`, `medium`, and `high` must be supported by the current model. `/detail` is a full alias. Switching is rejected during active turns; if Runtime replacement or metadata writing fails, the original model/effort/tier/verbosity/style quintuple settings are maintained or restored. See [Session Response Verbosity](/en/reference/session-response-verbosity.md) for details.

#### `/style [name]` and `/personality [name]`

View or switch the communication style for the current Session:

```bash
/style
/style auto
/style pragmatic
/style friendly
/style explanatory
/style project:review:strict
/personality friendly
```

Style controls only tone and explanatory framework, orthogonal to the native Provider `responseVerbosity`. `/personality` is a full alias. Switching is rejected during active turns; if metadata writing fails, the previous quintuple Session settings are restored. See [Session Communication Style](/en/reference/session-communication-style.md) and [Trusted Custom Output Styles](/en/reference/trusted-output-styles.md) for details.

#### `/review [target]`

Launch an independent read-only reviewer:

```bash
/review
/review uncommitted
/review base main
/review commit HEAD
```

`/git review` is equivalent to `/review uncommitted`. The reviewer uses an independent Session, diff digest, structured P0-P3 findings, and workspace-read-only sandbox; it will not fix or modify the code being reviewed. See [Native Read-Only Code Review](/en/reference/native-code-review.md) for details.

#### `/btw <question>`

Run one context-aware question without changing the main Agent turn. The request
reuses the current Session's persisted model context and Provider configuration,
but cannot execute tools, create a main run, or write its question or answer to
the Session JSONL. TUI and Web use a separate transient panel; ACP returns the
answer through the slash-command response. Headless rejects the command because
it has no active Session runtime.

#### `/resume [sessionId]`

Resume a historical session. Opens the session selector without an ID.

If a Session exits during permission confirmation, `AskUserQuestion`, or MCP input, TUI resume will first restore the original interaction before continuing the durable inbox. print/headless cannot collect interactive input, so it will fail closed by rejecting the request and letting the model continue based on the resume result. See [Durable Pending Interactions](/en/reference/durable-pending-interactions.md) for the complete contract.

```bash
# Interactively select historical session
/resume

# Resume known session
/resume parent-session-id
```

#### `/archive [sessionId]` and `/unarchive <sessionId>`

Without arguments, `/archive` releases the current TUI's idle Runtime, archives the current Session, and exits. When specifying an ID, archives another Session tree not occupied by a CLI/Web/ACP owner. Resume must point directly to the archive root:

```bash
/archive
/archive parent-session-id
/unarchive parent-session-id
```

Archiving preserves the transcript and all task/lineage evidence, and removes the Session and its descendants from the default catalog. Queued/running descendants, active turns, or any Session lease will cause the entire operation to fail closed. See [Durable Session Archive](/en/reference/session-archive.md) for details.

#### `/export [path] [--reasoning]`

Export materialized Markdown from the current Session's stable JSONL snapshot:

```bash
/export
/export reports/conversation.md
/export --reasoning
```

Default includes user/assistant, image tags, summary, and cleaned activity; reasoning requires explicit opt-in. Output uses `0600` exclusive create, does not overwrite existing files. ACP `/export` returns bounded inline Markdown and does not accept host paths. See [Portable Session Markdown Export](/en/reference/session-markdown-export.md) for details.

#### `/fork [sessionId]`

Create an independent child session from the current workspace's durable session. Opens the session selector without an ID; the selector will not show subagent sessions. A known ID must belong to the current workspace and cannot be a subagent session. When the Agent is processing the current turn, `/fork` will be rejected without diverting or aborting the active turn.

```bash
# Pick a source interactively
/fork

# Fork a known durable session
/fork parent-session-id
```

Fork only copies the source session's conversation history committed before the boundary: the parent session remains unchanged, the child session uses the source workspace, and waits for the next user prompt. It does not rewind or copy workspace files, nor does it create a Git branch; use Git worktree or branch separately when you need file isolation. Model configuration and permission mode are also inherited at the fork boundary; explicit `--permission-mode` still takes precedence over inherited values. See [Session Permission Mode](/en/reference/session-permission-mode.md) for details.

#### `/branch`

Copy the committed history of the currently active session to an independent child session and immediately switch to it. It does not accept a source session ID; use `/fork [sessionId]` when you need to select a source from historical sessions. After ACP calls `/branch`, it returns a child session ID that can be loaded by standard `session/load`.

#### `/rewind [checkpointId]`

Without arguments, lists durable user-turn checkpoints for the current session. After specifying a checkpoint, defaults to rewinding only conversation; add `--code` to also restore file modifications at and after that turn, add `--code-only` to restore only files and keep conversation.

```bash
# List user turns available for rewind
/rewind

# Rewind conversation only
/rewind <checkpointId>

# Rewind both conversation and code
/rewind <checkpointId> --code

# Restore code only
/rewind <checkpointId> --code-only

# Legacy single-file last edit rewind compatibility
/rewind file src/example.ts
```

Rewind is only allowed when the session is idle and the durable input queue is empty; it will also be rejected when there are running background shells or background agents. When a file was externally modified after Blade edited it, code restoration fails closed for the entire group and does not overwrite the user's new changes.

#### `/tasks [clean | resume <agentId> <prompt>]`

Lists background Shells and Subagents owned by the current `sessionId + projectPath`, and displays agent lineage. `resume` creates a new durable child run from a finished agent:

```bash
/tasks
/tasks resume agent-source-id inspect fixes and run relevant tests
/tasks clean
```

Resume does not modify the source run. The child inherits the source transcript, model, permissions, tools, system prompt, and isolation configuration, and records a new agent ID, `resumedFrom`, `rootAgentId`, and `resumeDepth`. Resume fails closed when an active parent turn or durable pending input exists.

### Web Sidebar Fork

The session row in the Web Sidebar provides a **Fork** action. After the server creates the child, Web first prepares the child's SSE subscription, then atomically activates the child with the `sessionId + projectPath` compound workspace identity to avoid switching errors from same-named sessions or late events. The new child has inherited committed history and is waiting for the next prompt; Fork does not create or copy a task dashboard.

### ACP session discovery and fork

ACP SDK 0.12 exposes `session/list` and `session/fork` as unstable wire capabilities; TypeScript agents implement the corresponding `unstable_listSessions` and `unstable_forkSession` methods. The child returned by `session/fork` is initialized and can immediately receive prompts without calling `session/load` again. Fork responses do not replay history; only explicit `session/load` uses the history replay protocol.

## Usage Examples

```bash
# Basic usage
blade "Help me refactor this function"

# Print mode (script integration)
git diff | blade --print --append-system-prompt "Please provide code review suggestions"

# Plan mode startup
blade --permission-mode plan

# Resume historical session
blade --resume

# Resume with specified session ID
blade --resume 2024-12-foo-session

# Non-interactive mode directly resumes unfinished turn without creating additional user message
blade --headless --resume 2024-12-foo-session
blade --print --continue

# Create independent child session from history (supports TUI, print, headless)
blade --resume 2024-12-foo-session --fork-session --session-id experiment-1

# Debug mode
blade --debug agent "Analyze this code"

# Fully automatic mode
blade --yolo "Fix all TypeScript errors"
```

## Environment Variables

Blade Code supports configuration via environment variables:

| Variable | Description |
|----------|-------------|
| `BLADE_DEBUG` | Enable debug mode |
| `BLADE_CONFIG_DIR` | Custom configuration directory |
| `NO_COLOR` | Disable color output |

## Exit Codes

| Exit Code | Description |
|-----------|-------------|
| 0 | Success |
| 1 | General error |
| 130 | User interrupted (Ctrl+C) |
