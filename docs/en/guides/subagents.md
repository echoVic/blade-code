# 🤖 Subagents System

A subagent is a customizable sub-agent used to perform a specific type of task. The Task tool selects the appropriate subagent to execute a subtask based on configuration.

## Built-in Subagents

Blade ships with 4 core subagents:

| Name | Purpose | Available Tools |
|------|------|----------|
| `general-purpose` | General-purpose task agent for researching complex problems and multi-step tasks | All tools |
| `Explore` | Code exploration expert that quickly searches and analyzes the codebase | Glob, Grep, Read, WebFetch, WebSearch |
| `Plan` | Software architect that designs implementation plans and architecture proposals | All tools |
| `statusline-setup` | Status line configuration expert | Read, Edit |

### general-purpose

General-purpose task agent for researching complex problems, searching code, and multi-step tasks:

```
When you search for a keyword or file and are unsure whether you'll find the right match
in the first few attempts, use this agent to perform the search.
```

### Explore

Code exploration expert that quickly searches and analyzes the codebase:

```
Quickly find file patterns (e.g., "src/components/**/*.tsx")
Search code keywords (e.g., "API endpoints")
Answer questions about the codebase (e.g., "How do the API endpoints work?")

Supports three levels of detail:
- quick: basic search
- medium: moderate exploration
- very thorough: comprehensive analysis
```

### Plan

Software architect that designs implementation plans:

```
Analyze requirements
Explore the codebase to understand existing patterns
Design a step-by-step implementation plan
Identify key files and dependencies
Consider architectural trade-offs
```

## Custom Subagents

### Configuration Location

```
~/.blade/agents/*.md        # User-level (global)
<project>/.blade/agents/*.md  # Project-level (higher priority)
```

### Configuration Format

Create a `.md` file and use YAML frontmatter to define metadata:

```markdown
---
name: code-reviewer
description: Review code for bugs and risks. Use this when you need critical feedback.
tools:
  - Read
  - Grep
  - Glob
color: blue
---

# Code Reviewer

You are a code review expert focused on finding problems and risks in code.

## Review Focus

1. **Code quality** - readability, maintainability, naming conventions
2. **Potential bugs** - boundary conditions, null handling, type safety
3. **Security risks** - injection attacks, sensitive information leakage
4. **Performance issues** - algorithmic complexity, memory leaks

## Output Format

Please output the review results in the following format:

### Issue List

| Severity | Location | Issue Description | Suggestion |
|----------|------|----------|------|
| High/Medium/Low | file:line | Issue description | Fix suggestion |

### Summary

Briefly summarize the code quality and the main improvement suggestions.
```

### Metadata Fields

| Field | Type | Description |
|------|------|------|
| `name` | string | Unique identifier (kebab-case) |
| `description` | string | Brief purpose; recommended to include "Use this when …" |
| `tools` | string[] | List of allowed tools; leave empty for no restriction |
| `color` | string | UI marker color (optional) |

### One-off Run Definitions

Use `--agents <json>` to inject one or more Subagents for the current process without creating config files. It works for the desktop TUI, print, and headless modes alike, and the definitions are not persisted:

```bash
blade --agents '{
  "code-reviewer": {
    "description": "Review code changes and run focused checks",
    "prompt": "Find correctness risks, inspect the diff, and run tests.",
    "tools": ["Read", "Grep", "Bash"],
    "disallowedTools": ["Write"],
    "model": "deepseek-v4-pro",
    "permissionMode": "dontAsk",
    "maxTurns": 8,
    "isolation": "worktree"
  }
}'
```

Supported fields:

| Field | Required | Description |
|------|------|------|
| `description` | Yes | Purpose description provided to the main agent |
| `prompt` | Yes | Subagent system prompt |
| `tools` | No | Tool allowlist |
| `disallowedTools` | No | Tool denylist, takes precedence over the allowlist |
| `model` | No | Model used by the subagent |
| `permissionMode` | No | `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`, or `ignore`; inherits the main session when omitted |
| `maxTurns` | No | Positive integer, max 100 |
| `isolation` | No | `none` or `worktree` |

One-off run definitions take priority over built-in, user-level, and project-level definitions of the same name. Parsing is strict: unknown fields, illegal agent names, empty prompts, and wrong types all abort startup before the Agent runtime is initialized.

### Available Colors

`red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`

## Usage

### In Conversation

Simply state your request in the conversation, and the AI will automatically choose the appropriate subagent:

```
Please help me review the code in src/agent/Agent.ts
```

Or explicitly specify a subagent:

```
Use the code-reviewer agent to review this code
```

### Via the Task Tool

The AI invokes subagents through the Task tool:

```json
{
  "name": "Task",
  "arguments": {
    "subagent_type": "code-reviewer",
    "description": "Review error handling",
    "prompt": "Review the error handling logic in src/agent/Agent.ts"
  }
}
```

### Durable Resume

Both foreground and background Tasks generate a durable agent ID. The
`resume_from_hint` in the completion result can be used for follow-up work:

```json
{
  "name": "Task",
  "arguments": {
    "description": "Continue the error handling review",
    "prompt": "Check whether the findings from last round are fixed, and run the relevant tests.",
    "resume_from": "agent-source-id"
  }
}
```

Each resume creates a new immutable child run and does not overwrite the source sidecar. Blade persists
`rootAgentId`, `resumedFrom`, and `resumeDepth`, so the root → child → grandchild
chain can continue after a process restart. When resuming:

- `subagent_type` may be omitted; if provided, it must match the source run;
- the model, permissions, tool allowlist/denylist, system prompt, max turns, and isolation use the source snapshot,
  unaffected by later config file changes;
- it can only be read or resumed by a Runtime with the same `parent sessionId + projectPath`;
- the source must already have finished, and the parent session must be idle with no durable pending input;
- worktree resume reuses the original lease, and the new child ID does not change the worktree owner;
- `resume` still works as a compatibility alias, but new calls should use `resume_from`.

Users can also run the same protocol via `/tasks resume <agentId> <prompt>` in the TUI/ACP or the **Resume** action on the Web subagent
card. After a Web refresh, Blade finds the latest descendant from persistent lineage and does not create a sibling from an old ancestor.

## Agent Teams

An Agent Team is Blade's team collaboration layer built on top of Subagents, implemented with reference to Claude Code's TeamCreate workflow. It creates a persistent team configuration and launches multiple teammates as background subagents in parallel.

Team configuration is stored at:

```
~/.blade/teams/<team-name>/config.json
```

### TeamCreate

When the user explicitly needs "a team / swarm / multiple agents collaborating," or the task is well suited to parallel splitting, the AI can call `TeamCreate`:

```json
{
  "name": "TeamCreate",
  "arguments": {
    "team_name": "checkout-refactor",
    "description": "Analyze and plan the checkout refactor in parallel",
    "members": [
      {
        "name": "researcher",
        "subagent_type": "Explore",
        "description": "Map out the checkout flow",
        "prompt": "Find the checkout entry points, state transitions, and risk points."
      },
      {
        "name": "planner",
        "subagent_type": "Plan",
        "description": "Draft an implementation plan",
        "prompt": "Draft a checkout refactor plan based on the existing architecture."
      }
    ]
  }
}
```

Each member launches as a background agent and shares a task list scoped to the team name. Use `TeamStatus` to view team status, and `TaskOutput` to read a specific member's result.

### TeamStatus / TeamDelete

```json
{ "name": "TeamStatus", "arguments": { "team_name": "checkout-refactor" } }
{ "name": "TeamDelete", "arguments": { "team_name": "checkout-refactor" } }
```

`TeamDelete` cancels any still-running teammate agents by default.

### Management Commands

```bash
/agents         # Open the agent manager
/agents list    # List all agents
/agents create  # Create a new agent (wizard)
/agents help    # Show help
```

## Example Configurations

### Test Expert

```markdown
---
name: test-expert
description: Write and improve tests. Use this when you need to add or fix tests.
tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash
color: green
---

# Test Expert

You are a testing expert focused on writing high-quality test code.

## Responsibilities

1. Analyze existing code and identify scenarios that need tests
2. Write unit tests and integration tests
3. Ensure tests cover boundary conditions
4. Follow the project's testing conventions and framework

## Testing Principles

- Each test tests only one functional point
- Test names should clearly describe what is being tested
- Use the AAA pattern (Arrange-Act-Assert)
- Avoid testing implementation details
```

### Documentation Expert

```markdown
---
name: doc-writer
description: Write and improve documentation. Use this when you need to document code or features.
tools:
  - Read
  - Grep
  - Glob
  - Write
color: purple
---

# Documentation Expert

You are a technical documentation expert focused on writing clear, accurate documentation.

## Documentation Types

1. **API docs** - function signatures, parameter descriptions, return values
2. **Usage guides** - quick start, common usage
3. **Architecture docs** - system design, module relationships
4. **Comments** - in-code comments, JSDoc

## Writing Principles

- Concise and clear, avoid redundancy
- Provide practical, usable examples
- Keep in sync with the code
```

## Notes

1. **Stateless** - Each invocation uses a fresh context
2. **Permission inheritance** - Inherits the main session's permission mode by default; one-off run definitions can explicitly override it, and tools are still constrained by the allowlist and denylist
3. **Reloading** - After modifying config, restart Blade or re-enter the UI

## Related Resources

- [Slash Commands](/en/guides/slash-commands.md) - The `/agents` command
- [Tool List](/en/reference/tool-list.md) - The Task tool
- [Permission Control](/en/configuration/permissions.md) - Permission modes
