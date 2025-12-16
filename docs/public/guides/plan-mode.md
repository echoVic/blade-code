# Plan 模式使用指南

## 什么是 Plan 模式？

Plan 模式是 Blade Code 的一项特殊功能，允许 AI 在不对代码库进行任何修改的情况下，进行充分的调研和规划。在 Plan 模式下，AI 只能使用只读工具，确保在提交完整实现方案之前不会对项目造成任何影响。

## 核心特性

### 双重保护机制

Plan 模式通过两层保护确保安全：

1. **系统提示约束（软约束）**：通过系统提示词引导 LLM 的行为
2. **工具级别限制（硬约束）**：在执行管道中强制阻止非只读工具的调用

### 允许的工具

Plan 模式仅允许 `ReadOnly` 工具：

- 文件/搜索：Read、Glob、Grep
- 网络：WebFetch、WebSearch
- 运行时信息：BashOutput（读取后台命令输出）
- 计划与任务：TodoWrite、Task（子 Agent）、EnterPlanMode、ExitPlanMode

### 禁止的工具

- 写操作：Edit、Write、NotebookEdit 以及任何 MCP 写工具
- 执行类：Bash、KillShell、Skill、SlashCommand（Execute 类工具）

## 如何使用

### 激活 Plan 模式

在 Blade Code 主界面中，**按 Shift+Tab** 循环切换权限模式：

**DEFAULT → AUTO_EDIT → PLAN → DEFAULT → ...**

当切换到 Plan 模式时，界面顶部会显示蓝色指示器：

```
┌─────────────────────────────────────────┐
│ 🔵 Plan 模式已激活                       │
│ • 只允许使用只读工具（Read、Grep等）      │
│ • 使用 ExitPlanMode 工具提交完整实现方案 │
│ • 按 Shift+Tab 循环切换权限模式         │
└─────────────────────────────────────────┘
```

### 工作流程

1. **激活 Plan 模式**：按 Shift+Tab 切换到 PLAN 模式
2. **提出需求**：输入您想要实现的功能或修改
3. **AI 调研**：AI 使用只读工具（Read、Grep、WebFetch 等）深入研究代码库
4. **生成方案**：AI 使用 `ExitPlanMode` 工具提交完整的实现方案
5. **用户审查**：查看 AI 生成的详细方案
6. **批准或拒绝**：
   - **[Y] 批准**：退出 Plan 模式，AI 可以开始执行修改
   - **[N] 拒绝**：保持 Plan 模式，AI 可以继续优化方案

### 示例对话

```
用户: [按 Shift+Tab 切换到 Plan 模式]

🔵 已进入 Plan 模式。我将进行调研并制定方案，不会执行任何修改操作。

用户: 我想添加一个用户认证系统，支持 JWT Token

AI: 收到。我会先调研项目结构和现有代码，然后制定完整的实现方案。

[AI 使用 Glob 查找相关文件]
[AI 使用 Read 读取配置文件]
[AI 使用 Grep 搜索相关代码]
[AI 使用 TodoWrite 记录发现]

AI: 调研完成。我已经制定了完整的实现方案。

[AI 调用 ExitPlanMode 工具]

🔵 Plan 模式 - 方案审查
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 实现方案:

## 用户认证系统实现方案

### 📖 需求分析
- 实现基于 JWT 的用户认证
- 支持登录、注册、Token 刷新
- 集成到现有的 Express 服务器

### 🗂️ 需要创建/修改的文件

1. **src/auth/jwt.ts** (新建)
   - Token 生成和验证逻辑

2. **src/middleware/auth.ts** (新建)
   - 认证中间件

3. **src/routes/auth.ts** (新建)
   - 登录/注册路由

4. **src/services/UserService.ts** (修改)
   - 添加密码哈希和验证方法

### 🔧 实现步骤

1. 安装依赖：jsonwebtoken, bcryptjs
2. 创建 JWT 工具模块
3. 实现认证中间件
4. 创建认证路由
5. 更新用户服务
6. 编写单元测试
7. 更新 API 文档

### ⚠️ 风险与考虑

- 需要添加环境变量 JWT_SECRET
- 现有路由需要应用认证中间件
- 数据库需要添加 User 表

### ✅ 测试策略

- 单元测试：JWT 工具、密码哈希
- 集成测试：登录/注册流程
- 端到端测试：完整认证流程

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

使用 ↑ ↓ 选择，回车确认（支持 Y / N 快捷键）

  [Y] 批准方案并退出 Plan 模式
  [N] 拒绝方案，保持 Plan 模式继续优化
```

### 方案批准后

如果您批准方案（按 Y），Plan 模式会自动退出，AI 将开始执行实现：

```
✅ 方案已批准，退出 Plan 模式

AI: 开始执行实现方案...

[AI 开始使用 Write、Edit、Bash 等工具执行修改]
```

### 方案拒绝后

如果您拒绝方案（按 N），Plan 模式保持激活，您可以提出改进建议：

```
❌ 方案被拒绝，保持 Plan 模式

用户: 请添加 OAuth 2.0 支持（Google 和 GitHub）

AI: 好的，我会修改方案以支持 OAuth 2.0...

[AI 继续使用只读工具调研]
[AI 再次调用 ExitPlanMode 提交改进方案]
```

## 手动退出 Plan 模式

如果您想在不提交方案的情况下退出 Plan 模式，只需**继续按 Shift+Tab** 切换到其他权限模式（DEFAULT 或 AUTO_EDIT）。

## 使用场景

### 适合使用 Plan 模式的场景

1. **大型功能开发**：需要修改多个文件和模块
2. **架构重构**：涉及系统性改动
3. **不熟悉的代码库**：需要充分调研再动手
4. **风险评估**：希望提前了解潜在影响
5. **团队协作**：需要方案审查和讨论

### 不需要使用 Plan 模式的场景

1. **简单修改**：单个文件的小改动
2. **修复明显的 Bug**：已经确定修改方案
3. **代码格式化**：低风险的机械性操作

## 技术细节

### Plan 模式与权限系统的集成

Plan 模式是 `PermissionMode` 枚举的一种，与其他权限模式（DEFAULT、AUTO_EDIT、YOLO）处于同一层级：

```typescript
export enum PermissionMode {
  DEFAULT = 'default',    // 默认模式
  AUTO_EDIT = 'autoEdit', // 自动编辑模式
  YOLO = 'yolo',          // 危险模式
  PLAN = 'plan',          // Plan 模式
}
```

### 工具分类系统

Blade 使用 `isReadOnly` 字段对工具进行分类：

```typescript
// 只读工具（Plan 模式允许）
Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task

// 非只读工具（Plan 模式禁止）
Edit, Write, Bash, Shell
```

### 执行管道拦截

即使 LLM 尝试调用非只读工具，执行管道也会在阶段 0 拦截：

```
❌ Plan 模式限制: 不允许使用 Edit

当前处于 Plan 模式，仅允许使用只读工具。
如需执行修改操作，请：
1. 使用 ExitPlanMode 工具提交完整方案
2. 等待用户批准后退出 Plan 模式

允许的工具: Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task
```

## 最佳实践

1. **复杂任务启用 Plan 模式**：涉及多文件修改时主动使用
2. **仔细审查方案**：检查文件列表、实现步骤、潜在风险
3. **提出具体反馈**：拒绝方案时说明具体需要改进的地方
4. **迭代优化**：利用 Plan 模式的多轮对话能力
5. **保存方案**：重要方案可以复制保存，便于后续参考

## 常见问题

### Q: Plan 模式会自动保存吗？

A: 不会。Plan 模式只是一个运行时状态。如果您想保存方案，可以在方案展示时复制内容。

### Q: 可以在 Plan 模式下运行测试吗？

A: 不可以。运行测试需要使用 `Bash` 工具，这在 Plan 模式下被禁止。您需要批准方案退出 Plan 模式后才能运行测试。

### Q: Plan 模式下 AI 能访问哪些文件？

A: AI 可以使用 `Read`、`Glob`、`Grep` 等工具读取任何项目文件，但不能修改它们。

### Q: 如果方案太长怎么办？

A: 终端会自动滚动显示长方案。您可以向上滚动查看完整内容，或要求 AI 提供更简洁的摘要版本。

### Q: Plan 模式支持子 Agent 吗？

A: 是的。`Task` 工具在 Plan 模式下可用，子 Agent 也会继承 Plan 模式状态，确保整个任务树都是只读的。

### Q: 为什么只有 TodoWrite，而没有 TodoRead？

A: 当前的 TODO 系统采用「写入即同步」的设计，只保留 TodoWrite 一个工具：

1. TodoWrite 每次调用都会返回当前完整的任务列表和统计信息，相当于隐式的“读 + 写”。
2. 减少工具数量可以降低 LLM 的心智负担，也与 Claude Code 的官方设计保持一致（只有 TodoWrite）。
3. 工具调用结果会自动作为对话上下文的一部分保留，LLM 可以直接从最近的 TodoWrite 结果中读取任务状态，无需额外的 TodoRead 调用。

因此，如果只是想查看任务列表，不需要再调用新工具，直接参考最近一次 TodoWrite 的输出即可。

## 参考资源

- [配置系统文档](../configuration/config-system.md)
- [工具系统文档](../reference/tool-list.md)
- [开发者实现文档](../../development/planning/plan-mode-implementation.md)
