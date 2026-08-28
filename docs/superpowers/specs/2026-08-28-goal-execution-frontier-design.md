# Goal Execution Frontier Design

> 状态：设计稿，待用户审阅
> 日期：2026-08-28

## 背景

Blade 当前已经有两套可靠但未连接的运行时状态：GoalStore 持久化目标、预算、continuation、完成验证和活性保护；TaskListManager 持久化任务、依赖和状态，并分别投影到 TUI、Web 和 ACP。Goal continuation prompt 要求 Agent 检查持久任务，但宿主没有在每次 continuation 前读取并注入任务状态，因此长任务在上下文压缩、进程重启或多次 continuation 后依赖模型自行恢复执行前沿。

本设计把 Goal 与现有 TaskList 连接成一个 goal-scoped durable execution frontier。它不新建第二套任务协议，也不在第一版引入 planner/strategist 子代理；后续的停滞分类器和策略子代理以该前沿为输入单独迭代。

## 目标与非目标

### 目标

1. 一个 active Goal 有稳定、可恢复、与其他 Goal 隔离的任务作用域。
2. 每次自动 continuation 在调用 Provider 前读取最新任务状态，并把有界摘要和下一可执行任务注入 prompt。
3. 进程重启后，TUI、Web 和 ACP 能先恢复同一份任务前沿，再开始模型调用。
4. 任务状态无变化时提供诊断信号，但不把复杂任务的合法长步骤误判为 blocked。
5. 旧 GoalSnapshot（version 1）和没有 Goal 的普通 Session 保持兼容。
6. 对任务文件损坏、解析失败或作用域错配采用 fail-closed，阻止继续执行并保留可操作错误。

### 非目标

- 不替换 TaskListManager 的持久化格式、锁或现有 TaskCreate/TaskGet/TaskUpdate/TaskList 工具。
- 不在本 patch 引入独立的 GoalPlan 文件、planner/strategist/evaluator 子代理或自动重写任务。
- 不改变 Agent Team 的共享 taskListId 语义。
- 不因为任务摘要哈希连续不变就自动把 Goal 标记为 blocked。
- 不改变普通无 Goal Session 的任务作用域和三端现有事件名称。

## 设计概览

### 作用域优先级

执行上下文保留现有 `taskListId`，新增一个仅由宿主解析的 Goal 作用域字段。Task 工具选择作用域时按以下优先级解析：

```text
Agent Team taskListId > active Goal goalTaskListId > sessionId
```

Goal 作用域使用稳定的 `goal:<sessionId>:<goalId>` 标识，并通过已有文件名编码和摘要哈希机制落盘。创建新 Goal 时不会复用旧 Goal 的任务文件；恢复同一 Goal 时重新得到相同标识。Team 成员仍优先使用父级传入的共享 `taskListId`，因此不会被根 Session 的 Goal 隔离破坏。

### GoalSnapshot 扩展

GoalSnapshot 从 version 1 迁移为兼容的 version 2。新增字段为可选的 `executionFrontier`，只保存小型控制面摘要，不保存完整任务描述：

```ts
interface GoalExecutionFrontier {
  taskListId: string;
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  blocked: number;
  nextTask?: {
    id: string;
    subject: string;
    priority: 'high' | 'medium' | 'low';
  };
  digestSha256: string;
  observedAt: string;
}
```

`blocked` 表示没有满足依赖的 pending 任务数量，不代表 Goal 已被宿主阻塞。`digestSha256` 对任务 ID、状态、依赖、owner、priority 和 subject 做规范化后计算，subject 只参与摘要，不直接把任意任务描述注入 continuation。摘要最大长度固定，超出部分按稳定 ID 顺序截断并在摘要中标注截断。

旧 version 1 Goal 读取时不强行创建任务列表，`executionFrontier` 保持缺失；第一次成功读取或任务工具变更后再写入 version 2。无 Goal 时不写 GoalSnapshot，也不改变 session task list。

### Frontier 服务边界

新增小型的 frontier 解析模块，职责只有三项：

1. 根据 `GoalSnapshot` 和上下文计算有效 taskListId。
2. 从 `TaskListManager` 读取、校验并生成有界 `GoalExecutionFrontier`。
3. 将 frontier 格式化为受 XML 转义保护的 continuation block，并给三端事件使用同一份结构化摘要。

该模块不负责修改任务、不决定是否继续、不调用 Provider。GoalStore 只负责原子地保存 frontier 摘要；Agent/SessionRuntime 负责在 continuation 边界调用它。

### Continuation 数据流

自动 continuation 的顺序固定为：

1. `SessionRuntime` 读取 active/verifying Goal。
2. 解析 Goal task scope，并在 TaskListManager 上执行一次最新读取。
3. 生成 frontier，原子写回 GoalSnapshot 的 `executionFrontier`。
4. 发出 `goal_frontier_updated`，随后发出已有的 `goal_continuation_started`/`goal_updated`。
5. `buildGoalContinuationPrompt` 注入 `<goal-execution-frontier>`，包含统计、下一可执行任务、依赖阻塞数和摘要时间；不注入完整任务列表。
6. Agent 执行现有 loop。Task 工具沿用现有事件，变更后刷新 frontier。

如果 frontier 读取失败，步骤 3-5 不执行，Goal 进入可恢复的 `paused` 状态，事件携带 `task_list_unavailable` 类型和具体诊断；绝不能把读取失败当成空任务列表继续执行。`blocked` 仍只用于确实需要外部介入且满足 Goal 阻塞审计的情况。

### 下一任务选择

下一任务由 TaskListManager 的既有排序和依赖规则决定：只考虑 `pending`、所有 `blockedBy` 已 completed、且未被不兼容 owner 占用的任务；按 priority、创建顺序和 ID 的既有稳定排序取第一项。若没有可执行任务但仍有 pending，frontier 只报告 blocked 数量和“等待依赖”状态，不伪造任务。

### 进度和活性

`recordGoalProgress` 继续累计 token/time，并保留既有 premature-stop 活性门禁。frontier digest 只作为下一轮提示和诊断字段：

- digest 变化、任务完成数增加或任务状态改变：视为执行前沿有变化。
- digest 不变：记录一次 `frontier_stall` 观察，但不直接暂停或 block。
- 连续不变且同时出现 premature-stop 或 verifier gap：在 prompt 中要求换策略；未来 patch 再实现分类器和有界策略恢复。

这样可以避免把正在等待外部工具结果、长时间编辑同一任务或需要多次验证的合法步骤误判为停滞。

## 三端投影

### CLI TUI

复用现有 `task_update` 更新 TaskPanel。启动恢复或 Goal continuation 前额外发出一次结构化 frontier 事件，TUI 更新任务列表后再显示 continuation。Goal 事件不要求 TUI 自己读取磁盘，避免 UI 与 Runtime 看到不同版本。

### Web

保留 `task.updated` 的完整任务列表事件，新增 `goal.frontier.updated`，只包含 Goal id、统计、下一任务、digest 和错误状态。Web reload 首先通过 session 恢复接口得到 Goal/frontier，再订阅 SSE；旧客户端忽略新增事件也能继续显示现有任务。

### ACP

继续使用 ACP `plan` 投影完整任务列表；在 `session_info_update._meta['blade/goalFrontier']` 投影有界 frontier 和 `taskListId`。恢复时先发送 frontier 元数据，再发送既有 plan，确保 IDE 在 Agent 开始输出前有可见计划。

## 完成门禁

第一版只增加宿主可观测性，不改变 verifier 的独立证据模型。`UpdateGoal complete` 仍创建 candidate，由独立 verifier 判断。若 frontier 有 pending/in_progress/blocked 任务，Goal 工具返回明确的“仍有未完成任务”诊断，除非用户显式清理或完成这些任务；无任务的短目标保持现有行为。

Verifier 不能仅凭 frontier digest 或 completed 计数通过目标，仍须检查用户要求的文件、命令、测试和 GUI 证据。

## 错误处理与兼容性

- Task 文件不存在：视为尚未创建任务列表，允许无任务 Goal 继续，并在 frontier 中标记 `taskListId` 和 `total=0`；只有文件存在但损坏时 fail-closed。
- JSON schema 校验失败、摘要超限或任务依赖引用无效：暂停 Goal，事件包含稳定错误 code 和修复提示。
- Goal 文件 version 1：读取兼容，写入时升级为 version 2；未知 version 拒绝继续并提示升级。
- Team context 同时存在 Goal：Team `taskListId` 继续生效，根 Goal frontier 不把 Team 子任务误算进来。
- 并发读取：复用 TaskListManager 的 keyed mutex 和文件锁，不在 GoalStore 中复制任务锁。

## 测试与验收

### 单元测试

- 作用域优先级：Team > Goal > Session。
- Goal id 变化产生隔离文件，同一 Goal 重启后稳定定位。
- TaskList 依赖和 priority 选择下一任务，blocked 计数准确。
- digest 对排序稳定、对状态/依赖/subject 变化敏感、对超长 subject 有界。
- prompt XML 转义、长度上限和无任务/等待依赖文本。
- GoalSnapshot v1 读取、v2 写入和未知 version fail-closed。
- Task 文件损坏不会被当成空列表，Goal 状态和错误事件可恢复。

### Runtime 回归

- 自动 continuation 在 Provider 调用前读取 frontier 并注入 prompt。
- TaskUpdate 后 frontier 和 `task_update` 顺序一致。
- 旧 Goal、普通 Session、Agent Team 三种上下文互不串任务。
- verifier candidate、暂停、恢复和已有 turn-recovery 语义不回归。

### 真实 API 与 GUI

使用现有 DeepSeek 配置运行真实 API 轨迹：

- Headless：跨至少两次 continuation，验证新进程恢复后下一任务仍正确。
- ACP：验证 `session_info_update` frontier、`plan` 和恢复顺序。
- Web：生产构建后通过真实浏览器创建任务、reload、查看任务列表和 continuation，保存截图/事件证据。
- CLI TUI：优先使用 Computer Use；不可用时使用 raw PTY，验证任务面板在 continuation 前已恢复。

发布阻断门槛为 `bun run build`、`bun run type-check`、`bun run lint`、全量单元/集成/性能测试，以及上述真实 DeepSeek 轨迹。每个独立功能继续使用单独 patch 版本发布。

## 分阶段交付

1. **v0.10.102**：frontier 类型、作用域解析、GoalStore v2、continuation 注入、三端事件、单元/runtime 回归和真实 API 资格轨迹；发布前完成 Web GUI、ACP 与 CLI TUI/PTY 证据。
2. **后续 patch**：基于 frontier + 工具效果 + verifier feedback 的停滞分类器。
3. **后续 patch**：可选的 Grok 风格 strategist/planner，仍受有界重试和独立 verifier 约束。
