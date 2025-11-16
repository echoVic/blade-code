# Blade Subagent 系统设计文档

## 概述

Blade Subagent 系统允许主 Agent 委托专门的子 Agent 执行特定任务，提供更好的任务分解和专业化能力。

## 设计目标

1. **专业化**: 不同的 subagent 针对特定任务优化（文件搜索、代码分析等）
2. **安全性**: 工具隔离和写入操作确认机制
3. **可扩展性**: 支持自定义 subagent（Claude Code 风格的 Markdown 配置）
4. **可观测性**: 任务状态跟踪和持久化
5. **资源控制**: Token 预算和并发限制

## 核心设计决策

| 决策 | 说明 | 理由 |
|-----|------|------|
| **Token 预算** | 统一 100K tokens | 平衡性能和成本 |
| **写入确认** | 交互模式询问用户 | 安全性考虑 |
| **任务持久化** | `~/.blade/subagent-tasks/` | 支持任务历史和恢复 |
| **配置格式** | Markdown + YAML frontmatter | 易读易写，与 Claude Code 兼容 |
| **并发限制** | 最多 5 个并发任务 | 防止资源耗尽 |
| **工具隔离** | 每个 subagent 独立工具注册表 | 安全性和职责分离 |

## 架构设计

### 组件架构

```
┌─────────────────────────────────────────────────────────┐
│                     Main Agent                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │              TaskTool (Task)                     │  │
│  └───────────────────┬──────────────────────────────┘  │
│                      │                                  │
└──────────────────────┼──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│           SubagentTaskManager                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Task Queue (Max 5 concurrent)                  │   │
│  │  - Persistence (JSONL)                          │   │
│  │  - Status tracking                              │   │
│  └─────────────────────────────────────────────────┘   │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│            SubagentExecutor                             │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Tool Isolation                                 │   │
│  │  Token Budget (100K)                            │   │
│  │  Write Confirmation                             │   │
│  └─────────────────────────────────────────────────┘   │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│               Subagent Instance                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Isolated Tool Registry                         │   │
│  │  System Prompt from Definition                  │   │
│  │  Agent Loop with Limits                         │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 数据流

```
1. 主 Agent 调用 Task 工具
   ↓
2. TaskManager 创建任务记录
   ↓
3. TaskManager 检查并发限制
   ↓
4. SubagentExecutor 创建隔离环境
   ↓
5. 创建子 Agent 实例
   ↓
6. 执行 Agent 循环（带 Token 预算）
   │
   ├─ 只读工具: 直接执行
   └─ 写入工具: 请求确认 → 用户批准 → 执行
   ↓
7. 任务完成，持久化结果
   ↓
8. 返回结果给主 Agent
```

## 目录结构

```
src/agents/
├── types.ts                    # 核心类型定义
├── parser.ts                   # Markdown 配置解析器
├── registry.ts                 # Subagent 注册表
├── executor.ts                 # Subagent 执行引擎
├── taskManager.ts              # 任务管理器
├── confirmation.ts             # 写入确认处理
├── builtin/                    # 内置 subagents
│   ├── file-search.md
│   ├── code-analysis.md
│   └── codebase-explorer.md
└── index.ts                    # 导出接口

配置文件位置（优先级从高到低）:
1. .blade/agents/*.md           # 项目级
2. ~/.blade/agents/*.md         # 用户级
3. src/agents/builtin/*.md      # 内置

任务持久化:
~/.blade/subagent-tasks/
├── tasks.jsonl                 # 任务记录（追加式）
└── {task-id}.json              # 详细结果
```

## Subagent 配置格式

### Markdown 格式（Claude Code 兼容）

```markdown
---
name: agent-name
description: 描述何时调用此 subagent
model: sonnet
tools: Read, Grep, Glob
max_turns: 15
timeout: 300000
token_budget: 100000
input_schema:
  type: object
  properties:
    query: { type: string }
output_schema:
  type: object
  properties:
    result: { type: string }
---

系统提示词内容（Markdown 格式）

可以包含多行，使用标准 Markdown 语法。
```

### 配置字段说明

| 字段 | 必需 | 类型 | 默认值 | 说明 |
|-----|------|------|--------|------|
| `name` | ✅ | string | - | 唯一标识符（小写+连字符） |
| `description` | ✅ | string | - | 何时调用此 subagent |
| `model` | ❌ | string | `sonnet` | 模型选择: haiku/sonnet/opus |
| `tools` | ❌ | string | 继承所有 | 逗号分隔的工具列表 |
| `max_turns` | ❌ | number | `10` | 最大执行回合数 |
| `timeout` | ❌ | number | `300000` | 超时时间（毫秒） |
| `token_budget` | ❌ | number | `100000` | Token 预算 |
| `input_schema` | ❌ | object | - | JSON Schema（输入验证） |
| `output_schema` | ❌ | object | - | JSON Schema（输出验证） |

## 核心类型定义

### SubagentDefinition

```typescript
interface SubagentDefinition {
  name: string;                    // 唯一标识符
  displayName?: string;            // 显示名称
  description: string;             // 何时调用
  systemPrompt: string;            // 系统提示词

  // 模型和工具配置
  model?: 'haiku' | 'sonnet' | 'opus';
  tools?: string[];                // 允许的工具列表

  // 执行控制
  maxTurns?: number;               // 最大回合数
  timeout?: number;                // 超时时间（毫秒）
  tokenBudget?: number;            // Token 预算

  // Schema 验证
  inputSchema?: JSONSchema;        // 输入验证
  outputSchema?: JSONSchema;       // 输出验证

  // 元信息
  source?: string;                 // 配置文件路径
}
```

### SubagentResult

```typescript
interface SubagentResult {
  output: any;                     // 执行结果
  terminateReason: TerminateReason;
  turns: number;                   // 实际回合数
  duration: number;                // 执行时长（毫秒）
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  activities?: SubagentActivity[]; // 活动记录
}

enum TerminateReason {
  GOAL = 'GOAL',                   // 成功完成
  TIMEOUT = 'TIMEOUT',             // 超时
  MAX_TURNS = 'MAX_TURNS',         // 达到最大回合数
  TOKEN_LIMIT = 'TOKEN_LIMIT',     // 超出 Token 预算
  ABORTED = 'ABORTED',             // 用户取消
  ERROR = 'ERROR'                  // 执行错误
}
```

### PersistedTask

```typescript
interface PersistedTask {
  id: string;                      // 任务 ID
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  agentName: string;               // Subagent 名称
  params: Record<string, any>;     // 输入参数
  result?: SubagentResult;         // 执行结果
  error?: string;                  // 错误信息
  createdAt: number;               // 创建时间
  startedAt?: number;              // 开始时间
  completedAt?: number;            // 完成时间
  tokenUsage?: TokenUsage;         // Token 使用量
}
```

## 工具隔离机制

### 只读工具白名单

以下工具被认为是安全的只读工具，可以直接执行：

- `Read` - 读取文件
- `Glob` - 文件模式匹配
- `Grep` - 搜索文件内容
- `WebSearch` - 网络搜索
- `WebFetch` - 获取网页内容

### 写入工具确认

以下工具需要用户确认：

- `Write` - 写入文件
- `Edit` - 编辑文件
- `Bash` - 执行 Shell 命令
- `NotebookEdit` - 编辑 Jupyter Notebook

### 确认流程

```typescript
// 写入工具调用流程
1. Subagent 尝试调用写入工具
   ↓
2. WriteToolConfirmationHandler 拦截
   ↓
3. 检查是否为写入工具
   ├─ 只读工具: 直接通过
   └─ 写入工具: 请求确认
       ↓
4. 代理到父 Agent 的确认处理器
   ↓
5. 显示确认对话框（工具名、参数）
   ↓
6. 用户批准/拒绝
   ↓
7. 返回决策结果
```

## Token 预算控制

### 预算设置

- **统一预算**: 100,000 tokens
- **适用范围**: 输入 + 输出 tokens
- **超出行为**: 终止任务，返回 TOKEN_LIMIT

### 实现方式

```typescript
class SubagentExecutor {
  private tokenUsage = { input: 0, output: 0 };

  async execute(): Promise<SubagentResult> {
    const tokenBudget = this.definition.tokenBudget || 100000;

    // 在每次 LLM 调用后检查
    agent.onTokenUsage((usage) => {
      this.tokenUsage.input += usage.input;
      this.tokenUsage.output += usage.output;

      const total = this.tokenUsage.input + this.tokenUsage.output;

      if (total > tokenBudget) {
        throw new TokenBudgetExceededError(
          `Token budget exceeded: ${total}/${tokenBudget}`
        );
      }
    });
  }
}
```

## 并发控制

### 并发限制

- **最大并发数**: 5 个 subagent 任务
- **排队机制**: 超出限制的任务需等待或使用后台模式
- **计数器**: 运行时维护活跃任务计数

### 实现方式

```typescript
class SubagentTaskManager {
  private runningCount = 0;
  private readonly MAX_CONCURRENT = 5;

  canRunTask(): boolean {
    return this.runningCount < this.MAX_CONCURRENT;
  }

  async executeTask(taskId: string): Promise<SubagentResult> {
    if (!this.canRunTask()) {
      throw new Error('Concurrent limit reached (5)');
    }

    this.runningCount++;
    try {
      return await this.doExecute(taskId);
    } finally {
      this.runningCount--;
    }
  }
}
```

## 任务持久化

### 存储格式

**任务记录** (`~/.blade/subagent-tasks/tasks.jsonl`):
```jsonl
{"id":"abc123","status":"completed","agentName":"file-search",...}
{"id":"def456","status":"running","agentName":"code-analysis",...}
```

**详细结果** (`~/.blade/subagent-tasks/{task-id}.json`):
```json
{
  "output": { ... },
  "terminateReason": "GOAL",
  "turns": 5,
  "duration": 12345,
  "tokenUsage": { "input": 5000, "output": 3000, "total": 8000 }
}
```

### 持久化时机

1. **任务创建**: 立即写入 tasks.jsonl
2. **状态更新**: 每次状态变化追加记录
3. **任务完成**: 写入详细结果到单独文件

### 加载策略

- **启动时**: 从 tasks.jsonl 加载任务历史
- **查询时**: 按需加载详细结果

## 内置 Subagents

### 1. file-search

**用途**: 深度代码库探索和文件发现

**工具**: Glob, Grep, Read

**输出**: 结构化的文件列表和代码片段

### 2. code-analysis

**用途**: 代码架构和依赖关系分析

**工具**: Read, Grep, Glob

**输出**: 架构报告、模块依赖图、问题列表

### 3. codebase-explorer

**用途**: 通用代码库探索和问答

**工具**: Read, Grep, Glob

**输出**: 自然语言回答

## Task 工具更新

### 新的 Task 工具签名

```typescript
Task(
  description: string,        // 任务简短描述
  subagent_type: string,      // Subagent 名称
  prompt: string,             // 详细提示词
  run_in_background?: boolean // 后台执行（默认 false）
): TaskResult
```

### 执行模式

**同步模式** (`run_in_background: false`):
- 阻塞直到完成
- 直接返回结果
- 适合快速任务

**后台模式** (`run_in_background: true`):
- 立即返回任务 ID
- 使用 `task_status` 查询进度
- 适合长时间任务

### 伴随工具

```typescript
// 查询任务状态
task_status(task_id: string): TaskStatus

// 列出任务
task_list(
  status?: string,
  agent_name?: string,
  limit?: number
): TaskInfo[]

// 取消任务
cancel_task(task_id: string): boolean
```

## 错误处理

### 错误类型

1. **配置错误**
   - 缺少必需字段
   - 无效的工具名称
   - Schema 验证失败

2. **执行错误**
   - 超时
   - Token 预算超出
   - 工具调用失败
   - 用户取消

3. **系统错误**
   - 并发限制
   - 持久化失败
   - 网络错误

### 错误处理策略

```typescript
try {
  result = await taskManager.executeTask(taskId, executor);
} catch (error) {
  if (error instanceof TimeoutError) {
    // 超时: 尝试恢复或标记为超时
    task.terminateReason = TerminateReason.TIMEOUT;
  } else if (error instanceof TokenBudgetExceededError) {
    // Token 超出: 标记并返回部分结果
    task.terminateReason = TerminateReason.TOKEN_LIMIT;
  } else if (error instanceof ConcurrentLimitError) {
    // 并发限制: 建议使用后台模式或稍后重试
    return suggestBackgroundMode();
  } else {
    // 其他错误: 记录并标记为失败
    task.terminateReason = TerminateReason.ERROR;
    task.error = error.message;
  }

  // 持久化错误状态
  taskManager.persistTask(task);
}
```

## 性能考虑

### Token 使用优化

1. **系统提示词**: 简洁明确，避免冗余
2. **工具描述**: 精简但足够清晰
3. **上下文管理**: 不传递完整对话历史
4. **输出格式**: 要求结构化输出，减少不必要的解释

### 内存管理

1. **任务清理**: 定期清理已完成任务（可配置保留时间）
2. **结果缓存**: 详细结果按需加载
3. **活动记录**: 限制活动记录数量

### 并发优化

1. **异步执行**: 后台任务不阻塞主 Agent
2. **队列管理**: FIFO 队列处理等待任务
3. **资源隔离**: 每个 subagent 独立资源限制

## 安全考虑

### 工具隔离

- ✅ 每个 subagent 独立工具注册表
- ✅ 只能访问配置中指定的工具
- ✅ 无法访问父 Agent 的上下文

### 写入保护

- ✅ 写入工具需要明确确认
- ✅ 显示完整的工具调用参数
- ✅ 用户可以逐个批准或拒绝

### 资源限制

- ✅ Token 预算防止过度消耗
- ✅ 超时限制防止无限循环
- ✅ 并发限制防止资源耗尽

## 扩展性

### 自定义 Subagent

用户可以在以下位置创建自定义 subagent:

1. **项目级**: `.blade/agents/my-agent.md`
2. **用户级**: `~/.blade/agents/my-agent.md`

### MCP 工具支持

Subagent 可以使用 MCP Server 提供的工具:

```markdown
---
name: database-expert
tools: Read, mcp__database__query, mcp__database__schema
---
```

### 插件系统集成

未来可以通过插件系统扩展:

1. 动态注册 subagent
2. 自定义确认处理逻辑
3. 自定义持久化后端

## 测试策略

### 单元测试

- [ ] SubagentConfigParser 解析测试
- [ ] SubagentRegistry 注册和查找测试
- [ ] SubagentExecutor 执行逻辑测试
- [ ] SubagentTaskManager 并发控制测试
- [ ] WriteToolConfirmationHandler 确认逻辑测试

### 集成测试

- [ ] 端到端 subagent 执行测试
- [ ] 工具隔离验证测试
- [ ] 写入确认流程测试
- [ ] 任务持久化和恢复测试
- [ ] Token 预算控制测试

### 性能测试

- [ ] 并发执行性能测试
- [ ] Token 使用效率测试
- [ ] 持久化性能测试

## 实施计划

### 阶段 1: 核心基础（第 1-2 周）

- [x] 创建设计文档
- [ ] 实现核心类型定义（types.ts）
- [ ] 实现配置解析器（parser.ts）
- [ ] 实现注册表（registry.ts）
- [ ] 实现执行引擎（executor.ts）
- [ ] 实现写入确认（confirmation.ts）
- [ ] 实现任务管理器（taskManager.ts）

### 阶段 2: 内置 Agents（第 3 周）

- [ ] 创建 file-search.md
- [ ] 创建 code-analysis.md
- [ ] 创建 codebase-explorer.md
- [ ] 更新 task.ts，移除模拟逻辑

### 阶段 3: 伴随工具（第 3-4 周）

- [ ] 实现 task_status 工具
- [ ] 实现 task_list 工具
- [ ] 实现 cancel_task 工具

### 阶段 4: 测试和优化（第 4 周+）

- [ ] 编写单元测试
- [ ] 编写集成测试
- [ ] 性能优化
- [ ] 文档完善

## 参考资料

- **Claude Code Subagents**: https://code.claude.com/docs/en/sub-agents
- **Gemini-CLI 实现**: `/Users/example/Documents/GitHub/gemini-cli/packages/core/src/agents/`
- **Neovate-Code 实现**: `/Users/example/Documents/GitHub/neovate-code/src/backgroundTaskManager.ts`
- **Blade .claude/agents/**: 75+ 社区 subagent 示例

## 变更日志

- **2025-11-13**: 初始设计文档创建
  - 确定核心架构和组件
  - 定义配置格式和类型
  - 设计工具隔离和安全机制
  - 规划实施阶段
