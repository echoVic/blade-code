# ⚡ Skills System

Skills are Blade's dynamic prompt extension mechanism, allowing the AI to automatically invoke specialized capabilities based on user requests.

## Overview

Skills use a simple filesystem-based architecture:

- Each Skill is a directory containing a `SKILL.md` file
- Metadata is defined via YAML frontmatter
- The body serves as the Skill's instruction content
- It can optionally include resources such as scripts and templates

## Directory Structure

```
~/.blade/skills/           # User-level Skills
  └─ my-skill/
      ├─ SKILL.md          # Skill definition (required)
      ├─ scripts/          # Optional scripts
      └─ templates/        # Optional templates

<project>/.blade/skills/   # Project-level Skills (higher priority)
  └─ project-skill/
      └─ SKILL.md
```

## SKILL.md Format

```markdown
---
name: code-review
description: Perform a professional review of code, finding potential issues and improvement suggestions. Use when the user requests a code review.
version: 1.0.0
allowedTools:
  - Read
  - Grep
  - Glob
argumentHint: <file_path>
userInvocable: true
---

# Code Review Skill

You are a professional code review expert.

## Review Process

1. First use the Read tool to read the target file
2. Analyze the code structure and logic
3. Identify potential issues and improvement points
4. Give specific modification suggestions

## Review Focus

- Code quality and readability
- Potential bugs and boundary conditions
- Security risks
- Performance issues
- Adherence to best practices

## Output Format

Please output the review results in the following format:

### Issue List

| Severity | Location | Issue | Suggestion |
|----------|------|------|------|
| High/Medium/Low | line | Description | Fix plan |

### Summary

Briefly summarize the code quality and the main improvement suggestions.
```

## Metadata Fields

| Field | Type | Required | Description |
|------|------|------|------|
| `name` | string | ✅ | Unique identifier, lowercase + digits + hyphens, ≤64 characters |
| `description` | string | ✅ | Activation description, ≤1024 characters, including "what" and "when to use" |
| `version` | string | - | Version number |
| `allowedTools` | string[] | - | Tool access restriction, e.g., `['Read', 'Grep']` |
| `argumentHint` | string | - | Argument hint, e.g., `<file_path>` |
| `userInvocable` | boolean | - | Whether the user can invoke it via command (default false) |
| `disableModelInvocation` | boolean | - | Whether to prohibit automatic AI invocation (default false) |
| `model` | string | - | Specify the execution model |
| `whenToUse` | string | - | Additional trigger condition description |

## Usage

### Automatic AI Invocation

When the AI recognizes that a user request matches a Skill, it invokes it automatically:

```
User: Help me review the code in src/agent/Agent.ts

AI: [recognized the code-review skill, invoking automatically]
    Performing a code review using the code-review skill...
```

### Manual User Invocation

If the Skill has `userInvocable: true`, you can invoke it via the Skill tool:

```
User: Use the code-review skill to review src/utils/git.ts
```

### Management Commands

```bash
/skills         # List all available Skills
/skills list    # List all Skills
/skills info <name>  # View Skill details
```

## Built-in Skills

Blade may include some built-in Skills, which are automatically downloaded to `~/.blade/skills/` on first launch.

## Example Skills

### Base64 Encode/Decode

```markdown
---
name: base64-parser
description: Encode or decode Base64 strings. Use when the user needs to work with Base64 data.
allowedTools:
  - Bash
argumentHint: <encode|decode> <text>
userInvocable: true
---

# Base64 Parser

Perform Base64 encoding or decoding based on the user's request.

## Usage

- Encode: `encode <text>`
- Decode: `decode <base64_string>`

## Implementation

Use the Bash tool to run the base64 command:

- Encode: `echo -n "text" | base64`
- Decode: `echo "base64_string" | base64 -d`
```

### Git Commit Helper

```markdown
---
name: git-commit-helper
description: Analyze code changes and generate a well-formed commit message. Use when the user needs to commit code.
allowedTools:
  - Bash
  - Read
userInvocable: true
---

# Git Commit Helper

Analyze the staged changes and generate a commit message that follows the Conventional Commits specification.

## Process

1. Run `git diff --staged` to get the changes
2. Analyze the type of change (feat/fix/docs/refactor, etc.)
3. Generate a concise, accurate commit message
4. Optional: run git commit automatically

## Output Format

```
<type>(<scope>): <subject>

<body>
```
```

## Tool Restrictions

Use `allowedTools` to restrict which tools are available during Skill execution:

```yaml
allowedTools:
  - Read
  - Grep
  - Glob
  - Bash(git:*)  # Only allow git-related commands
```

## Differences from Subagents

| Feature | Skills | Subagents |
|------|--------|-----------|
| Purpose | Prompt extension for a specific task | An independent subagent that executes a task |
| Execution | Runs within the current session | Creates a new Agent instance |
| State | Shares the current session state | Stateless, independent context |
| Tool restriction | Can restrict available tools | Can restrict available tools |
| Use case | Simple specialized tasks | Complex multi-step tasks |

## Related Resources

- [Subagents](/en/guides/subagents.md) - Subagent system
- [Tool List](/en/reference/tool-list.md) - The Skill tool
- [Permission Control](/en/configuration/permissions.md) - Tool permissions
