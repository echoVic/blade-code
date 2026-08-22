# 📋 Plan Mode

Plan mode is a read-only permission mode used during the research and planning phase. The AI can only use read-only tools and cannot perform any modifying operations.

## Overview

In Plan mode:

- ✅ **Allowed**: read-only tools such as Read, Glob, Grep, WebFetch, WebSearch, TaskCreate/TaskGet/TaskUpdate/TaskList
- ❌ **Denied**: modifying tools such as Write, Edit, Bash
- 🔵 **Special**: the ExitPlanMode tool for submitting a plan

## How to Start

### CLI Argument

```bash
blade --permission-mode plan
blade -P  # Shorthand
```

### Runtime Switching

In the interactive interface, press `Shift+Tab` to cycle through permission modes until it shows `Plan`.

## Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                      Plan Mode Workflow                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   1. Enter Plan mode                                        │
│      blade --permission-mode plan                           │
│                         ↓                                   │
│   2. Describe the requirement                               │
│      "Help me design a user authentication system"          │
│                         ↓                                   │
│   3. AI researches and plans                                │
│      - Use Read to analyze existing code                    │
│      - Use Grep to search related implementations           │
│      - Use WebSearch to query best practices                │
│                         ↓                                   │
│   4. AI generates an implementation plan                    │
│      - Technology selection                                 │
│      - Architecture design                                  │
│      - Implementation steps                                 │
│                         ↓                                   │
│   5. User reviews the plan                                  │
│      - Confirm the plan's feasibility                       │
│      - Suggest changes                                      │
│                         ↓                                   │
│   6. Exit Plan mode                                         │
│      AI calls the ExitPlanMode tool                         │
│      After user confirmation, switch to Default mode to implement │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Usage Examples

### Requirement Analysis

```bash
blade --permission-mode plan

# Example conversation:
User: Help me analyze this project's architecture and propose refactoring suggestions

AI: Let me first analyze the project structure...
    [uses Glob to list files]
    [uses Read to read key files]
    [uses Grep to search dependencies]
    
    Based on the analysis, I suggest the following refactoring plan:
    1. Split utils into independent modules
    2. Introduce dependency injection
    3. Add unit tests
    
    If you agree with this plan, I can exit Plan mode and start implementing.
```

### Technology Selection

```bash
blade --permission-mode plan

User: I need to add state management to the project; help me compare a few options

AI: Let me analyze the project requirements and compare options...
    [uses Read to analyze the project structure]
    [uses WebSearch to query the latest options]
    
    Based on the project's characteristics, I recommend the following:
    
    | Option | Pros | Cons | Recommendation |
    |------|------|------|--------|
    | Zustand | Lightweight, simple | Smaller ecosystem | ⭐⭐⭐⭐⭐ |
    | Redux Toolkit | Mature, great ecosystem | More boilerplate | ⭐⭐⭐⭐ |
    | Jotai | Atomic, flexible | Learning curve | ⭐⭐⭐ |
    
    I recommend using Zustand, because...
```

## The ExitPlanMode Tool

When the AI finishes planning, it calls the ExitPlanMode tool to submit the plan:

```json
{
  "name": "ExitPlanMode",
  "arguments": {
    "title": "User Authentication System Implementation Plan",
    "plan": "## Technology Selection\n- JWT + bcrypt\n\n## Implementation Steps\n1. Create the User model\n2. Implement the registration endpoint\n3. Implement the login endpoint\n..."
  }
}
```

ExitPlanMode is validated by the runtime according to the current permission mode. It is only allowed to exit while in Plan mode; calling it in Default, Auto Edit, or Yolo mode returns a `validation_error`, does not re-prompt for confirmation, and does not interrupt an already-approved implementation flow.

After the user confirms:

1. The plan is saved to the `.blade/plans/` directory
2. The permission mode switches to Default
3. The AI can begin implementation

## Plan Files

Plans are saved as Markdown files:

```
.blade/plans/
  └─ User Authentication System Implementation Plan.md
```

File content:

```markdown
# User Authentication System Implementation Plan

## Technology Selection
- JWT + bcrypt

## Implementation Steps
1. Create the User model
2. Implement the registration endpoint
3. Implement the login endpoint
...
```

## Best Practices

### 1. Be Clear About Requirements

```
Help me design a user authentication system that needs to support:
- Email registration/login
- OAuth third-party login
- Password reset
- Session management
```

### 2. Provide Context

```
Based on the existing config in @package.json and @src/config.ts,
help me plan how to add database support
```

### 3. Iterate

```
This plan is good, but I'd like to:
1. Use Prisma instead of TypeORM
2. Add Rate Limiting
Please update the plan
```

### 4. Confirm Before Implementing

When the AI calls ExitPlanMode, review the plan carefully:

- Is the technology selection reasonable
- Are the implementation steps complete
- Have edge cases been considered

## Related Resources

- [Permission Control](/en/configuration/permissions.md) - Permission modes explained
- [Subagents](/en/guides/subagents.md) - The Plan subagent
