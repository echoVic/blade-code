# 执行管道架构

Blade 实现了一个 6 阶段的工具执行管道（ExecutionPipeline），参考 Claude Code 的设计理念，提供完整的工具执行生命周期管理。

## 概述

ExecutionPipeline 负责协调工具的发现、验证、权限检查、用户确认、执行和结果格式化。所有工具调用都必须通过这个管道，确保安全性和一致性。

## 6 阶段架构

```
┌────────────────────────────────────────────────────────────────┐
│                    ExecutionPipeline.execute()                  │
└────────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────┐
        │  1. Discovery Stage (工具发现)          │
        │  - 从 ToolRegistry 查找工具              │
        │  - 验证工具是否存在                      │
        │  - 构建工具调用实例                      │
        └────────────┬────────────────────────────┘
                     ↓
        ┌─────────────────────────────────────────┐
        │  2. Validation Stage (参数验证)         │
        │  - 验证必需参数是否存在                  │
        │  - 检查参数类型                          │
        │  - 应用参数转换                          │
        └────────────┬────────────────────────────┘
                     ↓
        ┌─────────────────────────────────────────┐
        │  3. Permission Stage (权限检查)         │
        │  - PermissionChecker.check()            │
        │  - 检查 deny 规则 → 直接拒绝             │
        │  - 检查 allow 规则 → 直接通过            │
        │  - 检查 ask 规则 → 标记需要确认          │
        └────────────┬────────────────────────────┘
                     ↓
        ┌─────────────────────────────────────────┐
        │  4. Confirmation Stage (用户确认)       │
        │  - 如果需要确认，暂停执行                │
        │  - 调用 ConfirmationHandler             │
        │  - 等待用户响应                          │
        │  - 批准 → 继续 / 拒绝 → 中止             │
        └────────────┬────────────────────────────┘
                     ↓
        ┌─────────────────────────────────────────┐
        │  5. Execution Stage (实际执行)          │
        │  - 调用工具的 execute() 方法             │
        │  - 捕获执行异常                          │
        │  - 处理执行超时                          │
        └────────────┬────────────────────────────┘
                     ↓
        ┌─────────────────────────────────────────┐
        │  6. Formatting Stage (结果格式化)       │
        │  - 格式化工具结果                        │
        │  - 分离 LLM 内容和显示内容               │
        │  - 构建最终 ToolResult                   │
        └─────────────────────────────────────────┘
                     ↓
                ToolResult
```

## 核心组件

### ExecutionPipeline

主执行管道类，位于 [src/tools/execution/ExecutionPipeline.ts](../../src/tools/execution/ExecutionPipeline.ts)

```typescript
export class ExecutionPipeline extends EventEmitter {
  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {}
  )

  async execute(
    toolName: string,
    params: unknown,
    context: ExecutionContext
  ): Promise<ToolResult>

  getExecutionHistory(): ExecutionHistoryEntry[]
  clearHistory(): void
}
```

**配置选项:**

```typescript
interface ExecutionPipelineConfig {
  maxHistorySize?: number;          // 最大历史记录数
  enableMetrics?: boolean;           // 启用性能指标
  permissionConfig?: PermissionConfig; // 权限配置
  customStages?: PipelineStage[];   // 自定义阶段
}
```

### PipelineStage

所有阶段都实现 `PipelineStage` 接口:

```typescript
interface PipelineStage {
  name: string;
  process(execution: ToolExecution): Promise<void>;
}
```

### ToolExecution

执行上下文对象，在各阶段之间传递:

```typescript
class ToolExecution {
  constructor(
    public toolName: string,
    public params: unknown,
    public context: ExecutionContext
  )

  abort(error: ToolError): void
  shouldAbort(): boolean
  getResult(): ToolResult
}
```

## 各阶段详解

### 1. Discovery Stage (工具发现)

**职责:** 从 ToolRegistry 查找并加载工具

```typescript
export class DiscoveryStage implements PipelineStage {
  readonly name = 'discovery';

  constructor(private registry: ToolRegistry) {}

  async process(execution: ToolExecution): Promise<void> {
    const tool = this.registry.get(execution.toolName);

    if (!tool) {
      execution.abort({
        type: ToolErrorType.NOT_FOUND,
        message: `工具 "${execution.toolName}" 未找到`,
      });
      return;
    }

    // 将工具实例附加到执行上下文
    (execution as any).tool = tool;
  }
}
```

**失败场景:**
- 工具不存在
- 工具已被禁用

### 2. Validation Stage (参数验证)

**职责:** 验证和转换工具参数

```typescript
export class ValidationStage implements PipelineStage {
  readonly name = 'validation';

  async process(execution: ToolExecution): Promise<void> {
    const tool = (execution as any).tool;
    const descriptor = tool.descriptor;

    // 验证必需参数
    for (const param of descriptor.parameters) {
      if (param.required && !(param.name in execution.params)) {
        execution.abort({
          type: ToolErrorType.INVALID_PARAMS,
          message: `缺少必需参数: ${param.name}`,
        });
        return;
      }
    }

    // 构建工具调用
    const invocation = tool.build(execution.params);
    (execution as any).invocation = invocation;
  }
}
```

**验证内容:**
- 必需参数检查
- 参数类型验证
- 参数值范围检查
- 参数转换和默认值

### 3. Permission Stage (权限检查)

**职责:** 检查工具执行权限

```typescript
export class PermissionStage implements PipelineStage {
  readonly name = 'permission';

  constructor(private permissionConfig: PermissionConfig) {}

  async process(execution: ToolExecution): Promise<void> {
    const checker = new PermissionChecker(this.permissionConfig);

    const descriptor: ToolInvocationDescriptor = {
      toolName: execution.toolName,
      params: execution.params as Record<string, unknown>,
    };

    const result = checker.check(descriptor);

    // 保存检查结果
    (execution as any).permissionCheckResult = result;

    if (result.result === PermissionResult.DENY) {
      execution.abort({
        type: ToolErrorType.PERMISSION_DENIED,
        message: result.reason || '权限被拒绝',
      });
      return;
    }

    if (result.result === PermissionResult.ASK) {
      // 标记需要用户确认
      (execution as any).needsConfirmation = true;
      (execution as any).confirmationReason = result.reason;
    }
  }
}
```

**权限级别:**
- `DENY` - 直接中止执行
- `ALLOW` - 继续下一阶段
- `ASK` - 标记需要确认

### 4. Confirmation Stage (用户确认)

**职责:** 请求用户确认

```typescript
export class ConfirmationStage implements PipelineStage {
  readonly name = 'confirmation';

  async process(execution: ToolExecution): Promise<void> {
    if (!(execution as any).needsConfirmation) {
      return; // 不需要确认
    }

    const handler = execution.context.confirmationHandler;
    if (!handler) {
      // 无确认处理器，记录警告后继续
      console.warn('需要确认但未配置确认处理器');
      return;
    }

    // 构建确认请求
    const details: ConfirmationDetails = {
      title: `执行工具: ${execution.toolName}`,
      message: (execution as any).confirmationReason || '需要用户确认',
      toolName: execution.toolName,
      params: execution.params,
    };

    // 请求用户确认
    const response = await handler.requestConfirmation(details);

    if (!response.approved) {
      execution.abort({
        type: ToolErrorType.USER_REJECTED,
        message: response.reason || '用户拒绝执行',
      });
    }
  }
}
```

**确认流程:**
1. 检查是否需要确认
2. 调用 `confirmationHandler.requestConfirmation()`
3. UI 显示确认提示（ConfirmationPrompt 组件）
4. 等待用户响应
5. 批准 → 继续执行 / 拒绝 → 中止

### 5. Execution Stage (实际执行)

**职责:** 执行工具逻辑

```typescript
export class ExecutionStage implements PipelineStage {
  readonly name = 'execution';

  async process(execution: ToolExecution): Promise<void> {
    const invocation = (execution as any).invocation;

    try {
      // 执行工具
      const result = await invocation.execute(
        execution.context.signal || new AbortController().signal
      );

      // 保存结果
      (execution as any).rawResult = result;
    } catch (error) {
      execution.abort({
        type: ToolErrorType.EXECUTION_FAILED,
        message: error.message,
        originalError: error,
      });
    }
  }
}
```

**异常处理:**
- 执行超时
- 工具内部错误
- 中断信号（AbortSignal）
- 资源不可用

### 6. Formatting Stage (结果格式化)

**职责:** 格式化工具执行结果

```typescript
export class FormattingStage implements PipelineStage {
  readonly name = 'formatting';

  async process(execution: ToolExecution): Promise<void> {
    const rawResult = (execution as any).rawResult;

    if (!rawResult) {
      return; // 已经中止
    }

    // 格式化结果
    const formattedResult: ToolResult = {
      success: rawResult.success,
      llmContent: rawResult.llmContent || rawResult.content,
      displayContent: rawResult.displayContent || rawResult.content,
      error: rawResult.error,
      metadata: {
        ...rawResult.metadata,
        executionTime: Date.now() - (execution as any).startTime,
      },
    };

    (execution as any).result = formattedResult;
  }
}
```

**格式化内容:**
- 分离 LLM 内容和显示内容
- 添加执行元数据
- 标准化错误格式
- 截断过长的输出

## 事件系统

ExecutionPipeline 继承自 EventEmitter，支持监听各阶段事件:

```typescript
pipeline.on('executionStarted', (data) => {
  console.log(`开始执行: ${data.toolName}`);
});

pipeline.on('stageStarted', (data) => {
  console.log(`阶段开始: ${data.stageName}`);
});

pipeline.on('stageCompleted', (data) => {
  console.log(`阶段完成: ${data.stageName}`);
});

pipeline.on('executionCompleted', (data) => {
  console.log(`执行完成: ${data.toolName}`, data.result);
});

pipeline.on('executionFailed', (data) => {
  console.error(`执行失败: ${data.toolName}`, data.error);
});
```

**可用事件:**
- `executionStarted` - 执行开始
- `stageStarted` - 阶段开始
- `stageCompleted` - 阶段完成
- `executionCompleted` - 执行成功完成
- `executionFailed` - 执行失败
- `executionAborted` - 执行被中止

## 执行历史

ExecutionPipeline 自动记录所有执行历史:

```typescript
interface ExecutionHistoryEntry {
  executionId: string;
  toolName: string;
  params: unknown;
  result: ToolResult;
  timestamp: number;
  duration: number;
  stages: {
    name: string;
    startTime: number;
    endTime: number;
  }[];
}

// 获取历史记录
const history = pipeline.getExecutionHistory();

// 清理历史记录
pipeline.clearHistory();
```

**用途:**
- 调试工具执行问题
- 性能分析
- 审计日志
- 重放执行

## 与 Agent 集成

ExecutionPipeline 集成在 Agent 的工具执行流程中:

```typescript
// Agent.ts
export class Agent {
  private executionPipeline: ExecutionPipeline;

  constructor(
    config: AgentConfig,
    executionPipeline?: ExecutionPipeline
  ) {
    this.executionPipeline = executionPipeline ||
      this.createDefaultPipeline(config);
  }

  private createDefaultPipeline(config: AgentConfig): ExecutionPipeline {
    const registry = new ToolRegistry();
    return new ExecutionPipeline(registry, {
      permissionConfig: config.permissions,
      maxHistorySize: 1000,
    });
  }

  async runLoop(options?: RunLoopOptions): Promise<LoopResult> {
    // ... 获取 LLM 响应 ...

    // 执行工具调用
    for (const toolCall of turnResult.toolCalls) {
      const result = await this.executionPipeline.execute(
        toolCall.function.name,
        JSON.parse(toolCall.function.arguments),
        {
          sessionId: this.sessionId,
          signal: options?.signal,
          confirmationHandler: this.confirmationHandler,
        }
      );

      // 将结果添加到消息历史
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: this.formatToolResult(result),
      });
    }
  }
}
```

## 自定义扩展

### 添加自定义阶段

可以在管道中插入自定义阶段:

```typescript
class CustomStage implements PipelineStage {
  readonly name = 'custom';

  async process(execution: ToolExecution): Promise<void> {
    // 自定义处理逻辑
    console.log('执行自定义阶段');
  }
}

const pipeline = new ExecutionPipeline(registry, {
  customStages: [
    new DiscoveryStage(registry),
    new ValidationStage(),
    new CustomStage(), // 插入自定义阶段
    new PermissionStage(permissionConfig),
    new ConfirmationStage(),
    new ExecutionStage(),
    new FormattingStage(),
  ],
});
```

### 自定义权限检查

可以实现自定义的权限检查逻辑:

```typescript
class CustomPermissionStage implements PipelineStage {
  readonly name = 'permission';

  async process(execution: ToolExecution): Promise<void> {
    // 自定义权限检查逻辑
    const allowed = await this.customCheck(execution);

    if (!allowed) {
      execution.abort({
        type: ToolErrorType.PERMISSION_DENIED,
        message: '自定义权限检查失败',
      });
    }
  }

  private async customCheck(execution: ToolExecution): Promise<boolean> {
    // 实现自定义逻辑
    return true;
  }
}
```

## 性能考虑

### 阶段开销

典型工具执行的各阶段耗时:

| 阶段 | 平均耗时 | 说明 |
|------|---------|------|
| Discovery | 1-2ms | 工具查找 |
| Validation | 2-5ms | 参数验证 |
| Permission | 3-10ms | 权限检查（含 glob 匹配） |
| Confirmation | 0ms 或等待用户 | 如需确认则等待 |
| Execution | 取决于工具 | 实际工具执行时间 |
| Formatting | 1-3ms | 结果格式化 |

**总开销:** ~10-20ms (不含 Confirmation 和 Execution)

### 优化建议

1. **权限配置优化**
   - 优先使用 `allow` 规则避免确认
   - 减少复杂的 glob 模式
   - 使用精确匹配而非通配符

2. **历史记录管理**
   - 定期清理历史记录
   - 设置合理的 `maxHistorySize`
   - 禁用不需要的历史记录

3. **事件监听**
   - 避免在事件监听器中执行耗时操作
   - 使用异步事件处理
   - 限制事件监听器数量

## 错误处理

ExecutionPipeline 提供完整的错误处理机制:

```typescript
// 执行可能返回的错误类型
enum ToolErrorType {
  NOT_FOUND = 'not_found',           // 工具不存在
  INVALID_PARAMS = 'invalid_params', // 参数无效
  PERMISSION_DENIED = 'permission_denied', // 权限被拒绝
  USER_REJECTED = 'user_rejected',   // 用户拒绝
  EXECUTION_FAILED = 'execution_failed', // 执行失败
  TIMEOUT = 'timeout',               // 执行超时
}

// 错误结果示例
const result: ToolResult = {
  success: false,
  error: {
    type: ToolErrorType.PERMISSION_DENIED,
    message: '工具调用被拒绝规则阻止: Read(file_path:.env)',
    stage: 'permission',
  },
};
```

## 测试

### 单元测试

每个阶段都有独立的单元测试:

```typescript
describe('PermissionStage', () => {
  it('should deny execution for denied tools', async () => {
    const config = {
      allow: [],
      ask: [],
      deny: ['Read(file_path:.env)'],
    };

    const stage = new PermissionStage(config);
    const execution = new ToolExecution('Read', { file_path: '.env' }, {});

    await stage.process(execution);

    expect(execution.shouldAbort()).toBe(true);
  });
});
```

### 集成测试

测试完整的管道执行流程:

```typescript
describe('ExecutionPipeline', () => {
  it('should execute tool through all stages', async () => {
    const result = await pipeline.execute(
      'Read',
      { file_path: 'test.txt' },
      context
    );

    expect(result.success).toBe(true);
  });

  it('should request confirmation for ask rules', async () => {
    const mockHandler = {
      requestConfirmation: vi.fn().mockResolvedValue({ approved: true }),
    };

    const result = await pipeline.execute(
      'Write',
      { file_path: 'test.txt', content: 'hello' },
      { confirmationHandler: mockHandler }
    );

    expect(mockHandler.requestConfirmation).toHaveBeenCalled();
  });
});
```

## 相关文档

- [权限系统指南](../guides/configuration/permissions-guide.md) - 了解权限配置
- [用户确认流程](../confirmation-flow.md) - 了解确认机制
- [配置系统](../guides/configuration/config-system.md) - 配置管理
- [工具系统架构](../architecture/tool-system.md) - 工具系统总览

## 相关代码

- [src/tools/execution/ExecutionPipeline.ts](../../src/tools/execution/ExecutionPipeline.ts) - 执行管道实现
- [src/tools/execution/PipelineStages.ts](../../src/tools/execution/PipelineStages.ts) - 各阶段实现
- [src/tools/types/ExecutionTypes.ts](../../src/tools/types/ExecutionTypes.ts) - 执行相关类型
- [tests/unit/tools/execution/](../../tests/unit/tools/execution/) - 单元测试
