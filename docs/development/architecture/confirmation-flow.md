# 用户确认流程文档

> **⚠️ 文档部分过时**: 本文档描述的 `requiresConfirmation` 工具字段和 `shouldConfirm()` 方法已被废弃。
>
> **当前实现**: Blade 的确认逻辑完全由权限系统管理（PermissionStage），不再依赖工具自身的确认配置。
>
> - 确认行为由 `settings.json` 中的权限规则控制（allow/ask/deny）
> - 权限模式（DEFAULT/AUTO_EDIT/YOLO）决定自动批准策略
> - 工具不再有 `requiresConfirmation` 字段
>
> 请参考 [权限系统文档](../../public/configuration/permissions.md) 了解当前的确认机制。

## 概述

Blade 实现了一个完整的用户确认流程，用于在执行潜在危险操作前获取用户明确同意。该流程集成在工具执行管道（ExecutionPipeline）中，提供了安全、直观的交互体验。

## 架构

### 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                     ExecutionPipeline                        │
│  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐   │
│  │Discovery│→│Validation│→│Permission│→│ Confirmation  │   │
│  └────────┘ └──────────┘ └──────────┘ └───────────────┘   │
│                                               ↓              │
│                                   ┌───────────────────────┐ │
│                                   │   Execution Stage     │ │
│                                   └───────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                    ↓
        ┌──────────────────────┐
        │  ConfirmationStage   │
        │  ┌────────────────┐  │
        │  │requiresConfirm?│  │
        │  └────────┬───────┘  │
        │           ↓           │
        │  ┌────────────────┐  │
        │  │ Call Handler   │  │
        │  └────────┬───────┘  │
        │           ↓           │
        │  ┌────────────────┐  │
        │  │ Wait Response  │  │
        │  └────────────────┘  │
        └──────────────────────┘
                    ↓
        ┌──────────────────────┐
        │  UI Layer (Ink)      │
        │  ┌────────────────┐  │
        │  │ useConfirmation│  │
        │  └────────┬───────┘  │
        │           ↓           │
        │  ┌────────────────┐  │
        │  │PromptComponent │  │
        │  └────────────────┘  │
        └──────────────────────┘
```

### 数据流

```typescript
// 1. 工具定义时声明需要确认
const dangerousTool: ToolConfig = {
  name: 'delete-files',
  requiresConfirmation: true,
  getConfirmationDetails: (params) => ({
    title: '删除文件',
    message: `即将删除 ${params.count} 个文件`,
    risks: ['此操作不可撤销', '可能丢失重要数据'],
    affectedFiles: params.files,
  }),
  execute: async (params, context) => {
    // 执行删除操作
  },
};

// 2. 执行上下文包含确认处理器
const context: ExecutionContext = {
  workspaceRoot: '/project',
  confirmationHandler: {
    requestConfirmation: async (details) => {
      // UI 层显示确认对话框
      return { approved: true };
    },
  },
};

// 3. Pipeline 自动调用确认流程
await pipeline.execute('delete-files', params, context);
```

## 类型定义

### ConfirmationDetails

```typescript
interface ConfirmationDetails {
  /** 确认标题 */
  title: string;

  /** 确认消息 */
  message: string;

  /** 风险提示列表 */
  risks?: string[];

  /** 受影响的文件列表 */
  affectedFiles?: string[];
}
```

### ConfirmationResponse

```typescript
interface ConfirmationResponse {
  /** 是否批准 */
  approved: boolean;

  /** 拒绝原因（如果未批准） */
  reason?: string;

  /**
   * 授权范围
   * - once: 仅本次执行
   * - session: 记住至项目本地配置（settings.local.json）
   */
  scope?: 'once' | 'session';
}
```

### ConfirmationHandler

```typescript
interface ConfirmationHandler {
  /** 请求用户确认 */
  requestConfirmation(
    details: ConfirmationDetails
  ): Promise<ConfirmationResponse>;
}
```

## UI 实现

### useConfirmation Hook

`useConfirmation` Hook 提供了确认状态管理和处理器实现：

```typescript
const useConfirmation = () => {
  const [confirmationState, setConfirmationState] = useState({
    isVisible: false,
    details: null,
    resolver: null,
  });

  const showConfirmation = (details) => {
    return new Promise((resolve) => {
      setConfirmationState({
        isVisible: true,
        details,
        resolver: resolve,
      });
    });
  };

  const handleResponse = (response) => {
    if (confirmationState.resolver) {
      confirmationState.resolver(response);
    }
    setConfirmationState({
      isVisible: false,
      details: null,
      resolver: null,
    });
  };

  const confirmationHandler = {
    requestConfirmation: showConfirmation,
  };

  return {
    confirmationState,
    confirmationHandler,
    handleResponse,
  };
};
```

### ConfirmationPrompt 组件

显示确认对话框的 Ink 组件：

```typescript
const ConfirmationPrompt: React.FC<Props> = ({ details, onResponse }) => {
  const { isFocused } = useFocus({ autoFocus: true });

  useInput((input, key) => {
    if (!isFocused) return;

    if (key.escape) {
      onResponse({ approved: false, reason: '用户取消' });
      return;
    }

    const normalized = input?.toLowerCase();
    if (normalized === 'y') {
      onResponse({ approved: true, scope: 'once' });
    } else if (normalized === 's' || (key.shift && key.tab)) {
      onResponse({ approved: true, scope: 'session' });
    } else if (normalized === 'n') {
      onResponse({ approved: false, reason: '用户拒绝' });
    }
  });

  const ItemComponent: React.FC<{ label: string; isSelected?: boolean }> = ({
    label,
    isSelected,
  }) => <Text color={isSelected ? 'yellow' : undefined}>{label}</Text>;

  const options = useMemo<
    Array<{ label: string; key: string; value: ConfirmationResponse }>
  >(() => {
    return [
      {
        key: 'approve-once',
        label: '[Y] Yes (once only)',
        value: { approved: true, scope: 'once' },
      },
      {
        key: 'approve-session',
        label: '[S] Yes, remember for this project (Shift+Tab)',
        value: { approved: true, scope: 'session' },
      },
      {
        key: 'reject',
        label: '[N] No',
        value: { approved: false, reason: '用户拒绝' },
      },
    ];
  }, []);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow">
      <Text bold color="yellow">🔔 需要用户确认</Text>
      <Text bold>{details.title}</Text>
      <Text>{details.message}</Text>

      {details.risks && (
        <Box flexDirection="column">
          <Text color="red" bold>⚠️ 风险提示:</Text>
          {details.risks.map((risk, i) => (
            <Text key={i} color="red">• {risk}</Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column">
        <Text color="gray">使用 ↑ ↓ 选择，回车确认（支持 Y / S / N 快捷键，ESC 取消）</Text>
        <SelectInput
          isFocused={isFocused}
          items={options}
          itemComponent={ItemComponent}
          onSelect={(item) => onResponse(item.value)}
        />
      </Box>
    </Box>
  );
};
```

### 集成到 BladeInterface

```typescript
const BladeInterface: React.FC = () => {
  const { confirmationState, confirmationHandler, handleResponse } =
    useConfirmation();

  const { executeCommand } = useCommandHandler(
    systemPrompt,
    confirmationHandler // 传递确认处理器
  );

  return (
    <Box>
      {confirmationState.isVisible && confirmationState.details ? (
        <ConfirmationPrompt
          details={confirmationState.details}
          onResponse={handleResponse}
        />
      ) : (
        <>{/* 正常界面 */}</>
      )}
    </Box>
  );
};
```

## 执行流程

### 1. 工具执行阶段

```typescript
// ExecutionPipeline.execute()
async execute(toolName: string, params: unknown, context: ExecutionContext) {
  // 创建执行实例
  const execution = new ToolExecution(toolName, params, context);

  // 依次执行各个阶段
  for (const stage of this.stages) {
    await stage.process(execution);

    if (execution.shouldAbort()) {
      break;
    }
  }

  return execution.getResult();
}
```

### 2. 确认阶段处理

```typescript
// ConfirmationStage.process()
async process(execution: ToolExecution) {
  const descriptor = execution.getDescriptor();

  // 检查是否需要确认
  if (!descriptor.requiresConfirmation) {
    return; // 跳过确认
  }

  // 检查是否有确认处理器
  const handler = execution.getContext().confirmationHandler;
  if (!handler) {
    return; // 无处理器，直接执行
  }

  // 获取确认详情
  const details = descriptor.getConfirmationDetails?.(
    execution.getParams()
  ) || {
    title: '工具确认',
    message: `即将执行工具: ${descriptor.name}`,
  };

  // 请求用户确认
  const response = await handler.requestConfirmation(details);

  // 处理响应
  if (!response.approved) {
    execution.abort({
      type: ToolErrorType.USER_REJECTED,
      message: response.reason || '用户拒绝执行',
    });
  }
}
```

### 3. UI 响应流程

```typescript
// 用户操作流程:

// 1. Agent 尝试执行需要确认的工具
await agent.chat('删除所有测试文件', context);

// 2. ExecutionPipeline 到达 ConfirmationStage
// → 调用 confirmationHandler.requestConfirmation()

// 3. useConfirmation Hook 更新状态
// → setConfirmationState({ isVisible: true, details, resolver })

// 4. ConfirmationPrompt 组件渲染
// → 显示确认对话框

// 5. 用户选择确认选项
// → 选择“仅此一次允许”: onResponse({ approved: true, scope: 'once' })
// → 选择“本会话允许”: onResponse({ approved: true, scope: 'session' })
// → 选择“拒绝”: onResponse({ approved: false, reason: '用户拒绝' })

// 6. handleResponse 调用 resolver
// → Promise 被 resolve

// 7. ConfirmationStage 继续执行
// → 如果批准: 继续到 ExecutionStage
// → 如果拒绝: 调用 execution.abort()
```

## 授权记忆

- 当用户选择 `scope: 'session'` 时，权限阶段会缓存当前工具调用签名，并将规则追加到 `.blade/settings.local.json`，在当前项目中长期生效。
- 命中缓存时，权限阶段会直接返回允许结果，并附带原因说明，便于日志审计。

## 最佳实践

### 工具开发者

1. **明确标记需要确认的操作**
   ```typescript
   const deleteTool: ToolConfig = {
     name: 'delete',
     requiresConfirmation: true, // 明确声明
     // ...
   };
   ```

2. **提供详细的确认信息**
   ```typescript
   getConfirmationDetails: (params) => ({
     title: '删除文件',
     message: `将删除 ${params.files.length} 个文件`,
     risks: [
       '此操作不可撤销',
       '可能影响项目运行',
     ],
     affectedFiles: params.files,
   })
   ```

3. **处理用户拒绝情况**
   - ExecutionPipeline 会自动中止执行
   - 工具的 `execute` 方法不会被调用
   - 返回适当的错误信息给 LLM

### UI 开发者

1. **清晰的视觉提示**
   - 使用显眼的颜色（黄色边框）
   - 明确的风险警告（红色文字）
   - 易于理解的操作提示

2. **良好的键盘交互**
   - 使用 Ink 的 `useInput` 捕获 ESC 等基础事件
   - 借助 `ink-select-input` 提供箭头选择 + Enter 的确认体验
   - 防止与其他输入冲突

3. **状态管理**
   - 使用 Promise 模式实现同步等待
   - 正确清理状态避免内存泄漏

## 安全考虑

### 默认行为

- **无确认处理器**: 如果执行上下文中没有 `confirmationHandler`，工具仍会执行（向后兼容）
- **建议**: 生产环境应始终提供确认处理器

### 跳过确认

某些场景下可能需要跳过确认：

```typescript
// 批处理模式
const context: ExecutionContext = {
  workspaceRoot: '/project',
  // 不提供 confirmationHandler
  // 或提供自动批准的处理器
  confirmationHandler: {
    requestConfirmation: async () => ({ approved: true }),
  },
};
```

### 审计日志

ExecutionPipeline 会记录所有执行历史，包括确认流程：

```typescript
const history = pipeline.getExecutionHistory();
// 每条记录包含:
// - 工具名称
// - 参数
// - 执行结果
// - 时间戳
```

## 示例场景

### 场景 1: 文件删除

```typescript
// 工具定义
const deleteFilesTool: ToolConfig = {
  name: 'delete-files',
  requiresConfirmation: true,
  getConfirmationDetails: (params) => ({
    title: '删除文件确认',
    message: `即将删除 ${params.paths.length} 个文件`,
    risks: ['此操作不可撤销'],
    affectedFiles: params.paths,
  }),
  execute: async (params) => {
    // 删除文件逻辑
  },
};

// 用户交互
用户: "删除所有 .log 文件"
→ AI 识别需要执行 delete-files 工具
→ 显示确认对话框:
  ┌─────────────────────────────────┐
  │ 🔔 需要用户确认                 │
  │                                 │
  │ 删除文件确认                    │
  │ 即将删除 15 个文件              │
  │                                 │
  │ ⚠️ 风险提示:                    │
  │   • 此操作不可撤销              │
  │                                 │
  │ 📁 影响的文件:                  │
  │   • app.log                     │
  │   • error.log                   │
  │   • debug.log                   │
  │   ...还有 12 个文件             │
  │                                 │
  │ › [Y] Yes (once only)          │
  │   [S] Yes, remember for this project │
  │   [N] No                       │
  └─────────────────────────────────┘
→ 用户通过方向键选择对应项并按回车确认
→ 选择“记住至本项目”会立刻写入 settings.local.json
```

### 场景 2: 网络请求

```typescript
const apiCallTool: ToolConfig = {
  name: 'api-call',
  requiresConfirmation: (params) => {
    // 动态判断是否需要确认
    return params.method !== 'GET'; // POST/PUT/DELETE 需要确认
  },
  getConfirmationDetails: (params) => ({
    title: 'API 请求确认',
    message: `${params.method} ${params.url}`,
    risks: params.method === 'DELETE'
      ? ['将删除服务器上的数据']
      : ['将修改服务器上的数据'],
  }),
  execute: async (params) => {
    // API 调用逻辑
  },
};
```

## 扩展性

### 自定义确认逻辑

可以实现自定义的 `ConfirmationHandler`:

```typescript
class AutoApproveHandler implements ConfirmationHandler {
  private allowedTools: Set<string>;

  constructor(allowedTools: string[]) {
    this.allowedTools = new Set(allowedTools);
  }

  async requestConfirmation(details: ConfirmationDetails) {
    // 自动批准特定工具
    if (this.allowedTools.has(details.toolName)) {
      return { approved: true };
    }

    // 其他工具需要实际确认
    return await showUIConfirmation(details);
  }
}
```

### 多步骤确认

对于复杂操作，可以实现多步骤确认：

```typescript
getConfirmationDetails: async (params) => {
  // 第一步: 分析影响
  const impact = await analyzeImpact(params);

  // 第二步: 生成详细报告
  return {
    title: '复杂操作确认',
    message: '此操作包含多个步骤',
    risks: impact.risks,
    affectedFiles: impact.files,
    metadata: {
      steps: impact.steps,
      estimatedTime: impact.duration,
    },
  };
}
```

## 测试

### 单元测试

```typescript
describe('ConfirmationStage', () => {
  it('should request confirmation for tools that require it', async () => {
    const mockHandler = {
      requestConfirmation: vi.fn().mockResolvedValue({ approved: true }),
    };

    const context = { confirmationHandler: mockHandler };
    const execution = new ToolExecution('dangerous-tool', {}, context);

    const stage = new ConfirmationStage();
    await stage.process(execution);

    expect(mockHandler.requestConfirmation).toHaveBeenCalled();
  });
});
```

### 集成测试

```typescript
describe('Confirmation Flow', () => {
  it('should abort execution when user rejects', async () => {
    const mockHandler = {
      requestConfirmation: vi.fn().mockResolvedValue({
        approved: false,
        reason: '用户拒绝',
      }),
    };

    const context = { confirmationHandler: mockHandler };
    const result = await pipeline.execute('delete-tool', params, context);

    expect(result.success).toBe(false);
    expect(result.error.type).toBe(ToolErrorType.USER_REJECTED);
  });
});
```

## 参考

- [ExecutionPipeline 源码](../src/tools/execution/ExecutionPipeline.ts)
- [ConfirmationStage 源码](../src/tools/execution/PipelineStages.ts)
- [useConfirmation Hook](../src/ui/hooks/useConfirmation.ts)
- [ConfirmationPrompt 组件](../src/ui/components/ConfirmationPrompt.tsx)
- [类型定义](../src/tools/types/)

## 相关文档

- [工具系统架构](./architecture/tool-system.md)
- [执行管道集成](./execution-pipeline-integration-plan.md)
- [权限系统](../guides/configuration/permissions-guide.md)
