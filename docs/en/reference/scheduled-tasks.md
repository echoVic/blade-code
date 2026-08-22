# Scheduled Tasks

Blade includes a persistent scheduled task scheduler that can automatically run Agent Sessions triggered by cron, interval, or one-shot in long-running `blade serve` processes.

## Architecture

```
blade serve
  └── TaskScheduler (30s tick)
        ├── reads ~/.blade/schedules.json
        ├── matches enabled + nextRunAt ≤ now
        └── sessionController.dispatchTask(...)
              ├── worktree / local isolation
              ├── Session persistence
              └── Bus events → SSE schedule.fired
```

## Trigger Modes

| Mode | Description | Example |
|------|-------------|---------|
| cron | Standard 5-field `min hour dom mon dow`; supports `*`, ranges, lists, steps, DOW 0/7=Sunday | `0 9 * * 1-5` |
| interval | Minimum 1 minute, format `Nm/Nh/Nd` | `30m`, `2h`, `1d` |
| once | ISO timestamp, must be in the future; automatically disabled after execution | `2026-08-12T09:00:00Z` |

- **Timezone**: cron supports explicit IANA timezones (e.g., `Asia/Shanghai`), defaults to the current system timezone at creation
- **Misfire**: Offline-missed slots catch up at most once
- **Overlap**: Parallel dispatch is not allowed for the same schedule

## CLI Commands

```bash
# Create
blade schedule create "run daily tests" --cron "0 9 * * 1-5" --project-path /my/repo
blade schedule create "hourly sync" --every 1h --model deepseek/v4-flash
blade schedule create "one-time report" --at 2026-08-12T09:00:00Z

# Manage
blade schedule list
blade schedule show <id>
blade schedule enable <id>
blade schedule disable <id>
blade schedule remove <id>

# Manual trigger (via running blade serve)
blade schedule run <id> --server http://127.0.0.1:4097
```

## Web Management

Settings → Integrations → Scheduled Tasks

- Create: select cron/interval/once, fill in prompt, project path, model, permission mode, isolation method
- List: displays trigger description, enable/disable status, next run, last run, last status, run count
- Actions: enable/disable, manual run, edit prompt, delete with confirmation

## ACP Slash Command

```
/schedule list
/schedule create every 1h run tests
/schedule create cron 0 9 * * 1-5 -- summarize PRs
/schedule create at 2026-08-12T09:00:00Z report
/schedule remove <id>
/schedule enable <id>
/schedule disable <id>
/schedule run <id>
```

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/schedules` | List all schedules |
| POST | `/schedules` | Create schedule |
| GET | `/schedules/:id` | Get single schedule |
| PATCH | `/schedules/:id` | Update prompt/trigger/enabled |
| DELETE | `/schedules/:id` | Delete schedule |
| POST | `/schedules/:id/enable` | Enable |
| POST | `/schedules/:id/disable` | Disable |
| POST | `/schedules/:id/run` | Manual run |

SSE event: `schedule.fired` (includes scheduleId, firedAt, sessionId, projectPath, status)

## Persistence

- File path: `~/.blade/schedules.json` (overridden by `BLADE_STORAGE_ROOT`)
- Write method: `write-file-atomic`, permissions `0600`
- Concurrency safety: same-process serial write chain to prevent overwrites

## Dispatch Options

| Field | Default | Description |
|-------|---------|-------------|
| modelId | Current configured default model | Model used at runtime |
| permissionMode | `default` | `default` / `autoEdit` / `yolo` / `plan` |
| isolation | `worktree` | `worktree` / `local` |
| reasoningEffort | - | Model reasoning effort |
| serviceTier | - | Provider service tier |
