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

`skill-creator` and `update-config` ship with Blade and work without a download. First launch, workspace initialization, and refresh discover local skills only; they do not automatically clone GitHub repositories or create a default skill directory.

Existing same-name local skills still override bundled versions according to the normal precedence rules, including skills installed as directory links. Use the Web settings Skills panel to explicitly install official, repository, or local skills. Uninstalling a user-level override restores the bundled content; removing a local link leaves its source directory intact.

The Web Installed list, refresh, enable/disable, and uninstall actions use local skills without prefetching the remote catalog. The official catalog loads only while the Install Skill dialog is open on its Catalog tab. Catalog failures stay visible with a retry action and do not block repository or local-path installation. Closing the dialog or staying on Repo or Local does not start another catalog request.

## Installation Inputs

- Installation names contain 1–64 lowercase letters, digits, or hyphens and must start and end with a letter or digit. Names inferred from a repository or local directory are validated too.
- Repository sources support `https://`, `ssh://`, and `git@host:owner/repo.git`. Embedded credentials, query parameters, fragments, local `file://` sources, and Git external protocols are rejected. Private repositories use existing Git credential helpers or SSH configuration.
- Local paths may contain spaces. The source and installation target must not be the same directory or contain one another; rejection leaves source content intact. Ordinary symlink installs and reinstalls remain supported.
- Invalid requests return HTTP 400. Network errors or missing `SKILL.md` files still produce a non-success installation response.

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

Restrictions apply to the logical turn that invokes the Skill, including multiple model requests and execution after same-turn Plan approval. Completion, failure, cancellation, or stream closure releases them, so the next ordinary task in the same session does not inherit stale restrictions. Rejected concurrent calls do not clear the running turn's restrictions. Historical Skill instructions remain in the conversation.

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
