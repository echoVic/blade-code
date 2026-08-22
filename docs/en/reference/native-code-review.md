# Native Read-Only Code Review

Blade provides Session-native independent code review that no longer splices staged diffs into the main Agent prompt. The reviewer uses an independent child session, structured finding protocol, and non-bypassable read-only execution boundary.

## Entry Points

```text
/review
/review uncommitted
/review base main
/review commit <sha>
```

`/git review` is a compatibility alias for `/review uncommitted`.

- CLI/TUI: execute `/review` directly;
- Web: fill in and execute `/review uncommitted` from the Task Home "Review" template;
- ACP: execute the same reviewer via standard slash command;
- HTTP: `POST /sessions/:sessionId/review`, request must carry exact `projectPath` and target.

## Target

| Type | Scope |
| --- | --- |
| `uncommitted` | Staged, unstaged, and untracked content in current workspace relative to `HEAD` |
| `base <ref>` | Commit changes from merge-base to current `HEAD` |
| `commit <sha>` | Changes for a single specified commit |

Before launching, the host computes a SHA-256 target digest including resolved commit identity, changed files, and exact added/deleted line ranges. Maximum 500 files, combined diff and untracked content maximum 8 MiB. When the target changes while the reviewer is running, results are marked `stale` and cannot masquerade as current workspace conclusions.

## Read-Only Security Boundary

Built-in `review` and `verification` share read-only audit authority:

1. Tool whitelist is only `Read`, `Glob`, `Grep`, `Bash`;
2. PermissionResolver only allows read-only commands and project-existing verification commands;
3. Local Bash enters `workspace-read-only` sandbox with workspace write-disabled and network closed;
4. user HOME, Blade storage, and provider credentials are forbidden from reading;
5. Git uses empty global/system config and disables optional locks, no need to read user `~/.gitconfig`;
6. Background commands, environment overrides, cross-workspace cwd, and all write tools are rejected.

Review turns do not use Plan mode. Plan mode includes the product semantic of "exit plan and execute modifications" which conflicts with read-only review; review safety is enforced by the rules above plus OS sandbox.

## Durable Lifecycle

Parent Session JSONL records:

```text
review_started
→ user /review message
→ review_completed
→ rendered assistant report
```

`review_started` is persisted before Web/TUI/ACP show running state. Results include status, overall description, and at most 50 findings. When the process exits before the reviewer completes, the next owner writes an `interrupted` terminal state without automatically replaying model calls. If the process exits between `review_completed` and the rendered message, the fresh Session directly restores the report and task terminal state from the completion event.

Web projects reviewer read-only tool progress in real-time; after receiving `review.completed`, reloads the authoritative message by exact Session identity without manual refresh. The report's structured title, target, status, findings, and confidence chrome support Chinese/English switching.

Fork does not copy live review lifecycle; completed reports are inherited as ordinary conversation history. Conversation rewind removes review events and reports after the checkpoint.

## Finding Protocol

Each finding contains:

- `title`: imperative title prefixed with `[P0]` through `[P3]`;
- `body`: triggering scenario, impact, and actionable fix direction;
- `priority`: 0-3;
- `confidenceScore`: 0-1;
- `codeLocation`: workspace-relative path and range of at most 10 lines.

The host verifies the path belongs to the target and the line range overlaps real diff changed lines. When model output cannot be parsed, is out of bounds, or references unchanged code, the entire review fails closed.

## Qualification

- Deterministic tests cover three target types, tracked/untracked digest, size budgets, stale, abort, interrupted, fork/rewind, structured hunk validation, and read-only sandbox;
- Real GPT identifies the same authorization bypass from Web route, ACP `/review`, and TUI runtime hook respectively, while proving file bytes and Git status are unchanged;
- Production DeepSeek Web GUI launches from Task Home "Review" template, fresh tab restores P0, `authorization.ts:L8`, confidence, and completed state with zero application errors in console.
