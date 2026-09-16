Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

## When to Use This Tool

Use this tool proactively in these scenarios:
- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests a task list
- User provides multiple tasks
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress with TaskUpdate BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

## Task Fields

- subject: A brief, actionable title in imperative form (for example, "Run tests")
- description: What needs to be done
- activeForm: Present continuous form shown while in_progress (for example, "Running tests")

All tasks are created with status pending. Check TaskList first to avoid creating duplicates.