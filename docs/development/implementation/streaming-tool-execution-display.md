# 流式工具执行信息显示系统

> 实现类似 Claude Code 的流式工具执行进度显示功能（简化版）

## 目录

- [实现背景](#实现背景)
- [需求分析](#需求分析)
- [技术方案](#技术方案)
- [简化历程](#简化历程)
- [实现细节](#实现细节)
- [测试验证](#测试验证)
- [参考资源](#参考资源)

## 实现背景

### 问题描述

在之前的实现中，Blade 在执行工具时只会在最后显示完整的工具执行结果，用户无法实时看到工具执行的进度。这导致：

1. **缺乏透明度**：用户不知道 Agent 正在做什么
2. **体验不佳**：长时间等待没有任何反馈
3. **信息过载**：最后一次性显示大量信息，难以理解

### 对标分析 - Claude Code

Claude Code 在 auto_edit 模式下采用了流式信息显示模式：

```
• I will create a hello.ts file with the example code

• Write(hello.ts)
  └ Wrote 2 lines to hello.ts

Here's the file I created with a simple hello world example...
```

**显示流程**：
1. **LLM 意图说明**："I will create a hello.ts file..."
2. **工具调用开始**："Write(hello.ts)"
3. **工具执行摘要**："Wrote 2 lines to hello.ts"
4. **LLM 最终总结**："Here's the file I created..."

这种流式显示方式具有以下优势：

- ✅ **实时反馈**：用户可以看到每个步骤的进展
- ✅ **清晰分层**：意图 → 执行 → 结果 → 总结，层次分明
- ✅ **简洁美观**：使用最少的图标，保持界面干净
- ✅ **易于理解**：每个阶段的信息都很简短，易于阅读

### 用户需求

用户明确提出：
- 实现类似 Claude Code 的流式信息显示
- **"不需要太多的图标"** - 保持界面简洁
- 完成后更新文档记录实现背景、调研和方案

## 需求分析

### 功能需求

1. **三阶段信息流**：
   - Phase 1: LLM 意图说明（Assistant thinking）
   - Phase 2: 工具调用开始（Tool start）
   - Phase 3: 工具执行摘要（Tool progress/complete）

2. **消息类型扩展**：
   - 新增 `tool-progress` 消息类型
   - 支持 metadata 驱动的渲染逻辑

3. **工具支持**：
   - 核心工具（Write/Edit/Read/Bash）必须支持 summary 字段
   - 其他工具可选支持

4. **UI 要求**：
   - 最少图标使用（符合用户要求）
   - 清晰的视觉层次
   - 与现有 Markdown 渲染系统兼容

### 非功能需求

1. **性能**：不影响工具执行速度
2. **兼容性**：向后兼容现有 onToolResult 回调
3. **可维护性**：清晰的回调职责分离
4. **可扩展性**：其他工具可轻松添加 summary 支持

## 技术方案

### 架构设计

#### 1. 回调架构

在 `LoopOptions` 中新增三个回调：

```typescript
export interface LoopOptions {
  // 现有回调
  onToolResult?: (toolCall, result) => Promise<ToolResult | void>;

  // 🆕 流式信息显示回调
  onThinking?: (content: string) => void;  // LLM 意图说明
  onToolStart?: (toolCall: ChatCompletionMessageToolCall) => void;  // 工具调用开始
  onToolProgress?: (toolCall, result: ToolResult) => void;  // 工具执行进度
}
```

**职责分离**：
- `onToolResult`：用于详细日志、调试、数据记录
- `onToolProgress`：用于 UI 流式显示（简洁版）

#### 2. 消息类型系统

扩展消息类型和元数据：

```typescript
// 新增消息类型
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'tool-progress';

// 元数据接口
export interface ToolMessageMetadata {
  toolName: string;
  phase: 'start' | 'complete';  // 简化为两个阶段
  summary?: string;  // 工具执行摘要
  params?: Record<string, unknown>;  // 工具参数（可选）
}
```

#### 3. 工具 Summary 字段

每个工具在返回 `ToolResult` 时，在 metadata 中添加 `summary` 字段：

```typescript
// Write 工具示例
metadata.summary = `写入 ${lineCount} 行到 ${fileName}`;

// Edit 工具示例
metadata.summary = `替换 ${replacedCount} 处匹配到 ${fileName}`;

// Read 工具示例
metadata.summary = `读取 ${linesRead} 行从 ${fileName}`;

// Bash 工具示例
metadata.summary = `执行命令成功 (${executionTime}ms): ${cmdPreview}`;
```

#### 4. UI 渲染逻辑

在 `MessageRenderer` 中根据 metadata 控制显示：

```typescript
const getRoleStyle = (role: MessageRole, metadata?: Record<string, unknown>) => {
  switch (role) {
    case 'tool-progress': {
      const phase = metadata && 'phase' in metadata ? metadata.phase : undefined;
      return {
        color: 'blue' as const,
        prefix: phase === 'start' ? '• ' : '  └ '  // 最少图标
      };
    }
    // ...
  }
};
```

### 数据流

```
Agent.chat()
  │
  ├─ LLM 返回内容
  │    └─ onThinking(content)
  │         └─ addAssistantMessage(content)
  │
  ├─ 工具调用开始
  │    └─ onToolStart(toolCall)
  │         └─ addToolProgressMessage({
  │              phase: 'start',
  │              summary: 'Write(hello.ts)'
  │            })
  │
  ├─ 工具执行完成
  │    └─ onToolProgress(toolCall, result)
  │         └─ addToolProgressMessage({
  │              phase: 'complete',
  │              summary: result.metadata.summary
  │            })
  │
  └─ 循环继续或结束
```

## 简化历程

### 初版设计的问题

初版实现存在以下冗余：

1. **双消息类型**：`'tool'` 和 `'tool-progress'` 两种类型
2. **双方法**：`addToolMessage` 和 `addToolProgressMessage` 两个方法
3. **双回调**：`onToolResult` 和 `onToolProgress` 职责重叠

### 简化方案

**核心思路**：统一使用 `'tool'` 消息类型，通过 `metadata.phase` 控制显示样式。

**简化后的设计**：

```typescript
// 1. 统一的消息类型
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';  // 删除 'tool-progress'

// 2. 统一的元数据接口
export interface ToolMessageMetadata {
  toolName: string;
  phase: 'start' | 'complete';
  summary?: string;   // 简短摘要
  detail?: string;    // 详细内容（可选）
  params?: Record<string, unknown>;
}

// 3. 统一的方法
addToolMessage(content: string, metadata?: ToolMessageMetadata)  // 删除 addToolProgressMessage

// 4. 简化的回调（删除 onToolProgress）
onThinking    → LLM 意图说明
onToolStart   → 工具调用开始
onToolResult  → 工具执行完成（显示 summary + 可选的 detail）
```

**关键改进**：

1. **metadata.phase** 控制前缀：
   - `phase: 'start'` → `•` 前缀
   - `phase: 'complete'` → `└` 前缀

2. **metadata.detail** 可选显示详细内容：
   - 根据工具类型和输出长度智能决定是否显示
   - Write 小文件、Edit diff、Bash 短输出会显示
   - Read 等长输出工具不显示

3. **onToolResult** 一次性处理：
   - 显示摘要（summary）
   - 可选显示详情（detail）
   - 不需要单独的 `onToolProgress`

## 实现细节

### 1. SessionContext 更新

**文件**：[src/ui/contexts/SessionContext.tsx](../../../src/ui/contexts/SessionContext.tsx)

新增 `tool-progress` 消息类型和相关方法：

```typescript
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'tool-progress';

export interface ToolMessageMetadata {
  toolName: string;
  phase: 'start' | 'complete';
  summary?: string;
  params?: Record<string, unknown>;
}

const addToolProgressMessage = useCallback((metadata: ToolMessageMetadata) => {
  const message: SessionMessage = {
    id: `tool-progress-${Date.now()}-${Math.random()}`,
    role: 'tool-progress',
    content: metadata.summary || '',
    timestamp: Date.now(),
    metadata,
  };
  dispatch({ type: 'ADD_MESSAGE', payload: message });
}, []);
```

### 2. LoopOptions 扩展

**文件**：[src/agent/types.ts](../../../src/agent/types.ts)

添加三个新回调：

```typescript
export interface LoopOptions {
  // ... 现有字段 ...

  // 🆕 流式信息显示回调（实现 Claude Code 风格的工具执行流）
  onThinking?: (content: string) => void;  // LLM 意图说明
  onToolStart?: (toolCall: ChatCompletionMessageToolCall) => void;  // 工具调用开始
  onToolProgress?: (toolCall: ChatCompletionMessageToolCall, result: ToolResult) => void;  // 工具执行进度
}
```

### 3. Agent 回调触发

**文件**：[src/agent/Agent.ts](../../../src/agent/Agent.ts)

在合适的时机触发回调：

```typescript
// 位置：~line 517 - LLM 返回后
if (turnResult.content && turnResult.content.trim() && options?.onThinking) {
  options.onThinking(turnResult.content);
}

// 位置：~line 602 - 工具执行前
if (options?.onToolStart) {
  options.onToolStart(toolCall);
}

// 位置：~line 706 - 工具执行后
if (options?.onToolProgress) {
  try {
    options.onToolProgress(toolCall, result);
  } catch (error) {
    console.error('[Agent] onToolProgress callback error:', error);
  }
}
```

### 4. useCommandHandler 回调注册

**文件**：[src/ui/hooks/useCommandHandler.ts](../../../src/ui/hooks/useCommandHandler.ts)

添加格式化函数和回调实现：

```typescript
// 工具调用摘要格式化
function formatToolCallSummary(
  toolName: string,
  params: Record<string, unknown>
): string {
  switch (toolName) {
    case 'Write':
      return `Write(${params.file_path || 'file'})`;
    case 'Edit':
      return `Edit(${params.file_path || 'file'})`;
    case 'Read':
      return `Read(${params.file_path || 'file'})`;
    case 'Bash': {
      const cmd = params.command as string;
      return `Bash(${cmd ? cmd.substring(0, 50) : 'command'}${cmd && cmd.length > 50 ? '...' : ''})`;
    }
    default:
      return `${toolName}()`;
  }
}

// loopOptions 配置
const loopOptions = {
  // 🆕 LLM 意图说明
  onThinking: (content: string) => {
    if (content.trim()) {
      addAssistantMessage(content);
    }
  },
  // 🆕 工具调用开始
  onToolStart: (toolCall: any) => {
    try {
      const params = JSON.parse(toolCall.function.arguments);
      const summary = formatToolCallSummary(toolCall.function.name, params);
      addToolProgressMessage({
        toolName: toolCall.function.name,
        phase: 'start',
        summary,
        params,
      });
    } catch (error) {
      console.error('[useCommandHandler] onToolStart error:', error);
    }
  },
  // 🆕 工具执行进度（简洁版）
  onToolProgress: (toolCall: any, result: any) => {
    if (result && result.metadata?.summary) {
      addToolProgressMessage({
        toolName: toolCall.function.name,
        phase: 'complete',
        summary: result.metadata.summary,
      });
    }
  },
};
```

### 5. MessageRenderer 渲染逻辑

**文件**：[src/ui/components/MessageRenderer.tsx](../../../src/ui/components/MessageRenderer.tsx)

更新接口和渲染逻辑：

```typescript
export interface MessageRendererProps {
  content: string;
  role: MessageRole;
  terminalWidth: number;
  metadata?: Record<string, unknown>;  // 🆕
}

const getRoleStyle = (role: MessageRole, metadata?: Record<string, unknown>) => {
  switch (role) {
    case 'tool-progress': {
      // 根据阶段显示不同的前缀（简洁风格，不使用太多图标）
      const phase = metadata && 'phase' in metadata ? (metadata.phase as string) : undefined;
      return {
        color: 'blue' as const,
        prefix: phase === 'start' ? '• ' : '  └ '  // ✅ 符合"不需要太多的图标"要求
      };
    }
    // ...
  }
};

export const MessageRenderer: React.FC<MessageRendererProps> = React.memo(
  ({ content, role, terminalWidth, metadata }) => {
    const blocks = parseMarkdown(content);
    const roleStyle = getRoleStyle(role, metadata);  // 传递 metadata
    // ...
  }
);
```

### 6. 工具 Summary 字段实现

#### Write 工具

**文件**：[src/tools/builtin/file/write.ts](../../../src/tools/builtin/file/write.ts)

```typescript
// 计算写入的行数（仅对文本文件）
const lineCount = encoding === 'utf8' ? content.split('\n').length : 0;
const fileName = file_path.split('/').pop() || file_path;

const metadata: Record<string, any> = {
  // ... 现有字段 ...
  summary: encoding === 'utf8'
    ? `写入 ${lineCount} 行到 ${fileName}`
    : `写入 ${formatFileSize(stats.size)} 到 ${fileName}`,
};
```

#### Edit 工具

**文件**：[src/tools/builtin/file/edit.ts](../../../src/tools/builtin/file/edit.ts)

```typescript
// 生成 summary 用于流式显示
const fileName = file_path.split('/').pop() || file_path;
const summary = replacedCount === 1
  ? `替换 1 处匹配到 ${fileName}`
  : `替换 ${replacedCount} 处匹配到 ${fileName}`;

const metadata: Record<string, any> = {
  // ... 现有字段 ...
  summary, // 🆕 流式显示摘要
};
```

#### Read 工具

**文件**：[src/tools/builtin/file/read.ts](../../../src/tools/builtin/file/read.ts)

```typescript
// 生成 summary 用于流式显示
const fileName = file_path.split('/').pop() || file_path;
const linesRead = metadata.lines_read || metadata.total_lines;
const summary = linesRead
  ? `读取 ${linesRead} 行从 ${fileName}`
  : `读取 ${fileName}`;

metadata.summary = summary;
```

#### Bash 工具

**文件**：[src/tools/builtin/shell/bash.ts](../../../src/tools/builtin/shell/bash.ts)

```typescript
// 正常执行
const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
const summary = code === 0
  ? `执行命令成功 (${executionTime}ms): ${cmdPreview}`
  : `执行命令完成 (退出码 ${code}, ${executionTime}ms): ${cmdPreview}`;

const metadata = {
  // ... 现有字段 ...
  summary, // 🆕 流式显示摘要
};

// 后台执行
const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
const summary = `后台启动命令: ${cmdPreview}`;

const metadata = {
  // ... 现有字段 ...
  summary, // 🆕 流式显示摘要
};
```

### 7. MessageArea 更新

**文件**：[src/ui/components/MessageArea.tsx](../../../src/ui/components/MessageArea.tsx)

传递 metadata 到 MessageRenderer：

```typescript
<MessageRenderer
  key={index}
  content={msg.content}
  role={msg.role}
  terminalWidth={terminalWidth}
  metadata={msg.metadata}  // 🆕 添加 metadata prop
/>
```

## 测试验证

### 测试场景

1. **Write 工具**：创建新文件
   ```
   • I will create a hello.ts file
   • Write(hello.ts)
     └ 写入 2 行到 hello.ts
   Here's the file I created...
   ```

2. **Edit 工具**：替换文件内容
   ```
   • I will update the function name
   • Edit(example.ts)
     └ 替换 3 处匹配到 example.ts
   I've updated all occurrences...
   ```

3. **Read 工具**：读取文件
   ```
   • Let me read the configuration file
   • Read(config.json)
     └ 读取 25 行从 config.json
   The configuration shows...
   ```

4. **Bash 工具**：执行命令
   ```
   • I will run the build command
   • Bash(npm run build)
     └ 执行命令成功 (1230ms): npm run build
   The build completed successfully...
   ```

### 构建验证

```bash
# 构建项目
npm run build

# 输出
Bundled 666 modules in 402ms
blade.js  6.53 MB  (entry point)
```

## 设计决策

### 1. 为什么使用 metadata 驱动？

**决策**：使用 metadata 字段传递阶段和摘要信息，而非创建多个消息类型。

**原因**：
- ✅ 灵活性：可以轻松扩展新的阶段或信息
- ✅ 向后兼容：不影响现有消息类型
- ✅ 减少复杂度：避免创建过多消息类型

### 2. 为什么保留 onToolResult？

**决策**：新增 onToolProgress 而非替换 onToolResult。

**原因**：
- ✅ 职责分离：onToolResult 用于详细日志，onToolProgress 用于 UI 显示
- ✅ 向后兼容：不破坏现有代码
- ✅ 可选支持：调用者可以只使用其中一个

### 3. 为什么只有两个阶段（start/complete）？

**决策**：简化为 start 和 complete，而非 start → progress → complete。

**原因**：
- ✅ 符合用户需求："不需要太多的图标"
- ✅ 大多数工具执行很快：中间进度意义不大
- ✅ 保持界面简洁：减少信息噪音

### 4. 为什么所有核心工具都要支持 summary？

**决策**：Write/Edit/Read/Bash 全部添加 summary 字段。

**原因**：
- ✅ 一致性：所有常用工具体验统一
- ✅ 完整性：覆盖主要使用场景
- ✅ 易维护：有明确的规范可循

## 参考资源

### 相关文档

- [Markdown 渲染系统](markdown-renderer.md) - 消息渲染的基础
- [SessionContext 文档](../architecture/session-management.md) - 会话状态管理
- [Agent 架构](../architecture/agent-system.md) - Agent 设计

### 相关代码

- [src/ui/contexts/SessionContext.tsx](../../../src/ui/contexts/SessionContext.tsx) - 消息状态管理
- [src/agent/types.ts](../../../src/agent/types.ts) - 类型定义
- [src/agent/Agent.ts](../../../src/agent/Agent.ts) - Agent 核心逻辑
- [src/ui/hooks/useCommandHandler.ts](../../../src/ui/hooks/useCommandHandler.ts) - 命令处理
- [src/ui/components/MessageRenderer.tsx](../../../src/ui/components/MessageRenderer.tsx) - 消息渲染

### 外部参考

- Claude Code 的流式信息显示实现（用户提供的截图）
- Aider CLI 工具的 diff 显示方式
- Cline VSCode 扩展的工具执行审批流程

---

## 最终实现总结（简化版）

### 架构概览

**核心设计**：统一使用 `'tool'` 消息类型，通过 `metadata` 控制显示样式和内容。

### 关键组件

1. **消息类型**（`SessionContext.tsx`）：
   ```typescript
   export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

   export interface ToolMessageMetadata {
     toolName: string;
     phase: 'start' | 'complete';
     summary?: string;
     detail?: string;  // 可选的详细内容
     params?: Record<string, unknown>;
   }
   ```

2. **回调系统**（`types.ts`）：
   ```typescript
   export interface LoopOptions {
     onThinking?: (content: string) => void;
     onToolStart?: (toolCall) => void;
     onToolResult?: (toolCall, result: ToolResult) => Promise<ToolResult | void>;
   }
   ```

3. **工具详情策略**（`useCommandHandler.ts`）：
   ```typescript
   function shouldShowToolDetail(toolName: string, result: any): boolean {
     switch (toolName) {
       case 'Write': return (result.metadata?.file_size || 0) < 10000;
       case 'Edit': return true;
       case 'Bash': return (result.metadata?.stdout_length || 0) < 1000;
       case 'Read': return false;
       default: return false;
     }
   }
   ```

4. **渲染逻辑**（`MessageRenderer.tsx`）：
   ```typescript
   // 根据 phase 控制前缀
   prefix: phase === 'start' ? '• ' : phase === 'complete' ? '  └ ' : '  '

   // 处理 detail 字段，递归渲染详细内容
   if (metadata?.detail) {
     return <摘要行 + 缩进的详细内容>;
   }
   ```

### 显示效果

```
• 我将创建 hello.ts 文件

• Write(hello.ts)
  └ 写入 2 行到 hello.ts

  ✅ 成功写入文件: hello.ts (1.2 KB)

  📄 文件内容:

  ```typescript
  console.log('hello');
  ```

文件已创建成功！
```

### 优势

1. **简洁**：只有一个消息类型、一个方法、两个回调
2. **灵活**：通过 metadata 控制样式和内容
3. **智能**：根据工具类型和输出长度决定是否显示详情
4. **一致**：与 Claude Code 的显示效果完全一致

### 修改文件

- `src/ui/contexts/SessionContext.tsx` - 统一 tool 消息类型
- `src/agent/types.ts` - 删除 onToolProgress
- `src/agent/Agent.ts` - 删除 onToolProgress 触发
- `src/ui/hooks/useCommandHandler.ts` - 增强 onToolResult，添加 shouldShowToolDetail
- `src/ui/components/MessageRenderer.tsx` - 支持 detail 字段渲染
