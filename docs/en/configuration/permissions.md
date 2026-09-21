# 🔒 Permission System

Blade provides a comprehensive permission control system that ensures the safety and controllability of AI operations.

## Permission Levels

| Level | Description | Priority |
|-------|-------------|----------|
| `deny` | Reject execution outright | Highest |
| `allow` | Allow execution automatically | Medium |
| `ask` | Requires user confirmation | Low |

Matching order: `deny` > `allow` > `ask` > default (ask)

## Permission Modes

Blade provides four permission modes. In the TUI, `Shift+Tab` cycles between `default`, `autoEdit`, and
`plan`; `yolo` must be enabled via an explicit command, launch argument, or setting.

### DEFAULT Mode (default)

```
✅ Auto-approved: read-only tools (Read, FindFiles, Glob, Grep, WebFetch, WebSearch, TaskCreate/TaskGet/TaskUpdate/TaskList, Task, Plan tools)
❌ Requires confirmation: Write tools (Edit, Write, ApplyPatch, NotebookEdit), Execute tools (Bash, Skill, SlashCommand)
```

Use case: everyday usage, balancing safety and efficiency.

### AUTO_EDIT Mode

```
✅ Auto-approved: read-only tools + Write tools
❌ Requires confirmation: Execute tools (Bash, Skill, SlashCommand)
```

Use case: development tasks that frequently modify code.

### PLAN Mode

```
✅ Auto-approved: read-only tools
❌ Blocks all modifications: Write and Execute tools
🔵 Special tool: ExitPlanMode (used to submit a plan)
```

Use case: research phase, generating an implementation plan and exiting after user approval.

### YOLO Mode (dangerous)

```
✅ Auto-approved: all tools
⚠️ Warning: fully trusts the AI, skips all confirmations
```

Use case: highly controlled environments or demo scenarios.

## Permission Rule Configuration

### Rule Format

```
Tool(param1:value1, param2:value2)
```

Supports `*` and `**` wildcards (using picomatch):

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Read(file_path:**/*.ts)",
      "Bash(git *)",
      "Bash(npm run *)"
    ],
    "deny": [
      "Read(file_path:**/.env*)",
      "Read(file_path:**/*.pem)",
      "Bash(rm -rf *)",
      "Bash(sudo *)"
    ]
  }
}
```

### Common Rule Examples

#### File Access Control

```json
{
  "allow": [
    "Read(file_path:**/*.{ts,tsx,js,jsx,md,json})",
    "Write(file_path:**/*.ts)",
    "Edit(file_path:src/**/*)"
  ],
  "deny": [
    "Read(file_path:**/.env*)",
    "Read(file_path:**/*.pem)",
    "Read(file_path:**/secrets/**)",
    "Write(file_path:**/node_modules/**)"
  ]
}
```

#### Command Execution Control

```json
{
  "allow": [
    "Bash(git *)",
    "Bash(npm run *)",
    "Bash(pnpm *)",
    "Bash(ls *)",
    "Bash(cat *)",
    "Bash(head *)",
    "Bash(tail *)"
  ],
  "deny": [
    "Bash(rm -rf *)",
    "Bash(sudo *)",
    "Bash(chmod *)",
    "Bash(curl * | bash)",
    "Bash(wget * | bash)"
  ]
}
```

#### Network Access Control

```json
{
  "allow": [
    "WebFetch(url:https://api.github.com/**)",
    "WebFetch(url:https://registry.npmjs.org/**)",
    "WebSearch"
  ],
  "deny": [
    "WebFetch(url:http://**)",
    "WebFetch(url:**/admin/**)"
  ]
}
```

## Confirmation and Persistence

### Confirmation Dialog

When a rule resolves to `ask`, a confirmation dialog pops up:

```
┌─────────────────────────────────────────┐
│ 🔧 Tool Call Confirmation                │
├─────────────────────────────────────────┤
│ Bash: npm run build                     │
│                                         │
│ [Once] [Session] [Project] [Deny]        │
└─────────────────────────────────────────┘
```

### Session Authorization

Choosing `Session` only stores the abstracted rule in the current Session Runtime's memory. After the session
ends or the Runtime is released, the authorization expires automatically and is not written to project files.

### Project Authorization

Only by explicitly choosing `Project` will the abstracted rule be written to `.blade/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run build*)"
    ]
  }
}
```

### Rule Abstraction

How rules are abstracted for different tools:

| Tool | Abstracted Rule Example |
|------|-------------------------|
| Bash | `Bash(command:npm *)` |
| Edit/Write/ApplyPatch | `Edit(file_path:**/*.ts)` |
| WebFetch | `WebFetch(url:https://api.github.com/**)` |
| WebSearch | `WebSearch(query:*)` |
| BrowserNavigate | `BrowserNavigate(http://127.0.0.1:3000)` |
| BrowserInteract | `BrowserInteract(https://example.com:443)` |
| BrowserPage | `BrowserPage(reset)` |
| Task/SlashCommand | No rule generated automatically |

Browser permissions are abstracted by canonical origin and omit URL query values,
typed text, refs, and page content. `BrowserSnapshot`, `BrowserWait`, and
`BrowserInspect` are ReadOnly; navigation, interaction, and page management are
Execute. A cross-origin top-level transition requires a new `BrowserNavigate` call
and cannot inherit authorization for the previous origin.

## Turn Limit

Set an explicit model-round limit for a task:

```json
{
  "maxTurns": 100
}
```

- `0` - Disable the conversation
- `-1` - Unlimited rounds
- `N > 0` - Limit to N model rounds; YOLO mode also respects an explicit limit

Output-length recovery, incomplete-intent correction, structured-output correction, verification/delegation requirements, empty-final recovery, Stop hooks, and mid-turn input cannot bypass this limit. A valid final response can still complete on the last permitted round. Context-limit replay before crossing the output boundary still counts as the same round.

The interactive TUI asks whether to continue at the limit. Choosing "Continue" compacts the conversation and commits its checkpoint before resetting the round counter; choosing "Stop" ends the task. Cancellation while awaiting this choice ends the task without starting compaction. Non-interactive callers without a continuation callback receive `max_turns_exceeded` without another model request. The exhausted turn's consumed input is acknowledged so Web reload or process recovery cannot automatically replay it; unconsumed follow-up input remains queued.

Runtime-generated correction, Stop hook, and continuation controls remain in model context but are not displayed as user messages in conversation history or exports. Visibility is metadata-based, so identical text entered by the user remains visible; older records without a visibility marker are not guessed from text or rewritten automatically.

## CLI Arguments

```bash
# Specify the permission mode
blade --permission-mode default
blade --permission-mode autoEdit
blade --permission-mode plan
blade --permission-mode yolo
blade --yolo  # Equivalent to --permission-mode yolo

# Specify the turn limit
blade --max-turns 50
```

## Best Practices

### 1. Protect Sensitive Files

```json
{
  "deny": [
    "Read(file_path:**/.env*)",
    "Read(file_path:**/*.pem)",
    "Read(file_path:**/*.key)",
    "Read(file_path:**/secrets/**)",
    "Read(file_path:**/.git/config)"
  ]
}
```

### 2. Restrict Dangerous Commands

```json
{
  "deny": [
    "Bash(rm -rf *)",
    "Bash(sudo *)",
    "Bash(chmod 777 *)",
    "Bash(> /dev/*)",
    "Bash(curl * | bash)",
    "Bash(wget * | bash)"
  ]
}
```

### 3. Allow by Project Type

Node.js projects:

```json
{
  "allow": [
    "Bash(npm *)",
    "Bash(pnpm *)",
    "Bash(yarn *)",
    "Bash(node *)",
    "Bash(npx *)"
  ]
}
```

Python projects:

```json
{
  "allow": [
    "Bash(python *)",
    "Bash(pip *)",
    "Bash(poetry *)",
    "Bash(pytest *)"
  ]
}
```

### 4. Use settings.local.json

Put personal trusted rules in `settings.local.json` to avoid committing them to the repository:

```json
{
  "permissionMode": "autoEdit",
  "permissions": {
    "allow": [
      "Bash(npm run build*)",
      "Bash(docker *)"
    ]
  }
}
```

## Related Resources

- [Configuration System](/en/configuration/config-system.md) - Full configuration reference
- [Plan Mode](/en/guides/plan-mode.md) - Plan mode explained
