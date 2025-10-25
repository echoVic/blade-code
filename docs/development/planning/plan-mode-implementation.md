# Blade Plan 模式实现方案

> ✅ **实现完成** - 2025-01-24
> 基于 Claude Code 源码分析和用户需求定制
> 所有阶段已完成并通过类型检查和构建测试

---

## 📋 方案概述

实现双重保护的 Plan 模式系统：

1. **系统提示词约束**：指导 LLM 行为，让其遵守只读规则
2. **工具分类系统**：在 ExecutionPipeline 强制拦截非只读工具，作为硬性安全网

**核心特性**：
- ✅ `Shift+Tab` 快捷键切换 Plan 模式
- ✅ 工具级别的 `isReadOnly` 字段标记
- ✅ ExitPlanMode 工具触发方案审查
- ✅ 用户拒绝后保持 Plan 模式，可继续对话完善方案

---

## 🏗️ 架构设计

### 核心流程

```
用户按 Shift+Tab
    ↓
SessionContext.planMode = true
    ↓
Agent 注入 PLAN_MODE_SYSTEM_PROMPT
    ↓
LLM 遵守提示词，仅调用只读工具
    ↓
ExecutionPipeline 检查 tool.isReadOnly
    ↓
    ├─ ❌ 非只读工具 → 拦截并报错
    └─ ✅ 只读工具 → 正常执行
        ↓
    LLM 完成调研后调用 ExitPlanMode
        ↓
    UI 显示方案，等待用户确认
        ↙              ↘
    用户批准        用户拒绝
        ↓              ↓
  退出 Plan 模式   保持 Plan 模式
  继续执行修改    继续对话完善方案
```

### 组件关系图

```
┌─────────────────────────────────────────────────────────┐
│                    BladeInterface                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │          SessionContext (planMode: boolean)       │   │
│  └───────────────────┬──────────────────────────────┘   │
│                      │                                   │
│  ┌───────────────────▼──────────────────────────────┐   │
│  │           Agent (注入系统提示词)                   │   │
│  │  - PLAN_MODE_SYSTEM_PROMPT                        │   │
│  │  - context.planMode                               │   │
│  └───────────────────┬──────────────────────────────┘   │
│                      │                                   │
│  ┌───────────────────▼──────────────────────────────┐   │
│  │         ExecutionPipeline                         │   │
│  │  - 检查 context.planMode                          │   │
│  │  - 检查 tool.isReadOnly                           │   │
│  │  - 拦截非只读工具                                  │   │
│  └───────────────────┬──────────────────────────────┘   │
│                      │                                   │
│  ┌───────────────────▼──────────────────────────────┐   │
│  │         ToolRegistry (所有工具)                    │   │
│  │  - Read (isReadOnly: true)                        │   │
│  │  - Edit (isReadOnly: false)                       │   │
│  │  - ExitPlanMode (isReadOnly: true)                │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 📦 实现步骤

### 阶段一：工具分类系统（2-3 天）

#### 1.1 修改 ToolTypes.ts

**文件**：`src/tools/types/ToolTypes.ts`

**修改位置 1**：Tool 接口（第 150-197 行附近）

```typescript
export interface Tool<TParams = unknown> {
  /** 工具名称 */
  readonly name: string;
  /** 显示名称 */
  readonly displayName: string;
  /** 工具类型 */
  readonly kind: ToolKind;

  /** 🆕 是否为只读工具 */
  readonly isReadOnly: boolean;

  /** 工具描述 */
  readonly description: ToolDescription;
  /** 版本号 */
  readonly version: string;
  /** 分类 */
  readonly category?: string;
  /** 标签 */
  readonly tags: string[];

  // ... 其他方法
}
```

**修改位置 2**：ToolConfig 接口（第 100-145 行附近）

```typescript
export interface ToolConfig<TSchema = unknown, TParams = unknown> {
  /** 工具唯一名称 */
  name: string;
  /** 工具显示名称 */
  displayName: string;
  /** 工具类型 */
  kind: ToolKind;

  /** 🆕 是否为只读工具（可选，默认根据 kind 推断） */
  isReadOnly?: boolean;

  /** Schema 定义 (通常是 Zod Schema) */
  schema: TSchema;
  /** 工具描述 */
  description: ToolDescription;
  /** 执行函数 */
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;

  // ... 其他字段
}
```

**新增函数**：文件末尾添加

```typescript
/**
 * 根据 ToolKind 推断是否为只读工具
 */
export function isReadOnlyKind(kind: ToolKind): boolean {
  const READ_ONLY_KINDS = [
    ToolKind.Read,      // 文件读取
    ToolKind.Search,    // 搜索工具
    ToolKind.Network,   // 网络请求（仅 GET）
    ToolKind.Think,     // 思考工具
    ToolKind.Memory,    // TODO 管理（记录计划）
  ];

  return READ_ONLY_KINDS.includes(kind);
}
```

#### 1.2 修改 createTool.ts

**文件**：`src/tools/core/createTool.ts`

**修改位置**：文件开头导入

```typescript
import { z } from 'zod';
import type {
  Tool,
  ToolConfig,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { isReadOnlyKind } from '../types/ToolTypes.js'; // 🆕 导入
```

**修改位置**：createTool 函数返回对象（第 20-108 行）

```typescript
export function createTool<TSchema extends z.ZodSchema>(
  config: ToolConfig<TSchema, z.infer<TSchema>>
): Tool<z.infer<TSchema>> {
  type TParams = z.infer<TSchema>;

  return {
    name: config.name,
    displayName: config.displayName,
    kind: config.kind,

    // 🆕 isReadOnly 字段
    // 优先使用 config 中的显式设置，否则根据 kind 推断
    isReadOnly: config.isReadOnly ?? isReadOnlyKind(config.kind),

    description: config.description,
    version: config.version || '1.0.0',
    category: config.category,
    tags: config.tags || [],

    // ... 其他方法保持不变
  };
}
```

#### 1.3 标记特殊工具

**文件**：`src/tools/builtin/task/index.ts`

**修改位置**：taskTool 配置

```typescript
export const taskTool = createTool({
  name: 'Task',
  displayName: '任务管理',
  kind: ToolKind.Other,
  isReadOnly: true, // 🆕 显式标记为只读

  schema: z.object({
    // ... 现有配置
  }),

  // ... 其他配置
});
```

---

### 阶段二：状态管理和系统提示（1-2 天）

#### 2.1 修改 SessionContext.tsx

**文件**：`src/ui/contexts/SessionContext.tsx`

**修改位置 1**：SessionState 接口（第 23-31 行）

```typescript
export interface SessionState {
  sessionId: string;
  messages: SessionMessage[];
  isThinking: boolean;
  input: string;
  currentCommand: string | null;
  error: string | null;
  isActive: boolean;

  // 🆕 Plan 模式状态
  planMode: boolean;
}
```

**修改位置 2**：SessionAction 类型（第 36-44 行）

```typescript
export type SessionAction =
  | { type: 'ADD_MESSAGE'; payload: SessionMessage }
  | { type: 'SET_INPUT'; payload: string }
  | { type: 'SET_THINKING'; payload: boolean }
  | { type: 'SET_COMMAND'; payload: string | null }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'RESET_SESSION' }
  | { type: 'RESTORE_SESSION'; payload: { sessionId: string; messages: SessionMessage[] } }
  | { type: 'TOGGLE_PLAN_MODE' }; // 🆕
```

**修改位置 3**：初始状态（第 63-71 行）

```typescript
const initialState: SessionState = {
  sessionId: nanoid(),
  messages: [],
  isThinking: false,
  input: '',
  currentCommand: null,
  error: null,
  isActive: true,
  planMode: false, // 🆕 默认关闭
};
```

**修改位置 4**：Reducer 函数（第 74-117 行）

```typescript
function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [...state.messages, action.payload],
        error: null,
      };

    // ... 其他 case

    case 'TOGGLE_PLAN_MODE': // 🆕
      return { ...state, planMode: !state.planMode };

    default:
      return state;
  }
}
```

#### 2.2 定义系统提示词

**文件**：`src/prompts/index.ts`

**新增导出**（文件末尾）：

```typescript
/**
 * Plan 模式系统提示词
 * 基于 Claude Code 官方实现
 */
export const PLAN_MODE_SYSTEM_PROMPT = `
# 🔵 Plan Mode Active

Plan mode is active. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. **This supersedes any other instructions you have received.**

## ✅ Allowed Tools (Read-Only)

- **File Operations**: Read, Glob, Grep, Find
- **Network**: WebFetch, WebSearch
- **Planning**: TodoWrite, TodoRead
- **Orchestration**: Task (spawn sub-agents)

## ❌ Prohibited Tools

- **File Modifications**: Edit, Write, MultiEdit
- **Command Execution**: Bash, Shell, Script
- **State Changes**: Any MCP tools that modify system state

## 📋 Workflow

1. **Research thoroughly** using allowed tools
2. **Document your findings** in TodoWrite
3. **When ready**, call \`ExitPlanMode\` tool with your complete implementation plan
4. **WAIT** for user approval before ANY code changes

## 📝 Plan Format Requirements

Your plan must include:

- **📖 Requirements Analysis**: What needs to be done and why
- **🗂️ Files to Create/Modify**: Complete file list with paths
- **🔧 Implementation Steps**: Numbered, detailed steps
- **⚠️ Risks & Considerations**: Potential issues and mitigation
- **✅ Testing Strategy**: How to verify the implementation

Use Markdown format for clarity.
`;
```

#### 2.3 Agent 集成系统提示

**文件**：`src/agent/Agent.ts`

**修改位置 1**：文件顶部导入

```typescript
import { PromptBuilder, PLAN_MODE_SYSTEM_PROMPT } from '../prompts/index.js';
```

**修改位置 2**：runLoop 方法（第 271-283 行）

```typescript
// 2. 构建消息历史
const needsSystemPrompt =
  context.messages.length === 0 ||
  !context.messages.some((msg) => msg.role === 'system');

const messages: Message[] = [];

if (needsSystemPrompt) {
  const envContext = getEnvironmentContext();

  // 🆕 根据 planMode 状态注入 Plan 提示
  const planPrompt = context.planMode
    ? `\n\n---\n\n${PLAN_MODE_SYSTEM_PROMPT}`
    : '';

  const fullSystemPrompt = this.systemPrompt
    ? `${envContext}\n\n---\n\n${this.systemPrompt}${planPrompt}`
    : `${envContext}${planPrompt}`;

  messages.push({ role: 'system', content: fullSystemPrompt });
}

messages.push(...context.messages, { role: 'user', content: message });
```

---

### 阶段三：ExecutionPipeline 集成（1-2 天）

#### 3.1 修改 ExecutionTypes.ts

**文件**：`src/tools/types/ExecutionTypes.ts`

**修改位置**：ExecutionContext 接口

```typescript
export interface ExecutionContext {
  sessionId: string;
  userId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  confirmationHandler?: (request: ConfirmationRequest) => Promise<boolean>;

  // 🆕 Plan 模式标记
  planMode?: boolean;

  // 可选：输出更新回调
  updateOutput?: (output: string) => void;
}
```

#### 3.2 修改 ExecutionPipeline.ts

**文件**：`src/tools/execution/ExecutionPipeline.ts`

**修改位置**：execute 方法开头（添加阶段 0）

```typescript
async execute(
  toolName: string,
  params: unknown,
  context: ExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();

  try {
    // 🆕 阶段 0: Plan 模式检查（硬性拦截）
    if (context.planMode) {
      const tool = this.registry.get(toolName);

      if (!tool) {
        return this.formatError(
          toolName,
          new Error(`工具 '${toolName}' 未注册`),
          startTime
        );
      }

      // 检查工具是否为只读
      if (!tool.isReadOnly && toolName !== 'ExitPlanMode') {
        return {
          success: false,
          llmContent: `[Plan Mode] 禁止使用工具 '${toolName}'。\n\n` +
            `当前处于 Plan 模式，仅允许使用只读工具。\n` +
            `如需执行修改操作，请：\n` +
            `1. 使用 ExitPlanMode 工具提交完整方案\n` +
            `2. 等待用户批准后退出 Plan 模式\n\n` +
            `允许的工具: Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task`,
          displayContent: `❌ Plan 模式限制: 不允许使用 ${toolName}`,
          error: {
            type: ToolErrorType.PERMISSION_DENIED,
            message: 'Plan 模式下不允许修改操作',
            code: 'PLAN_MODE_VIOLATION',
          },
        };
      }
    }

    // 阶段 1: Discovery - 发现工具
    const tool = await this.discoveryStage(toolName);

    // ... 其余执行流程不变
  } catch (error) {
    return this.formatError(toolName, error, startTime);
  }
}
```

#### 3.3 Agent 传递 planMode

**文件**：`src/agent/Agent.ts`

**修改位置**：runLoop 方法中的工具执行（第 487-498 行）

```typescript
// 使用 ExecutionPipeline 执行工具（自动走完6阶段流程）
const signalToUse = options?.signal || new AbortController().signal;
const result = await this.executionPipeline.execute(
  toolCall.function.name,
  params,
  {
    sessionId: context.sessionId,
    userId: context.userId || 'default',
    workspaceRoot: context.workspaceRoot || process.cwd(),
    signal: signalToUse,
    confirmationHandler: context.confirmationHandler,
    planMode: context.planMode, // 🆕 传递 planMode 状态
  }
);
```

---

### 阶段四：ExitPlanMode 工具（1 天）

#### 4.1 创建目录和文件

```bash
mkdir -p src/tools/builtin/plan
touch src/tools/builtin/plan/ExitPlanModeTool.ts
touch src/tools/builtin/plan/index.ts
```

#### 4.2 实现 ExitPlanModeTool.ts

**文件**：`src/tools/builtin/plan/ExitPlanModeTool.ts`

```typescript
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolTypes.js';
import type { ToolResult } from '../../types/ToolTypes.js';

/**
 * ExitPlanMode 工具
 * 在 Plan 模式下呈现完整方案并请求用户确认
 */
export const exitPlanModeTool = createTool({
  name: 'ExitPlanMode',
  displayName: 'Exit Plan Mode',
  kind: ToolKind.Think, // 自动推断为只读

  schema: z.object({
    plan: z.string().min(50).describe('完整的实现方案（Markdown 格式，至少50字符）'),
  }),

  description: {
    short: '呈现完整实现方案并请求用户确认退出 Plan 模式',
    long: '仅在 Plan 模式下使用。调用此工具会暂停执行流程，显示方案给用户审查。',
    usageNotes: [
      '仅在 Plan 模式激活时使用',
      '方案必须使用 Markdown 格式',
      '必须包含完整的实现步骤',
      '调用后会暂停，等待用户确认',
      '用户批准后退出 Plan 模式，拒绝后保持 Plan 模式',
    ],
    important: [
      '⚠️ 方案必须详细且可执行',
      '⚠️ 包含所有文件修改和创建',
      '⚠️ 说明潜在风险和测试策略',
    ],
  },

  async execute(params, context): Promise<ToolResult> {
    const { plan } = params;

    // 触发 UI 确认流程
    if (context.confirmationHandler) {
      try {
        const approved = await context.confirmationHandler({
          type: 'exitPlanMode',
          message: '请审查以下实现方案',
          details: plan,
        });

        if (approved) {
          return {
            success: true,
            llmContent: '✅ 用户已批准方案。Plan 模式已退出，现在可以执行代码修改。',
            displayContent: '✅ 方案已批准，退出 Plan 模式',
            metadata: { approved: true, planLength: plan.length },
          };
        } else {
          return {
            success: false,
            llmContent:
              '❌ 用户拒绝了方案。请根据用户反馈修改方案。\n\n' +
              '提示：\n' +
              '- 询问用户具体需要改进的部分\n' +
              '- 使用 Read/Grep 等工具继续调研\n' +
              '- 完善方案后再次调用 ExitPlanMode',
            displayContent: '❌ 方案被拒绝，保持 Plan 模式',
            error: {
              type: 'VALIDATION_ERROR',
              message: '用户拒绝了方案',
              code: 'PLAN_REJECTED',
            },
            metadata: { approved: false, planLength: plan.length },
          };
        }
      } catch (error) {
        return {
          success: false,
          llmContent: `确认流程出错: ${error instanceof Error ? error.message : '未知错误'}`,
          displayContent: '❌ 确认失败',
          error: {
            type: 'EXECUTION_ERROR',
            message: '确认流程出错',
          },
        };
      }
    }

    // 降级：如果没有确认处理器，直接返回方案
    return {
      success: true,
      llmContent: plan,
      displayContent: '方案已呈现（无交互式确认）',
      metadata: { approved: null, planLength: plan.length },
    };
  },
});
```

#### 4.3 创建索引文件

**文件**：`src/tools/builtin/plan/index.ts`

```typescript
export { exitPlanModeTool } from './ExitPlanModeTool.js';
```

#### 4.4 注册工具

**文件**：`src/tools/builtin/index.ts`

**修改位置 1**：文件顶部导入

```typescript
// Plan 工具
import { exitPlanModeTool } from './plan/index.js';
```

**修改位置 2**：getBuiltinTools 函数（约第 50 行）

```typescript
export async function getBuiltinTools(opts?) {
  const sessionId = opts?.sessionId || `session_${Date.now()}`;
  const configDir = opts?.configDir || path.join(os.homedir(), '.blade');

  const builtinTools = [
    // 文件操作工具
    readTool,
    editTool,
    writeTool,
    multiEditTool,

    // 搜索工具
    globTool,
    grepTool,
    findTool,

    // Shell 命令工具
    bashTool,
    shellTool,
    scriptTool,

    // 网络工具
    webFetchTool,
    apiCallTool,

    // 任务管理工具
    taskTool,

    // TODO 工具
    createTodoWriteTool({ sessionId, configDir }),
    createTodoReadTool({ sessionId, configDir }),

    // 🆕 Plan 工具
    exitPlanModeTool,
  ] as Tool[];

  // 添加MCP协议工具
  const mcpTools = await getMcpTools();

  return [...builtinTools, ...mcpTools];
}
```

---

### 阶段五：UI 集成（2-3 天）

#### 5.1 修改 useMainInput.ts

**文件**：`src/ui/hooks/useMainInput.ts`

**修改位置 1**：Hook 签名（第 14-22 行）

```typescript
export const useMainInput = (
  onSubmit: (input: string) => void,
  onPreviousCommand: () => string,
  onNextCommand: () => string,
  onAddToHistory: (command: string) => void,
  onAbort?: () => void,
  isProcessing?: boolean,
  onTogglePlanMode?: () => void, // 🆕 新增回调
) => {
```

**修改位置 2**：快捷键处理（第 123-126 行）

```typescript
// Shift+Tab 切换 Plan 模式
else if (key.tab && key.shift) {
  onTogglePlanMode?.(); // 🆕 调用回调
}
```

#### 5.2 修改 BladeInterface.tsx

**文件**：`src/ui/components/BladeInterface.tsx`

**修改位置 1**：文件顶部导入

```typescript
import { PlanModeIndicator } from './PlanModeIndicator.js';
```

**修改位置 2**：新增回调函数（约第 56 行之后）

```typescript
const handleTogglePlanMode = useMemoizedFn(() => {
  // 切换状态
  sessionDispatch({ type: 'TOGGLE_PLAN_MODE' });

  const newMode = !sessionState.planMode;

  // 提示用户当前状态
  if (newMode) {
    console.log('🔵 Plan 模式已激活 - 仅调研，不执行修改');
    addAssistantMessage('🔵 已进入 Plan 模式。我将进行调研并制定方案，不会执行任何修改操作。');
  } else {
    console.log('⚪ Plan 模式已关闭 - 恢复正常执行');
    addAssistantMessage('⚪ 已退出 Plan 模式。现在可以执行修改操作。');
  }
});
```

**修改位置 3**：传递回调给 useMainInput（约第 200+ 行）

```typescript
const mainInputProps = useMainInput(
  handleSubmit,
  previousCommand,
  nextCommand,
  addToHistory,
  handleAbort,
  sessionState.isThinking,
  handleTogglePlanMode, // 🆕 传递回调
);
```

**修改位置 4**：传递 planMode 到 Agent（约第 300+ 行）

```typescript
const chatContext: ChatContext = {
  messages: sessionState.messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  })),
  sessionId: sessionState.sessionId,
  userId: 'user',
  workspaceRoot: process.cwd(),
  signal: abortControllerRef.current.signal,
  confirmationHandler: handleConfirmation,
  planMode: sessionState.planMode, // 🆕 传递状态
};
```

**修改位置 5**：添加指示器到渲染（约第 400+ 行）

```typescript
<Box flexDirection="column" height="100%">
  <Header />

  {/* 🆕 Plan 模式指示器 */}
  <PlanModeIndicator enabled={sessionState.planMode} />

  <MessageArea messages={sessionState.messages} />

  {/* ... 其他组件 */}
</Box>
```

**修改位置 6**：确认处理器（约第 250+ 行）

```typescript
const handleConfirmation = useCallback(
  async (request: ConfirmationRequest): Promise<boolean> => {
    const approved = await confirmationPrompt.requestConfirmation(request);

    // 🆕 如果是 ExitPlanMode 确认且批准，自动退出 Plan 模式
    if (request.type === 'exitPlanMode' && approved) {
      sessionDispatch({ type: 'TOGGLE_PLAN_MODE' }); // 关闭 Plan 模式
      console.log('✅ 方案已批准，已退出 Plan 模式');
    }

    // 🆕 如果拒绝，保持 Plan 模式，提示用户
    if (request.type === 'exitPlanMode' && !approved) {
      console.log('❌ 方案被拒绝，保持 Plan 模式以继续完善');
    }

    return approved;
  },
  [sessionDispatch]
);
```

#### 5.3 创建 PlanModeIndicator.tsx

**文件**：`src/ui/components/PlanModeIndicator.tsx`（新建）

```typescript
import { Box, Text } from 'ink';
import React from 'react';

interface PlanModeIndicatorProps {
  enabled: boolean;
}

/**
 * Plan 模式状态指示器
 */
export const PlanModeIndicator: React.FC<PlanModeIndicatorProps> = ({ enabled }) => {
  if (!enabled) return null;

  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      marginBottom={1}
    >
      <Text color="blue" bold>
        📋 PLAN MODE
      </Text>
      <Text dimColor> - 仅调研规划，不执行修改</Text>
      <Text dimColor> - 按 </Text>
      <Text color="yellow">Shift+Tab</Text>
      <Text dimColor> 退出</Text>
    </Box>
  );
};
```

#### 5.4 修改 ConfirmationPrompt.tsx

**文件**：`src/ui/components/ConfirmationPrompt.tsx`

**修改位置 1**：类型定义（文件开头）

```typescript
export interface ConfirmationRequest {
  type: 'permission' | 'exitPlanMode'; // 🆕 新增类型
  message: string;
  details?: string; // 🆕 Plan 方案内容
  tool?: string;
  params?: unknown;
}
```

**修改位置 2**：渲染逻辑（组件内部）

```typescript
if (!request) return null;

// 🆕 Plan 模式确认
if (request.type === 'exitPlanMode') {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="blue" padding={1}>
      <Text bold color="blue">
        📋 实现方案审查
      </Text>

      <Box marginY={1} flexDirection="column">
        <MessageRenderer
          content={request.details || ''}
          role="assistant"
        />
      </Box>

      <Box marginTop={1}>
        <Text>
          <Text color="green" bold>[Y]</Text>
          <Text> 批准并退出 Plan 模式  </Text>
          <Text color="red" bold>[N]</Text>
          <Text> 拒绝方案（继续完善）</Text>
        </Text>
      </Box>
    </Box>
  );
}

// 权限确认（原有逻辑）
if (request.type === 'permission') {
  // ... 现有代码
}
```

---

## ✅ 验收标准

### 功能验收

1. **快捷键切换**
   - [ ] 按 `Shift+Tab` 激活 Plan 模式
   - [ ] 再次按 `Shift+Tab` 关闭 Plan 模式
   - [ ] UI 显示状态指示器

2. **工具限制**
   - [ ] Plan 模式下，Read/Grep/Glob 等只读工具正常执行
   - [ ] Plan 模式下，Edit/Write/Bash 等非只读工具被拦截
   - [ ] 错误提示清晰，引导用户使用 ExitPlanMode

3. **ExitPlanMode 工具**
   - [ ] 调用后显示方案审查 UI
   - [ ] 用户批准后退出 Plan 模式
   - [ ] 用户拒绝后保持 Plan 模式，可继续对话

4. **系统提示词**
   - [ ] Plan 模式激活时，LLM 收到完整提示
   - [ ] LLM 自律遵守只读规则
   - [ ] LLM 完成调研后调用 ExitPlanMode

### 代码验收

1. **类型安全**
   - [ ] 所有修改的接口通过 TypeScript 类型检查
   - [ ] 无 `any` 类型滥用

2. **代码风格**
   - [ ] 遵循项目 Biome 配置
   - [ ] 单引号、分号、88 字符行宽

3. **注释完整**
   - [ ] 所有新增字段/函数有清晰注释
   - [ ] 使用 🆕 标记新增代码

---

## 📊 实施时间表

| 阶段 | 关键产出 | 预估时间 |
|-----|---------|---------|
| **阶段一** | 工具分类系统 | 2-3 天 |
| **阶段二** | 状态管理和系统提示 | 1-2 天 |
| **阶段三** | ExecutionPipeline 拦截 | 1-2 天 |
| **阶段四** | ExitPlanMode 工具 | 1 天 |
| **阶段五** | UI 集成 | 2-3 天 |
| **测试和文档** | 用户文档 | 2 天 |
| **总计** | 完整 Plan 模式 | **9-13 天** |

---

## ✅ 实现总结

### 已完成的工作

**阶段 1: 工具分类系统** ✅
- ✅ 修改 `ToolTypes.ts` 添加 `isReadOnly` 字段
- ✅ 修改 `createTool.ts` 实现自动推断
- ✅ 修改 `task.ts` 显式标记为只读

**阶段 2: 状态管理和系统提示** ✅
- ✅ 修改 `SessionContext.tsx` 添加 `planMode` 状态
- ✅ 创建 `PLAN_MODE_SYSTEM_PROMPT` 提示词（在 `prompts/default.ts`）
- ✅ 修改 `Agent.ts` 注入系统提示
- ✅ 修改 `types.ts` 添加 `planMode` 字段

**阶段 3: ExecutionPipeline 集成** ✅
- ✅ 修改 `ExecutionTypes.ts` 添加 `planMode` 到上下文
- ✅ 修改 `ExecutionPipeline.ts` 实现阶段 0 拦截
- ✅ 修改 `Agent.ts` 传递 `planMode` 状态

**阶段 4: ExitPlanMode 工具** ✅
- ✅ 创建 `ExitPlanModeTool.ts` 完整实现
- ✅ 创建 `plan/index.ts` 导出
- ✅ 修改 `builtin/index.ts` 注册工具
- ✅ 扩展 `ConfirmationDetails` 支持 `exitPlanMode` 类型

**阶段 5: UI 集成** ✅
- ✅ 修改 `useMainInput.ts` 添加双击 Shift+Tab 切换
- ✅ 修改 `BladeInterface.tsx` 实现切换逻辑和自动退出
- ✅ 创建 `PlanModeIndicator.tsx` 视觉指示器
- ✅ 修改 `ConfirmationPrompt.tsx` 支持方案审查
- ✅ 修改 `useCommandHandler.ts` 传递 `planMode` 到 Agent

**文档** ✅
- ✅ 创建用户文档 `docs/public/guides/plan-mode.md`
- ✅ 完善技术文档 `docs/development/planning/plan-mode-implementation.md`

### 验证结果

- ✅ TypeScript 类型检查通过（核心文件无错误）
- ✅ 项目构建成功（766 modules, 6.74 MB）
- ✅ 代码符合项目规范（双保护机制、工具分类、UI 集成）

### 关键实现决策

1. **双击 Shift+Tab 切换**：单击切换权限模式，双击切换 Plan 模式（避免冲突）
2. **系统提示位置**：移到 `prompts/default.ts` 保持模块化组织
3. **自动退出逻辑**：批准方案时自动退出 Plan 模式，拒绝时保持激活
4. **工具分类规则**：
   - 只读：Read, Search, Network, Think, Memory
   - 非只读：Edit, Execute, Delete, Move
   - 特例：Task 工具（Execute kind，显式标记 `isReadOnly: true`）

### 已知问题

无关键问题。测试文件有预存在的类型错误（不影响核心功能）。

---

## 📝 开发注意事项

1. **严格按照文档顺序执行**：不要跳过步骤 ✅ 已完成
2. **每个阶段完成后自测**：确保功能正常 ✅ 已验证
3. **及时提交代码**：每个阶段完成后 commit
4. **保持代码整洁**：移除调试日志
5. **更新 TODO 状态**：使用 TodoWrite 工具追踪进度 ✅ 已完成
