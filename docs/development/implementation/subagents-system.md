# Subagents 系统实现

本文档描述 Blade 的 Subagents 系统的技术实现细节。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        Main Agent                            │
│  - 处理用户输入                                               │
│  - 决定是否调用 subagent                                      │
│  - 整合 subagent 返回结果                                     │
└────────────────┬────────────────────────────────────────────┘
                 │ Task Tool
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                   Subagent Executor                          │
│  - 创建独立的 Agent 实例                                      │
│  - 应用 subagent 配置                                        │
│  - 执行任务并返回结果                                         │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                  Subagent Registry                           │
│  - 加载和管理 subagent 配置                                   │
│  - 解析 Markdown + YAML frontmatter                          │
│  - 提供配置查询接口                                           │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. SubagentRegistry

**文件**: `src/agent/subagents/SubagentRegistry.ts`

**职责**:
- 加载 subagent 配置文件
- 解析 YAML frontmatter + Markdown
- 提供配置查询接口
- 生成 LLM 可读的描述

**关键方法**:

```typescript
class SubagentRegistry {
  // 注册 subagent
  register(config: SubagentConfig): void;

  // 获取 subagent
  getSubagent(name: string): SubagentConfig | undefined;

  // 获取所有名称
  getAllNames(): string[];

  // 获取所有配置
  getAllSubagents(): SubagentConfig[];

  // 生成 LLM 描述
  getDescriptionsForPrompt(): string;

  // 从目录加载
  loadFromDirectory(dirPath: string): void;

  // 从标准位置加载
  loadFromStandardLocations(): number;

  // 清空(用于测试和重新加载)
  clear(): void;
}
```

**配置加载流程**:

1. 读取 `.md` 文件
2. 使用正则表达式提取 YAML frontmatter
3. 使用 `yaml.parse()` 解析 frontmatter
4. 验证必需字段 (`name`, `description`)
5. 使用 Markdown 正文作为 `systemPrompt`
6. 存储到 `Map<string, SubagentConfig>`

**加载位置** (优先级从高到低):
1. 项目级: `{cwd}/.blade/agents/*.md`
2. 用户级: `~/.blade/agents/*.md`

### 2. SubagentExecutor

**文件**: `src/agent/subagents/SubagentExecutor.ts`

**职责**:
- 创建子 Agent 实例
- 应用 subagent 配置(系统提示、工具过滤)
- 执行任务并返回结果

**执行流程**:

```typescript
async execute(context: SubagentContext): Promise<string> {
  // 1. 创建新 Agent 实例
  const agent = await Agent.create({
    systemPrompt: this.buildSystemPrompt(context),
  });

  // 2. 如果有工具限制,过滤工具注册表
  if (this.config.tools && this.config.tools.length > 0) {
    const registry = agent.getToolRegistry();
    const allowedTools = this.config.tools;
    // ...过滤逻辑
  }

  // 3. 执行任务
  const response = await agent.chat(context.prompt, {
    messages: [],
    userId: 'subagent',
    sessionId: `subagent-${context.parentSessionId}`,
    workspaceRoot: process.cwd(),
  });

  return response;
}
```

**关键设计**:
- **无状态**: 每次调用创建新 Agent 实例
- **工具隔离**: 只注册配置中指定的工具
- **系统提示**: 直接使用 Markdown 正文

### 3. Task Tool

**文件**: `src/tools/builtin/task/task.ts`

**职责**:
- 向 LLM 暴露 subagent 调用能力
- 验证参数
- 调用 SubagentExecutor

**参数**:

```typescript
{
  subagent_type: string;    // 必需: subagent 名称
  description: string;      // 必需: 3-5 词任务描述
  prompt: string;           // 必需: 详细任务指令
}
```

**执行流程**:

```typescript
async execute(params, context) {
  // 1. 获取 subagent 配置
  const config = subagentRegistry.getSubagent(params.subagent_type);
  if (!config) {
    return error(`Unknown subagent: ${params.subagent_type}`);
  }

  // 2. 创建 executor
  const executor = new SubagentExecutor(config);

  // 3. 构建上下文
  const subagentContext = {
    prompt: params.prompt,
    parentSessionId: context.sessionId,
    parentMessageId: context.messageId,
  };

  // 4. 执行并返回结果
  const result = await executor.execute(subagentContext);
  return { success: true, llmContent: result };
}
```

**LLM 提示生成**:

```typescript
description: {
  long: `
${subagentRegistry.getDescriptionsForPrompt()}

**How to use the Task tool:**
- Set subagent_type to ANY agent name from the list above
- Each agent has a specific purpose described in its description
- The agent descriptions tell you when to use each agent (look for "Use this when...")
`,
}
```

### 4. 类型定义

**文件**: `src/agent/subagents/types.ts`

```typescript
/**
 * Subagent 配置
 */
export interface SubagentConfig {
  name: string;                 // Agent 名称
  description: string;          // 描述 + 使用场景
  systemPrompt?: string;        // 系统提示(Markdown 正文)
  tools?: string[];             // 允许的工具列表
  color?: SubagentColor;        // UI 颜色
  configPath?: string;          // 配置文件路径
}

/**
 * Subagent 执行上下文
 */
export interface SubagentContext {
  prompt: string;               // 任务提示
  parentSessionId?: string;     // 父会话 ID
  parentMessageId?: string;     // 父消息 ID
}

/**
 * YAML Frontmatter
 */
export interface SubagentFrontmatter {
  name: string;
  description: string;
  tools?: string[];
  color?: SubagentColor;
}

/**
 * UI 颜色
 */
export type SubagentColor =
  | 'red' | 'blue' | 'green' | 'yellow'
  | 'purple' | 'orange' | 'pink' | 'cyan';
```

## UI 组件

### AgentsManager

**文件**: `src/ui/components/AgentsManager.tsx`

**功能**:
- 查看所有 subagents
- 创建新 subagent
- 编辑现有 subagent
- 删除 subagent

**状态管理**:

```typescript
const [mode, setMode] = useState<ViewMode>('menu');
const [selectedAgent, setSelectedAgent] = useState<SubagentConfig | null>(null);
const [refreshKey, setRefreshKey] = useState(0);

// 重新加载 registry
const reloadAgents = useMemoizedFn(() => {
  subagentRegistry.clear();
  subagentRegistry.loadFromStandardLocations();
  setRefreshKey(prev => prev + 1);
});

// 动态加载 agents (依赖 refreshKey)
const allAgents = useMemo(() => {
  return subagentRegistry.getAllSubagents();
}, [refreshKey]);
```

**工作流**:

```
Menu → List       (查看所有)
     → Create     → Wizard → Complete → Reload → Menu
     → Edit       → Select → Wizard → Complete → Reload → Menu
     → Delete     → Select → Confirm → Delete → Reload → Menu
```

### AgentCreationWizard

**文件**: `src/ui/components/AgentCreationWizard.tsx`

**创建模式**:

1. **手动模式** (7 步):
   - mode → name → description → tools → color → location → systemPrompt → confirm

2. **AI 生成模式** (4 步):
   - mode → aiPrompt → aiGenerating → confirm

3. **编辑模式** (7 步):
   - name → description → tools → color → location → systemPrompt → confirm

**AI 生成实现**:

```typescript
const generateConfigWithAI = async () => {
  // 1. 创建临时 Agent
  const agent = await Agent.create();

  // 2. 使用 chatWithSystem 调用 LLM
  const systemPrompt = `你是一个 Subagent 配置生成专家...`;
  const response = await agent.chatWithSystem(systemPrompt, aiPrompt);

  // 3. 解析 JSON 响应
  const config = JSON.parse(response);

  // 4. 验证并应用配置
  setConfig({
    name: config.name,
    description: config.description,
    tools: config.tools,
    color: config.color,
    systemPrompt: config.systemPrompt,
  });
};
```

**ESC 键导航优化**:

```typescript
// 特殊处理: 从 confirm 返回时,AI 模式跳过 aiGenerating 直接回到 aiPrompt
if (currentStep === 'confirm' && workflowType === 'ai') {
  setCurrentStep('aiPrompt');
  return;
}
```

## 关键设计决策

### 1. 为什么不使用 params 字段?

**删除原因**:
- Claude Code 官方不支持 params
- 增加配置复杂度
- 可以在 systemPrompt 中直接说明

**对比**:

```yaml
# ❌ 之前 (复杂)
params:
  directory:
    type: string
    description: Directory to search

# ✅ 现在 (简单)
# systemPrompt 中说明:
When given a directory parameter, use it to scope the search.
```

### 2. 为什么使用 Markdown 正文作为 systemPrompt?

**优点**:
- 支持丰富的格式 (标题、列表、代码块)
- 可读性好,易于编辑
- 与 frontmatter 分离,职责清晰

**示例**:

```markdown
---
name: my-agent
description: ...
---

# My Agent

## Responsibilities
- Task 1
- Task 2

## Workflow
1. Step 1
2. Step 2
```

### 3. 为什么不添加每个 subagent 的示例?

**原因**:
- 不可扩展 - 每个新 subagent 都要修改 task.ts
- 示例会变得很长
- LLM 能从通用示例学习

**解决方案**:
- 保留 2 个通用示例 (Explore, Plan)
- 添加明确的说明: "可以使用任何列出的 agent"
- 依靠 description 中的"Use this when..."引导 LLM

### 4. 为什么使用 useMemo 而非 useState?

**在 AgentsManager 中**:

```typescript
// ❌ 问题: state 不会自动更新
const allAgents = subagentRegistry.getAllSubagents();

// ✅ 解决: 依赖 refreshKey 重新计算
const allAgents = useMemo(() => {
  return subagentRegistry.getAllSubagents();
}, [refreshKey]);
```

**原理**:
- `subagentRegistry` 是全局单例
- 修改配置后需要触发组件重新渲染
- `refreshKey` 变化 → `useMemo` 重新执行 → 获取最新配置

## 文件格式规范

### Subagent 配置文件

**位置**: `.blade/agents/your-agent.md`

**格式**:

```markdown
---
name: your-agent                    # kebab-case, 必需
description: Fast agent specialized for X. Use this when you need to Y.  # 必需
tools:                              # 可选,为空则允许所有工具
  - Read
  - Grep
color: blue                         # 可选
---

# Your Agent

[Markdown content as system prompt]

## Section 1
...

## Section 2
...
```

**验证规则**:

1. **name**: 必需,只能包含小写字母、数字、连字符
2. **description**: 必需,建议包含"Use this when..."
3. **tools**: 可选,值必须是有效工具名称
4. **color**: 可选,值必须是预定义颜色之一
5. **frontmatter**: 必须用`---`包裹
6. **Markdown 正文**: 作为 systemPrompt

## 加载机制

### 初始化加载

**时机**: 应用启动时

**位置**: `src/ui/App.tsx`

```typescript
async initialize() {
  try {
    const loadedCount = subagentRegistry.loadFromStandardLocations();
    if (debug && loadedCount > 0) {
      console.log(`✓ 已加载 ${loadedCount} 个 subagents`);
    }
  } catch (error) {
    console.warn('⚠️ Subagents 加载失败:', error);
  }
}
```

### Agent 创建时加载

**时机**: `Agent.create()` 时

**位置**: `src/agent/Agent.ts`

```typescript
private async loadSubagents() {
  if (subagentRegistry.getAllNames().length > 0) {
    logger.debug('📦 Subagents already loaded');
    return;
  }

  const loadedCount = subagentRegistry.loadFromStandardLocations();
  logger.debug(`✅ Loaded ${loadedCount} subagents`);
}
```

### 热重载

**时机**: `/agents` 命令完成后

**实现**: AgentsManager 中的 `reloadAgents()`

```typescript
const reloadAgents = () => {
  subagentRegistry.clear();                    // 清空现有配置
  subagentRegistry.loadFromStandardLocations(); // 重新加载
  setRefreshKey(prev => prev + 1);             // 触发UI更新
};
```

## 执行流程

### 完整调用链

```
用户输入 "用 code-reviewer 审查代码"
    ↓
Main Agent 处理输入
    ↓
LLM 决定调用 Task 工具
    ↓
Task Tool 验证参数
    ↓
查找 subagent 配置 (SubagentRegistry.getSubagent)
    ↓
创建 SubagentExecutor
    ↓
SubagentExecutor 创建新 Agent 实例
    ↓
应用配置 (systemPrompt, tools)
    ↓
执行任务 (agent.chat)
    ↓
返回结果给 Main Agent
    ↓
Main Agent 整合结果并展示给用户
```

### 工具过滤

**当 subagent 配置了 tools 列表时**:

```typescript
if (this.config.tools && this.config.tools.length > 0) {
  const registry = agent.getToolRegistry();
  const allTools = registry.getAll();

  // 移除不在允许列表中的工具
  for (const tool of allTools) {
    if (!this.config.tools.includes(tool.name)) {
      registry.unregister(tool.name);
    }
  }
}
```

**效果**:
- Subagent 只能调用配置中指定的工具
- 提高执行效率 (减少 LLM token 消耗)
- 避免 subagent 执行不相关操作

## 测试策略

### 单元测试

**测试文件**: `tests/unit/SubagentRegistry.test.ts`

**测试点**:
- 解析 YAML frontmatter
- 验证必需字段
- 加载多个配置文件
- 重复名称检测
- 配置查询

### 集成测试

**测试文件**: `tests/integration/subagents.test.ts`

**测试点**:
- 端到端调用流程
- 工具过滤验证
- 配置热重载
- UI 交互

## 性能考虑

### 1. 配置缓存

- 使用 `Map<string, SubagentConfig>` 存储
- 只在需要时加载(`loadFromStandardLocations`)
- 避免重复解析

### 2. Agent 实例复用

**当前**: 每次调用创建新实例

**优点**:
- 简单、无状态
- 避免状态污染

**缺点**:
- 初始化开销

**未来优化**: Agent 对象池

### 3. 工具注册表过滤

- 移除不需要的工具
- 减少 LLM token 消耗
- 加快工具查找

## 扩展点

### 1. 动态参数

**当前**: 不支持参数

**可能实现**:

```typescript
interface SubagentParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}
```

**用途**: 参数化 subagent 行为

### 2. Subagent 组合

**当前**: 扁平,不支持嵌套

**可能实现**: Subagent 可以调用其他 subagent

**挑战**: 避免无限递归

### 3. 流式输出

**当前**: 等待完整结果

**可能实现**: 实时流式返回 subagent 输出

**用途**: 长时间运行的任务

## 相关文件

### 核心实现
- `src/agent/subagents/types.ts` - 类型定义
- `src/agent/subagents/SubagentRegistry.ts` - 配置管理
- `src/agent/subagents/SubagentExecutor.ts` - 执行器
- `src/tools/builtin/task/task.ts` - Task 工具

### UI 组件
- `src/ui/components/AgentsManager.tsx` - 管理界面
- `src/ui/components/AgentCreationWizard.tsx` - 创建向导

### 配置
- `.blade/agents/explore.md` - Explore subagent
- `.blade/agents/plan.md` - Plan subagent
- `.blade/agents/code-reviewer.md` - Code Reviewer subagent

### 文档
- `docs/public/guides/subagents.md` - 用户文档
- `docs/development/implementation/subagents-system.md` - 本文档
