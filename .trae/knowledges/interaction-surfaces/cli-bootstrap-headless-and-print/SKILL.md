---
name: knowledge-interaction-surfaces-cli-bootstrap-headless-and-print
description: >
  覆盖 Blade CLI 启动分流、yargs 参数覆盖、Headless/Print 模式、stdin、Session
  resume/fork、稳定 JSONL 输出与进程信号语义。进入时机：新增 CLI 选项或子命令、修改
  非交互执行、结构化输出、管道输入、退出码或 Headless 事件。 不包含：Ink 交互细节
  （见 ../terminal-ui/）、Hono 服务生命周期（见 ../hono-server-api-and-streaming/）。
  关键词：main, globalOptions, runHeadless, runPrint, HeadlessJsonlEvent,
  HeadlessOutputEgress, resolveNonInteractiveSession, --resume, --task-isolation。
---

## Module Structure

CLI 层先建立进程级 cwd、日志和可信资源覆盖，再按参数选择专用运行器；Headless 与 Print
都直接拥有 SessionRuntime，但面向不同的机器消费与一次性文本消费场景。

### Directory Layout
- `packages/cli/src/blade.tsx` — 进程预解析、工作区初始化、模式分流和默认 Ink 启动
- `packages/cli/src/cli/` — 全局选项、设置文件校验、运行时配置合并和中间件
- `packages/cli/src/commands/headless.ts` — 完整 Agent loop 的非交互运行器
- `packages/cli/src/commands/headlessEvents.ts` — 版本化 snake_case JSONL wire schema
- `packages/cli/src/commands/HeadlessOutputEgress.ts` — stdout/stderr 有界串行写入
- `packages/cli/src/commands/print.ts` — 单一最终响应运行器
- `packages/cli/src/commands/shared/` — 输入规范化、输出 schema 和非交互 Session 解析
- `packages/cli/src/commands/` — Serve、Web、Browser、Doctor、MCP、Projects、Schedule 等管理命令

### Key Entry Points
- `main()` in `packages/cli/src/blade.tsx` — 选择 Headless、Print、ACP、yargs 子命令或 TUI
- `loadConfiguration()` in `packages/cli/src/cli/middleware.ts` — 合并 settings、CLI 和持久配置
- `runHeadless()` in `packages/cli/src/commands/headless.ts` — 执行完整事件化 Agent loop
- `runPrint()` in `packages/cli/src/commands/print.ts` — 聚合一次最终响应并退出
- `resolveNonInteractiveSession()` in `packages/cli/src/commands/shared/sessionContext.ts` — 统一 resume、continue 与 fork

## Gotchas
- `--debug` 必须在导入 yargs 和创建其他 logger 前从原始 argv 预解析，否则早期模块日志不会继承过滤设置 (`packages/cli/src/blade.tsx`)
- 工作区根与命令调用目录不是同一概念：项目探测会更新全局 cwd，但 `--plugin-dir` 和 `--settings` 的相对路径仍按原始 invocation cwd 解析 (`packages/cli/src/blade.tsx`, `packages/cli/src/cli/settings.ts`)
- `--headless` 在全局 `GracefulShutdown` 初始化前分流并独占 SIGINT/SIGTERM；把它移到普通 yargs 路径会让活动 turn 来不及 settle 就退出 (`packages/cli/src/blade.tsx`, `packages/cli/src/commands/headless.ts`, `git:3d7ec137`)
- Headless 新 Session 默认 `yolo`，Print 则回退到 Runtime 配置的权限模式；resume 时两者都优先采用显式参数，再采用 Session 持久模式 (`packages/cli/src/commands/headless.ts`, `packages/cli/src/commands/print.ts`)
- 无参数 `--resume` 只在 TUI 中打开选择器，Print/Headless 必须获得具体 Session ID；`--session-id` 与 resume/continue 同用时还必须显式 fork (`packages/cli/src/cli/middleware.ts`, `packages/cli/src/commands/shared/sessionContext.ts`)
- Headless 的 `jsonl` 是版本化、snake_case 且经 TypeBox 定义的外部契约，不应直接序列化内部 camelCase `LoopEvent` (`packages/cli/src/commands/headlessEvents.ts`)
- Print 的 `stream-json` 名称不表示逐 delta 输出；实现会先 `drainLoop()`，最后只写一个 response 或 structured_output 对象 (`packages/cli/src/commands/print.ts`)
- `! <command>` 不能与 output schema 组合，Headless 中还不能与 `--task-isolation` 组合；这些路径跳过模型并使用 Shell 自己的退出码 (`packages/cli/src/commands/headless.ts`, `packages/cli/src/commands/print.ts`)
- Headless 的 stdout 与 stderr 是两个独立容量队列；任一 writer 的 EPIPE、超时、overflow 或无法观察的 `drain` 都会中止当前运行并返回失败 (`packages/cli/src/commands/HeadlessOutputEgress.ts`, `git:1af43232`)
- Headless 对 MCP Elicitation 和 Sampling 默认拒绝，但普通工具确认默认 Session 级批准；这不是 TUI 的交互权限行为 (`packages/cli/src/commands/headless.ts`)
- `globalOptions` 的 yargs 总体为 `strict: false` 以保留兼容性，Headless 仍在内部用 `HeadlessOptionsSchema` fail closed；新增选项必须同步这两层，否则可能被 yargs 接收后在运行器拒绝 (`packages/cli/src/cli/config.ts`, `packages/cli/src/commands/headless.ts`)

## Architecture
- 启动优先级固定为纯版本请求 → 工作区/信任预处理 → Headless → 全局关闭处理器 → Print → ACP → yargs 管理命令或 TUI，前面的专用模式不会加载后面的重型 UI 路径 (`packages/cli/src/blade.tsx`)
- `--settings` 先通过封闭字段集合与 TypeBox schema 校验，再只填补 argv 中未显式提供的值，最后由 `mergeRuntimeConfig()` 与持久配置合并 (`packages/cli/src/cli/settings.ts`, `packages/cli/src/cli/middleware.ts`)
- Print 与 Headless 共用输入规范化、插件资源加载、输出 schema 和非交互 Session 解析；Slash command 可直接产生输出，也可转换为 Skill/自定义命令提示后继续走 Agent (`packages/cli/src/commands/shared/commandInput.ts`)
- Headless 的事件 writer 显式映射每一种 LoopEvent，并在每个事件后 flush；结构化输出工具本身从普通 tool 事件中隐藏，只暴露专用 `structured_output` (`packages/cli/src/commands/headless.ts`, `packages/cli/src/commands/headlessEvents.ts`)
- `--task-isolation` 不是普通 Session 标志，它先通过 `SessionTaskService` 创建 durable Task 与可选 worktree，再禁止 Agent 重复调用 Enter/ExitWorktree (`packages/cli/src/commands/headless.ts`)

## Decisions
- Headless 与 Print 分成两个运行器：前者为自动化保留完整事件、阶段和工具状态，后者为 shell pipeline 保留单个最终值与简单退出码 (`packages/cli/src/commands/headless.ts`, `packages/cli/src/commands/print.ts`)
- JSONL 使用固定 `event_version` 和运行时 schema，是为了允许外部消费者独立于内部 LoopEvent 演进；新增事件必须先扩充 union 再从 writer 发出 (`packages/cli/src/commands/headlessEvents.ts`)
- TUI、yargs 和版本检查采用动态导入，避免 `--help`、`--version` 与非交互命令承担 Ink/React 启动成本 (`packages/cli/src/blade.tsx`)

## Patterns
- 非交互 resume 可以无新输入地继续 pending steering 或 active Goal；两者都不存在时只允许返回已恢复的最终响应，否则报“无未完成 turn” (`packages/cli/src/commands/headless.ts`, `packages/cli/src/commands/print.ts`)
- Session 权限模式在 Runtime 创建和 input preparation 前持久化，避免 UI/输出已宣称新模式但崩溃恢复仍使用旧模式 (`packages/cli/src/commands/headless.ts`, `packages/cli/src/commands/print.ts`)
- Headless 清理顺序是停止 Bus 订阅、flush 已接纳输出、dispose Runtime、关闭 egress、移除信号监听；新增早退路径必须仍经过统一 `finally` (`packages/cli/src/commands/headless.ts`)
- `serve` 与 `web` 都注册同一幂等 server stop 清理，区别仅是 Web 命令打开浏览器并展示地址；不要在两个命令中复制服务端资源所有权 (`packages/cli/src/commands/serve.ts`, `packages/cli/src/commands/web.ts`)

## Dependencies
- CLI 参数解析依赖 yargs，运行时校验依赖项目 TypeBox wrapper，TUI 启动依赖 Ink/React；这些依赖均在对应分支按需加载 (`packages/cli/src/blade.tsx`, `packages/cli/src/commands/headless.ts`)
