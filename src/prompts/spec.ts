/**
 * Spec-Driven Development Mode System Prompt
 */

import type { SpecMetadata, SpecPhase } from '../spec/types.js';
import { PHASE_DISPLAY_NAMES } from '../spec/types.js';

/**
 * Spec Mode Base System Prompt
 *
 * Conversation-driven workflow - users don't need to memorize commands
 */
const SPEC_MODE_BASE_PROMPT = `
# Spec-Driven Development Mode

You are in **Spec Mode** - a structured development workflow that creates implementation plans based on the **current project's codebase**.

## ⚠️ CRITICAL: Explore Before Planning

**BEFORE writing any spec document, you MUST:**
1. Use **Glob** to find relevant files in the project
2. Use **Grep** to search for related code patterns
3. Use **Read** to understand existing implementations
4. Identify existing patterns, conventions, and architecture

**Your plans MUST be grounded in the actual codebase.** Never create generic plans that ignore existing code structure.

## Workflow Overview

\`\`\`
[Explore Codebase] → Proposal → Requirements → Design → Tasks → [User Confirms] → Implementation → Done
\`\`\`

## Entry Behavior

### No Active Spec
1. Ask what the user wants to build
2. After user responds, **explore the codebase first**
3. Then create the Spec with EnterSpecMode

### Has Active Spec
Show current progress and suggest next steps based on actual project state.

## Available Tools

| Tool | Purpose |
|------|---------|
| Glob, Grep, Read | **Explore codebase** (use BEFORE planning) |
| EnterSpecMode | Create new Spec |
| UpdateSpec | Update documents (proposal/requirements/design/tasks) |
| GetSpecContext | Get current context and progress |
| TransitionSpecPhase | Phase transition |
| AddTask | Add task to the task list |
| UpdateTaskStatus | Update task status |
| ValidateSpec | Validate completeness |
| ExitSpecMode | Exit/archive |
| Edit, Write, Bash | Implement code changes |

## Key Principles

1. **Codebase-first** - Always explore existing code before planning
2. **Project-aware** - Plans must reference actual files and patterns
3. **User confirmation** - Wait for user approval before implementation
4. **Proactive guidance** - Guide users through the workflow
5. **State transparency** - Always show current phase and progress
`;

function getPhasePrompt(phase: SpecPhase): string {
  switch (phase) {
    case 'init':
      return `
## Current Phase: Init (Proposal)

**FIRST: Explore the codebase to understand context:**
1. Use Glob to find files related to this feature area
2. Use Grep to search for relevant patterns
3. Use Read to examine key files

**THEN: Write the proposal with project-specific details:**
1. Document background and motivation
2. Reference existing code that will be affected
3. Identify risks based on actual architecture
4. List affected files and components

When complete, use TransitionSpecPhase("requirements").
`;

    case 'requirements':
      return `
## Current Phase: Requirements

**Based on your codebase exploration, define requirements that fit the existing architecture.**

1. **Functional requirements** - What the system must do
2. **Non-functional requirements** - Performance, security constraints
3. **Integration points** - How it connects with existing code

Use EARS format:
- "The system shall [action]"
- "When [trigger], the system shall [action]"

**Requirements should reference actual project components discovered during exploration.**

When complete, use TransitionSpecPhase("design").
`;

    case 'design':
      return `
## Current Phase: Design

**Design must align with existing project architecture and patterns.**

Include:
1. **Component diagram** - Show how new code integrates with existing modules
2. **Data flow** - How data moves through existing systems
3. **API contracts** - Following existing API patterns in the project
4. **File structure** - Where new files will be created (based on project conventions)

**Reference actual files and patterns from codebase exploration.**

When complete, use TransitionSpecPhase("tasks").
`;

    case 'tasks':
      return `
## Current Phase: Tasks

**Break down the work into concrete tasks with REAL file paths from the project.**

## Step 1: Add Tasks with AddTask Tool

For each task, call AddTask with:
- **title**: Short task name
- **description**: What to do (reference actual files)
- **complexity**: low/medium/high
- **affectedFiles**: REAL file paths from codebase exploration

Example:
\`\`\`
AddTask({
  title: "Add theme types",
  description: "Create Theme interface in src/config/types.ts based on existing type patterns",
  complexity: "low",
  affectedFiles: ["src/config/types.ts"]
})
\`\`\`

## Step 2: Present Plan for User Confirmation

After adding all tasks, show:
1. **Summary** of proposal, requirements, design
2. **Task list** with complexity and affected files
3. **Total files affected**

Then ask: **"请确认以上规划，确认后我将开始执行任务。"**

## Step 3: Wait for User Approval

- User says "ok", "确认", "继续" → TransitionSpecPhase("implementation")
- User has concerns → Adjust the plan

## ⚠️ CRITICAL

- **Call AddTask tool** for each task (not just describe in text)
- **affectedFiles must be REAL paths** from codebase exploration
- **WAIT for user confirmation** before implementation
- **Do NOT auto-start** implementation without approval
`;

    case 'implementation':
      return `
## Current Phase: Implementation

You are in the implementation phase. Your goal is to:

1. **Execute tasks in order**: Respect dependencies
2. **Update task status**: Mark tasks as in_progress → completed
3. **Use standard tools**: Edit, Write, Bash for code changes
4. **Verify each task**: Test before marking complete

Use GetSpecContext to see the current task and progress.

When all tasks are complete, use ExitSpecMode with archive: true to finish.
`;

    case 'done':
      return `
## Phase: Done

The spec is complete. Use ExitSpecMode if you haven't already.
`;

    default:
      return '';
  }
}

/**
 * Build complete Spec mode system prompt
 */
export function buildSpecModePrompt(
  currentSpec: SpecMetadata | null,
  steeringContext: string | null
): string {
  const parts: string[] = [SPEC_MODE_BASE_PROMPT];

  // Add current Spec context
  if (currentSpec) {
    parts.push(`
---

## Current Spec: ${currentSpec.name}

**Description**: ${currentSpec.description}
**Phase**: ${PHASE_DISPLAY_NAMES[currentSpec.phase]} (${currentSpec.phase})
**Created**: ${new Date(currentSpec.createdAt).toLocaleString()}
**Updated**: ${new Date(currentSpec.updatedAt).toLocaleString()}
`);

    // Task progress
    if (currentSpec.tasks.length > 0) {
      const completed = currentSpec.tasks.filter(
        (t) => t.status === 'completed'
      ).length;
      const total = currentSpec.tasks.length;
      parts.push(
        `**Tasks**: ${completed}/${total} completed (${Math.round((completed / total) * 100)}%)`
      );

      // Current task
      if (currentSpec.currentTaskId) {
        const currentTask = currentSpec.tasks.find(
          (t) => t.id === currentSpec.currentTaskId
        );
        if (currentTask) {
          parts.push(`**Current Task**: ${currentTask.title}`);
        }
      }
    }

    // Phase-specific prompt
    parts.push(getPhasePrompt(currentSpec.phase));
  }

  // Add Steering Context
  if (steeringContext) {
    parts.push(`
---

## Steering Documents

The following project governance documents are available:

${steeringContext}
`);
  }

  return parts.join('\n');
}

/**
 * Spec mode reminder (added to user messages)
 */
export function createSpecModeReminder(phase: SpecPhase): string {
  const phaseDisplay = PHASE_DISPLAY_NAMES[phase];

  return `<spec-mode-reminder>
You are in Spec Mode (${phaseDisplay} phase).
- Use Spec tools: UpdateSpec, GetSpecContext, TransitionSpecPhase, ValidateSpec
- Follow the workflow: Requirements → Design → Tasks → Implementation
- Update spec files as you work
</spec-mode-reminder>`;
}
