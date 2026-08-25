# 🧰 Tool List

This document lists all built-in tools for Blade Code and their parameter descriptions. Tools are categorized by `ToolKind` (ReadOnly / Write / Execute), which affects permission mode determination.

## File Operations

### Read

Reads file content, supports text, images, PDF, Jupyter Notebook.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | Absolute file path |
| `offset` | number | | Starting line number (begins at 1) |
| `limit` | number | | Number of lines to read (default 2000) |
| `encoding` | string | | File encoding (default utf-8) |

**Type**: ReadOnly
**Returns**: File content with line numbers

### Write

Writes or creates a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | Absolute file path |
| `content` | string | ✅ | File content |
| `encoding` | string | | File encoding (default utf-8) |
| `mode` | string | | Write mode: overwrite / append |
| `mkdirs` | boolean | | Whether to automatically create directories |

**Type**: Write  
**Features**: Supports backup, permission checking, automatic directory creation

### Edit

Performs exact string replacement.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | Absolute file path |
| `old_string` | string | ✅ | String to replace (cannot be empty) |
| `new_string` | string | ✅ | Replacement string (can be empty) |
| `replace_all` | boolean | | Whether to replace all matches (default replaces only first) |

**Type**: Write  
**Features**: Supports rollback, preview, concurrent file locking  
**Note**: Must use the Read tool to read the file first before use

### ApplyPatch

Atomically modifies multiple UTF-8 text files using a strict Codex-style patch grammar.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `patch` | string | ✅ | Complete `*** Begin Patch` / `*** End Patch` document |

Supports `Add File`, `Update File`, `Delete File`, `Move to`, multiple hunks, semantic locators, and `End of File`. Paths must be relative to the workspace.

**Type**: Write  
**Features**: Complete preflight, canonical containment, multi-path locking, staging/backup, fsync, full rollback on failure, Session Snapshot, multi-file LSP/Hook/AutoVerify integration  
**ACP**: Remote filesystem only supports multi-file Update with read-back and compensating rollback; Add/Delete/Move fail closed when the protocol lacks delete/rename  
**Details**: [Atomic ApplyPatch](/en/reference/atomic-apply-patch.md)

### NotebookEdit

Edits Jupyter Notebook files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | .ipynb file path |
| `content` | string | ✅ | Notebook content |

**Type**: Write  
**Features**: Preserves JSON structure integrity

## Search Tools

### Glob

Finds files using glob patterns.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | ✅ | Glob matching pattern |
| `cwd` | string | | Search directory (default current directory) |
| `ignore` | string[] | | List of patterns to ignore |
| `limit` | number | | Result count limit |

**Type**: ReadOnly  
**Features**: Based on fast-glob, with built-in ignoring of common directories like node_modules

### Grep

Content search based on ripgrep.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | ✅ | Search regular expression |
| `path` | string | | Search path |
| `glob` | string | | File filter pattern |
| `context` | number | | Number of context lines |
| `ignore_case` | boolean | | Case insensitive |
| `max_count` | number | | Maximum match count |

**Type**: ReadOnly  
**Features**: Four-level smart fallback (ripgrep → git grep → system grep → JS fallback)

## Shell Commands

### Bash

Executes Shell commands.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | ✅ | Command to execute |
| `cwd` | string | | Working directory |
| `env` | object | | Environment variables |
| `run_in_background` | boolean | | Run in background (for long-running commands) |
| `timeout` | number | | Timeout in milliseconds (default 30000) |

**Type**: Execute  
**Returns**: When running in background, returns `bash_id` and `shell_id`, usable for WriteStdin, KillShell, or TaskOutput  
**Auto-handoff**: When a Session foreground command exceeds `bashForegroundHandoffMs` (default 15000ms) and is still running, it automatically transitions to background with the same PID/ACP terminal; returns `auto_backgrounded=true`, `background_reason=foreground_budget`, and `shell_id`. Set to `0` to disable. Explicit background and auto-candidate share a process-wide active limit of 16, with 4 per Session.  
**Foreground output boundary**: Local stdout/stderr each retain the most recent 1 MiB of raw bytes; ACP remote terminals retain the most recent 1 MiB per merged stdout. When an ACP Client declares terminal capability, terminal creation or execution failure fails closed and does not silently fall back to host execution; when the capability is not declared, the Session uses a local terminal bound to its own workspace cwd from initialization onward and does not call unnegotiated ACP methods. Model-visible results continue to be truncated by command type and return:

- `output_truncated`: Truncation occurred at either capture or model projection layer;
- `stdout_total_bytes` / `stderr_total_bytes`: Complete accumulated bytes, lower bound when accounting is incomplete;
- `stdout_omitted_bytes` / `stderr_omitted_bytes`: Earliest bytes dropped by capture;
- `output_accounting_complete`: Whether cumulative statistics are complete;
- `terminal_output_merged`: `true` when ACP terminal merges stdout/stderr;
- `truncation_info`: Explicitly states earliest output is omitted and shows retained tail.

Tool metadata additionally contains per-stream retained bytes, projection flags, and `terminal_transport=local|acp|local_fallback`. TUI, Headless, Web, and ACP use the same bounded presentation; raw command output is not sent as progress events.

### WriteStdin

Writes standard input to a background Bash process owned by the current session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `shell_id` | string | ✅ | Background Shell ID returned by Bash |
| `data` | string | ✅ | Text written verbatim; line-oriented programs need explicit newline characters |
| `close_stdin` | boolean | | Close stdin after writing to let processes waiting for EOF continue to exit |

**Type**: Execute  
**Security boundary**: Can only operate on current session's Shells; single input maximum 64 KiB; cross-session and cleaned IDs are uniformly treated as not found

### KillShell

Terminates a command running in the background.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `shell_id` | string | ✅ | Background session ID returned by Bash |
| `signal` | string | | Termination signal (default SIGTERM) |

**Type**: Execute

## Network Tools

### WebFetch

Fetches web page or API content, supports Jina Reader content extraction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | ✅ | Request URL |
| `method` | string | | HTTP method (default GET) |
| `headers` | object | | Request headers |
| `body` | string | | Request body |
| `trim` | boolean | | Whether to trim response |
| `extract_content` | boolean | | Use Jina Reader to extract clean content |

**Type**: ReadOnly  
**Features**: Supports Jina Reader extracting web page content to clean Markdown format

### WebSearch

Web search with multi-provider automatic failover (Exa → DuckDuckGo → SearXNG).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✅ | Search keywords |
| `site` | string | | Limit to site |
| `language` | string | | Language preference |
| `region` | string | | Region preference |

**Type**: ReadOnly  
**Returns**: Search result summaries  
**Features**: Uses Exa MCP public endpoint, no API key required, automatic failover

## Browser Automation Tools

Use the native Browser Tool when a task must run JavaScript, operate forms, inspect
DOM state, or verify a UI workflow. Prefer `WebSearch` for indexed discovery and
`WebFetch` for static pages or APIs. Install the pinned Chromium explicitly before
first use:

```bash
blade browser install
blade browser status
```

All six tools are deferred and the Agent loads their schemas through `ToolSearch`.
One lazy Chromium process is shared by the Blade process, while every Session gets
an isolated, ephemeral `BrowserContext`. Cookies, pages, and login state are not
restored after resume, fork, Runtime disposal, or a browser crash. The Agent Browser
is independent from the user-controlled Browser Preview in the Web UI.

| Tool | Type | Operations |
|------|------|------------|
| `BrowserNavigate` | Execute | `goto`, `back`, `forward`, `reload` |
| `BrowserSnapshot` | ReadOnly | Produce a bounded ARIA snapshot with opaque refs |
| `BrowserInteract` | Execute | `click`, `hover`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `scroll` |
| `BrowserWait` | ReadOnly | Wait for load, exact text, exact URL, ref state, or a short delay |
| `BrowserInspect` | ReadOnly | Inspect console, page errors, network, snapshot text, or save a viewport PNG |
| `BrowserPage` | Execute | `list`, `open`, `select`, `close`, `reset` |

`BrowserSnapshot` returns `pageId`, `snapshotId`, a canonical `origin`, and snapshot
refs. Except for page-scoped `scroll`, interaction requires the latest
`pageId + snapshotId + ref + expectedOrigin`. A page or DOM change makes old refs
fail with `browser_snapshot_stale`; the Agent must capture a new snapshot.
New origins in `BrowserNavigate` and the current origin in `BrowserInteract` pass
through normal Execute permission checks. Back, forward, and reload cannot authorize
a new origin.

Security boundaries:

- only HTTP(S) is accepted; URL credentials and non-Web schemes are rejected;
- unapproved cross-origin top-level navigation, redirects, and popups are blocked;
- cross-origin iframe refs and credential-like password, OTP, API key, token, or
  card-security-code controls reject `fill` and `type`;
- arbitrary selectors, JavaScript evaluation, uploads, retained downloads,
  cookie/storage reads, browser permissions, and persistent profiles are absent;
- console/network diagnostics omit headers, bodies, cookies, and query values;
  screenshots use bounded private Session artifacts and ACP omits host paths;
- page content and diagnostics are untrusted external data and cannot grant
  permission or change Blade instructions and policy;
- Browser Tool is not a network sandbox: an authorized page still performs its own
  subresource requests.

## Code Intelligence

### LSP

Queries semantic code information via the current Session's private Language Server. This tool is deferred by default; use `ToolSearch` first to load the schema.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operation` | string | ✅ | definition, references, hover, symbols, implementation, call hierarchy, or diagnostics |
| `filePath` | string | ✅ | Absolute file path within current Session workspace |
| `line` | number | | 1-based line number |
| `character` | number | | 1-based character position |
| `query` | string | | `workspaceSymbol` search text |

**Type**: ReadOnly  
**Security boundary**: Only accesses Session workspace; servers are configured per Workspace Trust and exclusively owned by the Session; ACP remote sessions do not start local LSP.

## Task Management

### Task

Starts a subagent to execute a task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subagent_type` | string | Required for new tasks | Subagent type; omitted or matches source type on resume |
| `description` | string | ✅ | Brief description of 3-100 characters |
| `prompt` | string | ✅ | Detailed task instructions of at least 10 characters |
| `run_in_background` | boolean | | Run in background; default `false` |
| `isolation` | string | | `none` or `worktree` |
| `resume_from` | string | | Finished agent ID to continue |
| `resume` | string | | Deprecated alias for `resume_from` |

**Type**: ReadOnly  
**Features**: Uses configuration from `.blade/agents` or `~/.blade/agents`. Both foreground and background runs are persisted; each resume creates a new immutable child ID and freezes the model, permissions, tools, system prompt, workspace, and isolation configuration inherited from the source run. The `resume_from_hint` in results can be directly used for the next follow-up.

**Lineage**: Returns and persists `resumed_from`, `root_agent_id`, `resume_depth`. Reads and resumes are isolated by `parent sessionId + projectPath`; cross-workspace IDs are treated as nonexistent.

**Background completion notification**: After `run_in_background=true` returns a running result, the parent can continue independent work. When the child reaches a terminal state, Blade persists a hidden completion receipt and automatically resumes the parent; no repeated `TaskOutput` polling is needed. Notification results are at most 32,000 characters, errors at most 8,000 characters; when notifications explicitly mark truncation, `TaskOutput` can be used to read the full durable result.

### TaskOutput

Gets output from a background task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | ✅ | Task ID |

**Type**: ReadOnly  
**Output boundary**: Background Shell stdout/stderr each retain the most recent 1 MiB; text in model and TUI/Web/ACP events continues to be truncated by command type with head and tail preserved. Return values explicitly report truncation via `output_truncated`, `stdout_omitted_bytes`, `stderr_omitted_bytes`, and `truncation_info`, never silently losing boundary information.  
**Agent output**: Contains `resumed_from`, `root_agent_id`, `resume_depth`, and `resume_from_hint`, allowing continuation of the same lineage after process restart. After hard restart, also returns `restart_recovery.outcome` (`completed`, `interrupted`, or `failed`) and `recoveredAt`; `failed` means durable history could not be verified and resume is prohibited.

### TaskCreate

Creates an in-session task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | ✅ | Task title |
| `description` | string | ✅ | Task description |
| `activeForm` | string | | In-progress display text |
| `owner` | string | | Task owner |
| `priority` | string | | Priority |

**Type**: ReadOnly  
**Storage**: `~/.blade/tasks/<session>-agent-<session>.json`

### TaskGet

Reads a single task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | ✅ | Task ID |

**Type**: ReadOnly

### TaskUpdate

Updates task status, content, or dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | ✅ | Task ID |
| `status` | string | | `pending` / `in_progress` / `completed` / `deleted` |
| `subject` | string | | New title |
| `description` | string | | New description |
| `activeForm` | string | | In-progress display text |
| `owner` | string | | Task owner |
| `addBlocks` | array | | Task IDs blocked by current task |
| `addBlockedBy` | array | | Task IDs blocking current task |

**Type**: ReadOnly

### TaskList

Lists current session tasks.

**Type**: ReadOnly

### TeamCreate

Creates an Agent Team and can launch multiple background teammate subagents at once.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_name` | string | ✅ | Team name, will be normalized to a safe directory name |
| `description` | string | | Team goal description |
| `agent_type` | string | | Role label for team lead |
| `peer_messaging` | boolean | | Whether teammate messaging is enabled (default true) |
| `members` | array | | Initial teammate list |
| `tasks` | array | | Initial shared task DAG |

`members` item fields:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Teammate name |
| `subagent_type` | string | ✅ | Registered subagent type |
| `description` | string | | Brief task description |
| `prompt` | string | ✅ | Detailed task instructions |

**Type**: ReadOnly  
**Storage**: `~/.blade/teams/<team-name>/config.json`  
Each `tasks` item supports `subject`, `description`, `depends_on`, `assigned_to`,
and `priority`. Members share a task graph scoped by team name; write-capable
roles use isolated worktrees by default. Member completions notify the team lead.

### TeamStatus

Lists Agent Teams, or views member status for a specified team.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_name` | string | | Team name; lists all teams when omitted |

**Type**: ReadOnly

### TeamTaskClaim

Atomically claims the next dependency-ready task that has not been claimed by
another member. A preassigned task can only be claimed by its target member.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_name` | string | | Team name; omitted in teammate context |
| `member_id` | string | | Member ID; omitted in teammate context |

**Type**: ReadOnly

### SendMessage

Sends a durable message to a teammate; `to: "*"` broadcasts. A running target
receives it at the next safe boundary, while messages that cannot be delivered
immediately remain in the mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_name` | string | | Team name; omitted in teammate context |
| `to` | string | Yes | Teammate name or `*` |
| `message` | string | Yes | Message body |

**Type**: ReadOnly

### TeamInbox

Reads the durable team mailbox and can acknowledge selected message IDs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_name` | string | | Team name; omitted in teammate context |
| `recipient` | string | | Recipient; defaults to the current member or team lead |
| `acknowledge` | array | | Message IDs to acknowledge |

**Type**: ReadOnly

### TeamDelete

Marks a team as ended and can cancel running teammate agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_name` | string | ✅ | Team name |
| `kill_running` | boolean | | Whether to cancel running members (default true) |

**Type**: ReadOnly

## Plan Mode Tools

### EnterPlanMode

Enters Plan mode (read-only research mode).

**Type**: ReadOnly

### ExitPlanMode

Exits Plan mode and submits the plan.

This tool is only valid when current permission mode is Plan. If compressed context or old messages request exit again in other modes, the runtime returns `validation_error` without triggering confirmation or ending the current tool loop; the model should continue executing already approved implementation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | ✅ | Plan title |
| `plan` | string | ✅ | Plan content (Markdown) |

**Type**: ReadOnly

## System Tools

### ReadPromptArtifact

Reads a large user request from the current Session's private storage in bounded
chunks. Blade provides an opaque `artifact_id` when user text exceeds 32 KiB.
Start at offset `0` and continue from the returned offset until the result
contains `[End of prompt artifact]`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifact_id` | string | ✅ | 64-character lowercase hexadecimal ID supplied in the user message |
| `offset` | number | | UTF-8 byte offset; defaults to `0` |
| `limit` | number | | Bytes per read, from `4` through `65536`; defaults to `24576` |

**Type**: ReadOnly
**Features**: Session isolation, content-hash verification, UTF-8 boundary alignment, and no host-path exposure

### MemoryRead

Reads project memory files. Project knowledge automatically recorded by the Agent persists across sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | ✅ | Topic name (e.g., "debugging") or "_list" to list all files, "MEMORY" to read index |

**Type**: ReadOnly  
**Returns**: Memory file content or file list

### MemoryWrite

Saves project memory. Supports sensitive data filtering (password/token/secret/api_key/private_key).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | ✅ | Topic name (e.g., "patterns"), "MEMORY" writes index |
| `content` | string | ✅ | Content to save |
| `mode` | string | | Write mode: overwrite / append (default append) |

**Type**: Write  
**Features**: Automatically filters sensitive data, prevents path traversal

### AskUserQuestion

Asks the user a question and waits for a reply.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | ✅ | Question content |

**Type**: ReadOnly

### Skill

Invokes a registered Skill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skill_name` | string | ✅ | Skill name |
| `input` | string | | Input parameters |

**Type**: Execute

### SlashCommand

Executes a Slash command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | ✅ | Command content |

**Type**: Execute  
**Note**: For system use, users typically do not need to use directly

## MCP Tools

MCP servers registered via `blade mcp add` are loaded at runtime, and their tools are added to the tool list under stable names of the form `mcp__<server>__<tool>`.
MCP tools are deferred by default and require `ToolSearch` to activate their schema first. Form/URL `elicitation/create` during tool execution is projected to TUI, Web, and ACP; when there is no interactive surface or the client cannot express request fields, it fails closed. MCP servers can read the current Session execution workspace roots; `sampling/createMessage` is disabled by default, and each call requires one-shot user approval when explicitly enabled. See [MCP Elicitation](/en/reference/mcp-elicitation.md) and [MCP Roots and Sampling](/en/reference/mcp-roots-sampling.md) for details. MCP tools inherit Session cancel, support idle/hard timeout and real-time progress; see [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md) for details. Ordinary `tools/call` results undergo text/structured/binary budgets, 0600 Session artifact, and metadata allowlist before entering the model; see [MCP Tool Result Safety Boundary](/en/reference/mcp-tool-result-safety.md) for details. Remote OAuth servers only consume endpoint/client/scopes credentials after explicit login; Sessions do not open browsers on their own; see [MCP OAuth Lifecycle](/en/reference/mcp-oauth-lifecycle.md) for details. Servers can atomically update catalogs via `list_changed`; see [MCP Dynamic Tool Catalog](/en/reference/mcp-dynamic-catalog.md) for details. Resources, Resource Templates, Prompts, and explicit Subscriptions are exposed through `ListMcpResources`, `ListMcpResourceTemplates`, `ReadMcpResource`, `ListMcpPrompts`, `CompleteMcpArgument`, `GetMcpPrompt`, and `ManageMcpResourceSubscription`; complete constraints are in [MCP Resources, Prompts, and Subscriptions](/en/reference/mcp-resources-prompts.md) and [MCP Completion](/en/reference/mcp-completion.md). Completion only accepts parameters declared in the current Session catalog and enforces candidate Unicode, bytes, concurrency, timeout, and provenance boundaries. Transport exceptions first revoke the old catalog, then execute Session-private cancellable bounded recovery and rebuild subscriptions; see [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md) for details. Standard `notifications/message` logs are filtered per Session negotiated level, desensitized and rate-limited, projected only to the user and not entering the model; see [MCP Logging and Diagnostics](/en/reference/mcp-logging.md) for details. InitializeResult instructions, after hidden Unicode, per-server/Session cumulative budget, and provenance wrapping, enter local model context as external untrusted tool documentation for the corresponding server; see [MCP Server Instructions](/en/reference/mcp-server-instructions.md) for details. Experimental task-capable tools are only available when the server's `tasks.enabled` is explicitly turned on: `required` tools automatically return opaque `mcp_task_*`, `optional` tools can be backgrounded via `StartMcpTask`, and uniformly managed with `TaskOutput`, `ListMcpTasks`, and `CancelMcpTask`. See [MCP Async Tasks](/en/reference/mcp-tasks.md) for complete ownership, recovery, and result safety boundaries.

```bash
# Add MCP server
blade mcp add local -- node ./path/to/mcp-server.mjs

# View registered servers
blade mcp list
```

## Permissions and Tool Types

| Tool Type | default | autoEdit | plan | yolo |
|-----------|---------|----------|------|------|
| ReadOnly | ✅ Auto | ✅ Auto | ✅ Auto | ✅ Auto |
| Write | ⚠️ Confirm | ✅ Auto | ❌ Deny | ✅ Auto |
| Execute | ⚠️ Confirm | ⚠️ Confirm | ❌ Deny | ✅ Auto |

See the [Permission System](/en/configuration/permissions.md) section for details.

## Tool Overview

| Category | Tool | Type | Description |
|----------|------|------|-------------|
| File Operations | Read | ReadOnly | Read file content |
| File Operations | Write | Write | Write or create file |
| File Operations | Edit | Write | Replace file content by string/regex |
| File Operations | NotebookEdit | Write | Edit Jupyter Notebook |
| Search | Glob | ReadOnly | Find files with glob patterns |
| Search | Grep | ReadOnly | ripgrep-based content search |
| Shell | Bash | Execute | Execute Shell commands |
| Shell | KillShell | Execute | Terminate background commands |
| Network | WebFetch | ReadOnly | Fetch web/API content (supports Jina Reader) |
| Network | WebSearch | ReadOnly | Web search (Exa/DuckDuckGo/SearXNG) |
| Browser | BrowserNavigate | Execute | Navigate, move through history, or reload |
| Browser | BrowserSnapshot | ReadOnly | Capture a bounded ARIA snapshot with refs |
| Browser | BrowserInteract | Execute | Use the latest snapshot ref for controlled interaction |
| Browser | BrowserWait | ReadOnly | Wait for page, text, URL, or ref state |
| Browser | BrowserInspect | ReadOnly | Read bounded diagnostics, find snapshot text, or capture |
| Browser | BrowserPage | Execute | Manage or reset Session-private pages |
| Tasks | Task | ReadOnly | Start subagent to execute task |
| Tasks | TaskOutput | ReadOnly | Get background task output |
| Tasks | TaskCreate | ReadOnly | Create session task |
| Tasks | TaskGet | ReadOnly | Read single task |
| Tasks | TaskUpdate | ReadOnly | Update task status or content |
| Tasks | TaskList | ReadOnly | List current tasks |
| Plan | EnterPlanMode | ReadOnly | Enter read-only research mode |
| Plan | ExitPlanMode | ReadOnly | Exit and submit plan |
| System | ReadPromptArtifact | ReadOnly | Read a Session-private large user request in chunks |
| System | MemoryRead | ReadOnly | Read project memory file |
| System | MemoryWrite | Write | Save project memory |
| System | AskUserQuestion | ReadOnly | Ask user a question |
| System | Skill | Execute | Invoke registered Skill |
| System | SlashCommand | Execute | Execute Slash command |
