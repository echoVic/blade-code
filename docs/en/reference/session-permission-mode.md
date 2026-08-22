# Session Permission Mode

Blade treats permission mode as a durable security state owned by the Session itself, not merely a temporary switch existing in the current process or UI Store. Public values are:

```text
default
autoEdit
yolo
plan
```

## Restoration Priority

Each cold start, resume, fork, or runtime reconstruction uses the same priority:

1. Explicitly specified CLI/Web/ACP mode for the current invocation;
2. Last successfully persisted `permissionMode` in Session JSONL;
3. New Session default for the current entry point.

Explicit overrides must first be written to JSONL before preparing user input or starting the Agent. When persistence fails, this turn does not start and no UI in-memory state is modified. Legacy Sessions without this field use entry point defaults and backfill on first explicit selection or before execution.

## Cross-Surface Semantics

### TUI

Shift+Tab, entering Plan mode, and `--permission-mode` all take effect on the current Session. When the session selector restores historical Sessions, the status bar mode is restored synchronously; explicit CLI parameters take precedence over historical values. Forked child Sessions inherit the last committed mode of the source Session at the fork boundary.

### Web

The Session Composer selector binds to the current Session. When switching historical tasks, durable mode from catalog is used, and `session.updated` synchronizes across tabs. Clicking a new task resets to `autoEdit` rather than inheriting the just-visited `yolo` or `plan` Session.

`permissionMode` in `POST /sessions/:sessionId/message` is an explicit override. When omitted, the server uses Session metadata without falling back to browser Store or process-global configuration. Mode cannot be switched during active turns; steering continues using the mode already frozen for that turn.

### ACP

`session/load` and `session/fork` return:

```json
{
  "modes": {
    "currentModeId": "yolo"
  }
}
```

ACP uses `auto-edit` to represent Blade's `autoEdit`. `session/set_mode` persists before sending `current_mode_update`; on failure clients do not receive spurious success states. Pending inputs and goal continuations recovered after crashes use the same Session mode.

### Headless / Print

`--resume` and `--continue` restore durable mode. Explicit `--permission-mode` or `--yolo` take precedence and override Session state. Headless new Sessions still default to `yolo`; Print uses its runtime configuration default.

## Plan Mode Switching

After the Agent receives `ExitPlanMode` approval, the sequence is fixed as:

1. fsync new Session `permissionMode`;
2. Notify current surface to update mode;
3. Update in-process Store;
4. Continue execution with approved plan.

Thus even if the process crashes after approval, the next resume will not return to stale `plan` state.

## Verification

Qualification requirements simultaneously cover:

- latest-update-wins, fork inheritance, legacy fallback, and invalid values fail closed;
- explicit override precedes input preparation, zero execution on persistence failure;
- TUI/Web/ACP/headless/print cold recovery;
- Web new task returns `autoEdit` from historical YOLO Session;
- SessionStart Hooks and main Agent use the same runtime snapshot;
- Real model actually invokes write tools in resume requests not carrying mode, and no approval requests appear.
