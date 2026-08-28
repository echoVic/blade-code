# Goal Frontier Stall Classifier Design

> 状态：批准实施
> 日期：2026-08-28

## 背景

`v0.10.102` 已把 active Goal 绑定到 goal-scoped durable TaskList，并在每次 continuation
前读取 execution frontier。现有 `actionStationarity` 只检测单个回合内重复的工具调用，
`prematureStop` 和 verifier feedback 也分别工作；它们没有回答一个长任务核心问题：
跨 continuation 任务前沿是否真的没有变化，以及模型是否在同一失败策略上继续消耗预算。

## 目标与非目标

目标：

1. 在 Goal sidecar 中保存有界的 frontier stall 观察状态，跨进程重启保持一致。
2. 只在 frontier digest 连续不变且有可审计的停滞信号时计数，减少合法长步骤的误报。
3. 在下一次 continuation 前给模型具体、可执行的策略切换提示。
4. 通过 Headless JSONL、CLI TUI、Web SSE/DOM 与 ACP metadata 暴露同一结构化诊断。
5. 保持 Goal v1/v2 读取兼容；新字段是可选控制面数据，不保存模型原文、工具参数或凭据。

非目标：

- 不自动修改任务、重启 worker 或启动 planner/strategist 子代理。
- 不因为 frontier digest 不变就自动暂停或 block Goal。
- 不替代已有的 premature-stop 三次熔断和 verifier-gap 三次熔断。
- 不改变 Team taskListId 优先级、普通 Session 任务作用域或 TaskList 文件格式。

## 分类规则

分类器是纯函数，输入为前后两个 frontier、当前 Goal 的 liveness/verifier 状态，以及本次
continuation 是否观察到有效任务效果。它返回 `undefined` 或以下三种分类之一：

```ts
type GoalFrontierStallCategory =
  | 'waiting_dependency'
  | 'same_task_no_effect'
  | 'repeated_deferral';
```

规则按优先级执行：

1. `waiting_dependency`：仍有 pending 任务，但没有可执行的 `nextTask`，且至少一个任务
   被未完成依赖阻塞。只要有 in-progress 任务，不把它标记为等待依赖。
2. `repeated_deferral`：digest 与上一观察相同，并且 `prematureStop.consecutiveCount >= 2`
   或 `verificationStall.consecutiveCount >= 2`。这是最强信号，提示改变实现或验证策略。
3. `same_task_no_effect`：digest 与上一观察相同、存在 pending/in-progress 工作，且本次
   continuation 没有观察到有效 Task 状态变化或 workspace mutation。只有在前沿有实际工作
   时才产生；空任务 Goal 不产生该分类。

首次观察、digest 变化、Goal 编辑、显式 resume、workspace mutation 或 Task 状态变化都会
清零连续计数。`waiting_dependency` 可以在每次 continuation 报告，但不会把 Goal 状态改为
blocked；外部阻塞仍由 Agent 调用 `UpdateGoal blocked` 表达。

## 持久化模型

`GoalSnapshot` 保持 version `1 | 2`。新增可选字段：

```ts
interface GoalFrontierStallState {
  category: GoalFrontierStallCategory;
  consecutiveCount: number;
  digestSha256: string;
  detectedAt: string;
}
```

所有值均有固定上限：分类为枚举，次数为正整数且最多 3，digest 必须为小写 SHA-256，时间
使用 ISO date-time。`GoalStore` 的所有写路径继续把 version 规范化为 2；旧 v1 读取后在
下一次持久化更新时升级。记录与 frontier 使用同一个 keyed lock，保证前后 digest 与计数
不会跨并发写错配。

## Continuation 数据流

`SessionRuntime.prepareGoalContinuation()` 读取最新 TaskList 后：

1. 取旧的 `executionFrontier` 与 `frontierStall`。
2. 运行纯分类器，确定当前类别和连续次数。
3. 原子写入新的 frontier 与 stall state；没有分类时清除旧 stall state。
4. 返回带 stall 的 GoalSnapshot，Agent 先发 `goal_frontier_updated`，再构造 continuation prompt。
5. prompt 使用受 XML 转义的 `<goal-frontier-stall>`，只含分类、次数、建议动作和非可信标记，
   不重复注入 verifier 原文。

Task 工具刷新 frontier 时只更新 frontier，不增加 continuation stall 次数；这样同一逻辑
回合内的多个 TaskUpdate 不会伪造跨回合停滞。

## 跨端投影

- Headless `goal` 与 `goal_frontier` 事件增加 bounded `stall_category`、`stall_count`。
- TUI 继续复用 Goal 状态和任务面板，同时把分类写入状态 store，供状态栏显示短标签。
- Web SSE `goal.frontier.updated` 携带 `stall`，GoalControlBar 暴露
  `data-blade-goal-frontier-stall` 与 `data-blade-goal-frontier-stall-count`，reload 从
  GoalSnapshot 恢复相同值。
- ACP 在 `blade/goalFrontier` metadata 中携带 `stall`；仍发送标准 `plan`，不引入私有任务协议。

旧客户端忽略新增字段仍可正常显示任务和 Goal 状态。

## 测试与准出

单元测试覆盖：分类优先级、digest 稳定/变化、空任务和 in-progress 排除、计数上限、GoalStore
原子持久化与 v1 读取、prompt XML 转义与有界输出、四端事件投影。

真实 API 测试使用已有 DeepSeek 配置，至少验证：

- Headless 两次 continuation 后同一 stall state 被恢复并注入 prompt；
- Web 生产构建真实浏览器 reload 后 DOM 仍显示分类与次数；
- ACP metadata 与 plan 顺序保持不变。

发布前运行 `bun run build`、`bun run type-check`、`bun run lint`、`bun run test:all`，并保留
现有 CLI PTY/Computer Use 尝试及真实 API 轨迹证据。
