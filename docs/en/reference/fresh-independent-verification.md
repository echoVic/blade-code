# Fresh Independent Verification

Blade enforces an independent completion gate for non-trivial implementations by the main Agent. The main Agent cannot conclude based solely on its own test results or final explanation; it must launch a new built-in `verification` subagent and obtain a structured PASS.

## Trigger Scope

Meeting any of the following conditions constitutes a non-trivial implementation:

- At least three implementation files were modified in this turn;
- Backend, API, server, auth, security, database, migration, infrastructure, or workflow paths were modified;
- Bash executed operations that cannot be proven to be read-only or verification commands.

Pure documentation, test, fixture, and snapshot changes do not count toward the three-file threshold. Restricted Agents without the Task tool, users explicitly forbidding delegation, exactly-once Task contracts, and subagents themselves do not trigger this gate.

## Fresh PASS

The gate only accepts:

1. The built-in `verification` type reserved by Blade;
2. A newly created, synchronously executed Task with `isolation="none"`;
3. Exactly one structured terminal state heading:

```text
## Verification Result: PASS
```

`FAIL` requires the main Agent to fix issues and re-verify; `PARTIAL` must not be passed off as success, and risks of any severity within it must be addressed before re-verifying. When a fresh PASS is still not obtained after reaching the bounded retry limit, the run terminates with `verification_failed`.

Any Edit, Write, ApplyPatch, NotebookEdit, or potentially writing Bash that occurs after a Verifier PASS immediately invalidates the evidence. The next completion attempt must launch a new verifier.

## Independence and Permissions

- The `verification` name is reserved by Blade; user/project/plugin/CLI configurations cannot override it;
- The runtime overrides the Task prompt, injecting the original request and actual changed files; the parent model cannot request skipping test, lint, type-check, or build that the project has already configured;
- The verifier has no write tools and cannot launch Tasks;
- Even if the parent session is YOLO, Verifier Bash only allows in-project cwd, read-only commands, and verification commands;
- Local verifier Bash runs in a workspace read-only sandbox: the source directory is not writable, the network allowlist is empty, user home and Blade storage are not readable, the process inherits only minimal environment such as PATH/locale/CI, and does not inherit provider keys or Session env;
- Background execution, custom env, out-of-bounds cwd, `--fix`, snapshot updates, pipes, command substitution, and file redirection all fail closed; trailing `2>&1` only merges stderr/stdout without writing files, so it is permitted.

## Persistence and Cross-Platform Projection

Each mutation and verifier verdict is written to durable tool metadata. Session recovery reconstructs mutation revisions in event order; when new writes exist after an old PASS, re-verification is still required.

- TUI/Headless: subagent lifecycle outputs type and `verification_verdict`;
- Web: the verification card displays PASS/FAIL/PARTIAL and recovers from `subtask_ref` after server restart;
- ACP: standard Task `tool_call_update` content includes the structured verification result.

Internal completion reminders are not displayed as end-user messages.

## Qualification Requirements

Deterministic tests cover three-file and high-risk path triggering, post-PASS write invalidation, FAIL/PARTIAL, retry exhaustion, reserved agents, YOLO read-only boundaries, durable restore, and CLI/Web/ACP projection.

Real API tests must have the main model actually modify three files, attempt to finish, be forced by the runtime to launch a new verifier, and have the independent model run project tests before returning PASS. The Production Web GUI must also verify a unique verification card, unique PASS badge, final marker, recovery after server restart, zero internal reminders, and zero application console errors.
