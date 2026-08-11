# Scheduled Tasks

Blade 内置持久化定时任务调度器，可在 `blade serve` 长驻进程中按 cron、interval 或
one-shot 触发自动运行 Agent Session。

## 架构

```
blade serve
  └── TaskScheduler (30s tick)
        ├── 读取 ~/.blade/schedules.json
        ├── 匹配 enabled + nextRunAt ≤ now
        └── sessionController.dispatchTask(...)
              ├── worktree / local 隔离
              ├── Session 持久化
              └── Bus 事件 → SSE schedule.fired
```

## 触发模式

| 模式 | 说明 | 示例 |
|------|------|------|
| cron | 标准 5 段 `min hour dom mon dow`；支持 `*`、范围、列表、step、DOW 0/7=Sunday | `0 9 * * 1-5` |
| interval | 最小 1 分钟，格式 `Nm/Nh/Nd` | `30m`、`2h`、`1d` |
| once | ISO 时间点，必须是未来时间；执行后自动停用 | `2026-08-12T09:00:00Z` |

- **时区**：cron 支持显式 IANA timezone（如 `Asia/Shanghai`），创建时默认当前系统时区
- **Misfire**：离线错过的 slot 只补跑一次
- **Overlap**：同一 schedule 不允许并行 dispatch

## CLI 命令

```bash
# 创建
blade schedule create "run daily tests" --cron "0 9 * * 1-5" --project-path /my/repo
blade schedule create "hourly sync" --every 1h --model deepseek/v4-flash
blade schedule create "one-time report" --at 2026-08-12T09:00:00Z

# 管理
blade schedule list
blade schedule show <id>
blade schedule enable <id>
blade schedule disable <id>
blade schedule remove <id>

# 手动触发（通过运行中的 blade serve）
blade schedule run <id> --server http://127.0.0.1:4097
```

## Web 管理

Settings → Integrations → Scheduled Tasks

- 创建：选择 cron/interval/once，填写 prompt、项目路径、模型、权限模式、隔离方式
- 列表：显示触发描述、启停状态、下次运行、最后运行、最后状态、运行次数
- 操作：启用/停用、手动运行、编辑 prompt、二次确认删除

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

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/schedules` | 列出所有 schedule |
| POST | `/schedules` | 创建 schedule |
| GET | `/schedules/:id` | 获取单个 schedule |
| PATCH | `/schedules/:id` | 更新 prompt/trigger/enabled |
| DELETE | `/schedules/:id` | 删除 schedule |
| POST | `/schedules/:id/enable` | 启用 |
| POST | `/schedules/:id/disable` | 停用 |
| POST | `/schedules/:id/run` | 手动运行 |

SSE 事件：`schedule.fired`（包含 scheduleId、firedAt、sessionId、projectPath、status）

## 持久化

- 文件路径：`~/.blade/schedules.json`（受 `BLADE_STORAGE_ROOT` 覆盖）
- 写入方式：`write-file-atomic`，权限 `0600`
- 并发安全：同进程串行写链，防止覆盖

## Dispatch 选项

| 字段 | 默认值 | 说明 |
|------|--------|------|
| modelId | 当前配置默认模型 | 运行时使用的模型 |
| permissionMode | `default` | `default` / `autoEdit` / `yolo` / `plan` |
| isolation | `worktree` | `worktree` / `local` |
| reasoningEffort | - | 模型推理力度 |
| serviceTier | - | provider 服务层级 |
