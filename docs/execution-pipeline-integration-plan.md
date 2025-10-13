# 🏗️ 方案 B: 深度重构 - ExecutionPipeline 集成完整实施计划

## 📊 主流 CLI Agent 用户确认模式调研总结

### 1. **Claude Code** (规则 + Auto-Accept)
- **3 种模式**: Normal (需确认) / Auto-Accept (自动通过) / Plan Mode (只读)
- **配置式权限**: `settings.json` 的 `allow/ask/deny` 规则
- **YOLO 标志**: `--dangerously-skip-permissions` 跳过所有确认
- **无模态对话框**: 通过配置和命令行参数控制

### 2. **GitHub Copilot CLI** (分层确认)
- **目录信任确认**: 首次启动时确认信任目录
- **工具级别确认**:
  - 选项 1: 允许一次 (Allow once)
  - 选项 2: 允许此会话 (Allow this session)
  - 选项 3: 拒绝并提供反馈 (Decline with feedback)
- **自动批准标志**: `--allow-all-tools`, `--allow-tool`, `--deny-tool`
- **Glob 模式支持**: `shell(npm run test:*)` 允许特定命令模式

### 3. **Gemini CLI** (简单 Y/N)
- **标准确认**: "Shall I proceed? [Y/n]"
- **YOLO 模式**: `--yolo` 或 `Ctrl+Y` 跳过所有确认
- **持久化选项**: "Yes, allow always" (但有 bug,不持久)
- **已知问题**: 自动批准而不等待用户输入

### 4. **Open Interpreter** (每次询问)
- **默认行为**: 每次执行前询问用户确认
- **自动运行**: `-y` 标志或 `interpreter.auto_run = True`
- **Docker 沙箱**: 推荐在隔离环境中运行
- **安全警告**: 明确提示风险

### 5. **CLI 确认最佳实践**
✅ **使用大写表示默认**: `[Y/n]` = 默认 Yes, `[y/N]` = 默认 No
✅ **支持单键确认**: 不需要按 Enter
✅ **危险操作默认 No**: 如删除文件用 `[y/N]`
✅ **明确检查肯定响应**: 检查 "yes"/"y" 而不是否定逻辑
✅ **提供上下文信息**: 显示将要执行的操作详情

---

## 🎯 Blade 的用户确认实现方案

### 核心设计: **规则优先 + 内联确认 + 无模态弹窗**

**参考对象**: Claude Code + GitHub Copilot CLI
**实现方式**: Ink 的 SelectInput 实现内联选择,不打断 UI 流程

---

## 📐 架构设计

### 1. 配置优先级 (完全符合 Claude Code)

```
┌─────────────────────────────────┐
│   settings.json (权限配置)        │
│   - allow: []                    │
│   - ask: []                      │
│   - deny: []                     │
└─────────────────────────────────┘
         ↓
┌─────────────────────────────────┐
│   CLI 参数 (覆盖配置)             │
│   --dangerously-skip-permissions │
│   --allow-tool "Bash(*)"         │
│   --deny-tool "Read(.env)"       │
└─────────────────────────────────┘
         ↓
┌─────────────────────────────────┐
│   运行时内联确认                  │
│   [1] Allow once                 │
│   [2] Allow this session         │
│   [3] Allow always (save)        │
│   [4] Deny                       │
└─────────────────────────────────┘
```

### 2. 执行流程架构

```
Agent.runLoop()
  ↓
  for toolCall in toolCalls:
    ↓
    ExecutionPipeline.execute(toolName, params, context)
      ↓
      ┌───────────────────────────────┐
      │ 1. DiscoveryStage             │ → 查找工具
      ├───────────────────────────────┤
      │ 2. ValidationStage            │ → 验证参数
      ├───────────────────────────────┤
      │ 3. PermissionStage            │ → 检查权限规则
      │    - allow → 直接通过          │
      │    - deny → 立即拒绝           │
      │    - ask → 标记需要确认        │
      ├───────────────────────────────┤
      │ 4. ConfirmationStage          │ ← 🎯 关键实现
      │    检测 needsConfirmation      │
      │    ↓                          │
      │    调用 ConfirmationHandler    │
      │    ↓                          │
      │    暂停并等待用户选择          │
      │    ↓                          │
      │    返回 confirmed: boolean     │
      ├───────────────────────────────┤
      │ 5. ExecutionStage             │ → 执行工具
      ├───────────────────────────────┤
      │ 6. FormattingStage            │ → 格式化结果
      └───────────────────────────────┘
    ↓
    result → 注入到 messages
```

---

## 🔧 实施计划 (分 6 个阶段)

### Phase 1: 扩展 Agent 类型系统 ✅

**文件**: `src/agent/types.ts`

**改动**:
```typescript
export interface AgentConfig {
  chat: ChatConfig;
  systemPrompt?: string;
  permissions?: PermissionConfig; // ← 新增权限配置
  // ... 其他配置保持不变
}
```

**预估**: 5 分钟

---

### Phase 2: Agent 构造函数重构 🔄

**文件**: `src/agent/Agent.ts`

#### 2.1 修改构造函数
```typescript
export class Agent extends EventEmitter {
  private config: AgentConfig;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private executionPipeline!: ExecutionPipeline; // ← 替换 toolRegistry
  private sessionId: string;

  // 核心组件
  private chatService!: ChatService;
  private executionEngine!: ExecutionEngine;
  private promptBuilder!: PromptBuilder;
  private loopDetector!: LoopDetectionService;

  constructor(
    config: AgentConfig,
    executionPipeline?: ExecutionPipeline, // ← 支持依赖注入
    sessionId?: string
  ) {
    super();
    this.config = config;
    this.executionPipeline = executionPipeline || this.createDefaultPipeline(config);
    this.sessionId = sessionId || `session_${Date.now()}_${...}`;
  }

  private createDefaultPipeline(config: AgentConfig): ExecutionPipeline {
    const registry = new ToolRegistry();
    return new ExecutionPipeline(registry, {
      permissionConfig: config.permissions || DEFAULT_CONFIG.permissions,
      maxHistorySize: 1000,
    });
  }
}
```

#### 2.2 修改 Agent.buildConfig()
```typescript
private static async buildConfig(options: AgentOptions): Promise<AgentConfig> {
  // 获取全局配置
  let globalConfig;
  try {
    const configManager = new ConfigManager();
    await configManager.initialize();
    globalConfig = configManager.getConfig();
  } catch (_error) {
    console.warn('获取全局配置失败，使用默认值');
    globalConfig = null;
  }

  // ... 现有的 API key/model 配置 ...

  return {
    chat: {
      apiKey,
      baseUrl,
      model,
      temperature,
      maxTokens,
    },
    systemPrompt: options.systemPrompt,
    permissions: globalConfig?.permissions || DEFAULT_CONFIG.permissions, // ← 新增
  };
}
```

**预估**: 30 分钟

---

### Phase 3: 简化 Agent.initialize() 🎯

**文件**: `src/agent/Agent.ts`

```typescript
public async initialize(): Promise<void> {
  if (this.isInitialized) {
    return;
  }

  try {
    this.log('初始化Agent...');

    // 1. 初始化系统提示
    await this.initializeSystemPrompt();

    // 2. 注册内置工具 ← 委托给 Pipeline
    const builtinTools = await getBuiltinTools();
    this.executionPipeline.registerAllTools(builtinTools);

    // 3. 初始化核心组件
    this.chatService = new ChatService(this.config.chat);
    this.executionEngine = new ExecutionEngine(this.chatService, this.config);

    // 4. 初始化循环检测服务
    const loopConfig: LoopDetectionConfig = {
      toolCallThreshold: 5,
      contentRepeatThreshold: 10,
      llmCheckInterval: 30,
    };
    this.loopDetector = new LoopDetectionService(loopConfig);

    // 5. 监听 Pipeline 事件并转发 ← 新增
    this.setupPipelineEventListeners();

    this.isInitialized = true;
    this.log(`Agent初始化完成，已加载 ${this.executionPipeline.getToolCount()} 个工具`);
    this.emit('initialized');
  } catch (error) {
    this.error('Agent初始化失败', error);
    throw error;
  }
}

private setupPipelineEventListeners(): void {
  // 将 Pipeline 的事件转发给 Agent 的监听器
  this.executionPipeline.on('executionStarted', (data) =>
    this.emit('toolExecutionStart', {
      tool: data.toolName,
      turn: 0, // 可以从 context 获取
    })
  );

  this.executionPipeline.on('executionCompleted', (data) =>
    this.emit('toolExecutionComplete', {
      tool: data.toolName,
      success: data.result.success,
      turn: 0,
    })
  );

  // 新增: 权限确认请求事件
  this.executionPipeline.on('confirmationRequired', (data) =>
    this.emit('confirmationRequired', data)
  );
}
```

**预估**: 20 分钟

---

### Phase 4: 重构 Agent.runLoop() 工具执行 🚀

**文件**: `src/agent/Agent.ts` (343-429 行)

**当前代码** (100+ 行):
```typescript
for (const toolCall of turnResult.toolCalls) {
  if (toolCall.type !== 'function') continue;

  // 检查中断
  if (options?.signal?.aborted) { ... }

  try {
    // 触发工具执行开始事件
    this.emit('toolExecutionStart', { ... });

    const tool = this.toolRegistry.get(toolCall.function.name); // ← 直接获取
    if (!tool) { throw ... }

    const params = JSON.parse(toolCall.function.arguments);

    // 智能修复 todos 参数
    if (params.todos && typeof params.todos === 'string') { ... }

    const toolInvocation = tool.build(params); // ← 直接构建
    const signalToUse = options?.signal || new AbortController().signal;
    const result = await toolInvocation.execute(signalToUse); // ← 直接执行 (无保护)
    allToolResults.push(result);

    // 触发工具执行完成事件
    this.emit('toolExecutionComplete', { ... });

    // 处理 TODO 更新
    if ((toolCall.function.name === 'TodoWrite' || ...) && result.success) {
      this.emit('todoUpdate', { todos });
    }

    // 添加工具结果到消息历史
    messages.push({ role: 'tool', ... });

  } catch (error) {
    messages.push({ role: 'tool', content: `执行失败: ${error.message}` });
  }
}
```

**重构后** (40 行):
```typescript
for (const toolCall of turnResult.toolCalls) {
  if (toolCall.type !== 'function') continue;

  // 检查中断
  if (options?.signal?.aborted) {
    return this.abortResult(turnsCount, allToolResults, startTime);
  }

  try {
    // 🎯 全部委托给 ExecutionPipeline (包含 6 阶段验证)
    const result = await this.executionPipeline.execute(
      toolCall.function.name,
      JSON.parse(toolCall.function.arguments),
      {
        sessionId: this.sessionId,
        signal: options?.signal || new AbortController().signal,
        onProgress: (progress) => this.emit('toolProgress', progress),
      }
    );

    allToolResults.push(result);

    // 处理 TODO 更新 (可选: 移到 Pipeline 的 PostProcessing 阶段)
    if (this.isTodoTool(toolCall.function.name) && result.success) {
      this.emit('todoUpdate', this.extractTodos(result));
    }

    // 添加工具结果到消息历史
    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: this.formatToolResult(result),
    });

  } catch (error) {
    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: `执行失败: ${error.message}`,
    });
  }
}

// 新增辅助方法
private isTodoTool(toolName: string): boolean {
  return toolName === 'TodoWrite' || toolName === 'TodoRead';
}

private extractTodos(result: ToolResult): any {
  const content = typeof result.llmContent === 'object' ? result.llmContent : {};
  return Array.isArray(content) ? content : (content as any).todos || [];
}

private formatToolResult(result: ToolResult): string {
  let content = result.success
    ? result.displayContent || result.llmContent || ''
    : result.error?.message || '执行失败';

  if (typeof content === 'object' && content !== null) {
    content = JSON.stringify(content, null, 2);
  }

  return typeof content === 'string' ? content : JSON.stringify(content);
}

private abortResult(turnsCount: number, toolResults: any[], startTime: number): LoopResult {
  return {
    success: false,
    error: { type: 'aborted', message: '任务已被用户中止' },
    metadata: {
      turnsCount,
      toolCallsCount: toolResults.length,
      duration: Date.now() - startTime,
    },
  };
}
```

**对比**: 从 100+ 行减少到 **50 行**, 所有复杂逻辑下沉到 Pipeline!

**预估**: 1 小时

---

### Phase 5: 增强 ExecutionPipeline 🔧

**文件**: `src/tools/execution/ExecutionPipeline.ts`

#### 5.1 添加 ToolRegistry 管理能力

```typescript
export class ExecutionPipeline extends EventEmitter {
  private stages: PipelineStage[];
  private registry: ToolRegistry; // ← 接管 registry
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;

  constructor(
    registry: ToolRegistry, // ← 现有参数
    config: ExecutionPipelineConfig = {}
  ) {
    super();
    this.registry = registry;
    this.maxHistorySize = config.maxHistorySize || 1000;

    // 使用提供的权限配置或默认配置
    const permissionConfig: PermissionConfig = config.permissionConfig || {
      allow: [],
      ask: [],
      deny: [],
    };

    // 初始化6个执行阶段
    this.stages = [
      new DiscoveryStage(this.registry),
      new ValidationStage(),
      new PermissionStage(permissionConfig),
      new ConfirmationStage(config.confirmationHandler), // ← 注入 handler
      new ExecutionStage(),
      new FormattingStage(),
    ];
  }

  // ✨ 新增: 注册工具的能力
  registerTool(tool: Tool): void {
    this.registry.register(tool);
    this.emit('toolRegistered', { toolName: tool.name });
  }

  registerAllTools(tools: Tool[]): void {
    this.registry.registerAll(tools);
    this.emit('toolsRegistered', { count: tools.length });
  }

  // ✨ 新增: 获取工具声明 (给 LLM 用)
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.registry.getFunctionDeclarations();
  }

  // ✨ 新增: 获取工具数量
  getToolCount(): number {
    return this.registry.getAll().length;
  }
}
```

#### 5.2 更新配置接口

```typescript
export interface ExecutionPipelineConfig {
  maxHistorySize?: number;
  enableMetrics?: boolean;
  customStages?: PipelineStage[];
  permissionConfig?: PermissionConfig;
  confirmationHandler?: ConfirmationHandler; // ← 新增
}
```

**预估**: 30 分钟

---

### Phase 6: 实现 ConfirmationHandler + UI 组件 🎨

这是最关键的部分!

#### 6.1 定义 ConfirmationHandler 接口

**文件**: `src/tools/execution/types.ts` (新建或扩展现有)

```typescript
/**
 * 确认处理器接口
 * 用于请求用户确认工具执行
 */
export interface ConfirmationHandler {
  /**
   * 请求用户确认
   * @param request 确认请求详情
   * @returns Promise<ConfirmationResult>
   */
  requestConfirmation(request: ConfirmationRequest): Promise<ConfirmationResult>;
}

/**
 * 确认请求
 */
export interface ConfirmationRequest {
  toolName: string;
  params: unknown;
  reason: string; // 为什么需要确认
  affectedPaths: string[]; // 将要影响的文件/路径
  riskLevel: 'low' | 'medium' | 'high'; // 风险等级
}

/**
 * 确认结果
 */
export interface ConfirmationResult {
  approved: boolean; // 是否批准
  scope: 'once' | 'session' | 'always'; // 批准范围
  remember?: boolean; // 是否记住此决定 (保存到 settings.json)
}
```

#### 6.2 更新 ConfirmationStage

**文件**: `src/tools/execution/PipelineStages.ts`

```typescript
export class ConfirmationStage implements PipelineStage {
  readonly name = 'confirmation';

  constructor(
    private confirmationHandler?: ConfirmationHandler
  ) {}

  async process(execution: ToolExecution): Promise<void> {
    const needsConfirmation = (execution as any).needsConfirmation;

    if (!needsConfirmation) {
      return; // 不需要确认,直接通过
    }

    if (!this.confirmationHandler) {
      // 没有处理器,记录警告并通过
      console.warn(`工具 "${execution.toolName}" 需要用户确认,但未配置确认处理器`);
      return;
    }

    const tool = (execution as any).tool;
    const invocation = (execution as any).invocation;
    const permissionCheckResult = (execution as any).permissionCheckResult;

    // 构建确认请求
    const request: ConfirmationRequest = {
      toolName: execution.toolName,
      params: execution.params,
      reason: (execution as any).confirmationReason || permissionCheckResult?.reason || '需要用户确认',
      affectedPaths: invocation?.getAffectedPaths() || [],
      riskLevel: this.assessRiskLevel(execution.toolName, execution.params),
    };

    // 🎯 暂停并请求用户确认
    const result = await this.confirmationHandler.requestConfirmation(request);

    if (!result.approved) {
      execution.abort('用户拒绝执行此工具');
      return;
    }

    // 如果用户选择了 "always",发出事件以便保存配置
    if (result.scope === 'always' && result.remember) {
      // 触发事件,由 Agent 或 ConfigManager 处理保存
      (execution as any).shouldSavePermission = true;
      (execution as any).approvalScope = result.scope;
    }
  }

  private assessRiskLevel(toolName: string, params: any): 'low' | 'medium' | 'high' {
    // 风险评估逻辑
    if (toolName === 'Bash') {
      const cmd = params.command || '';
      if (cmd.includes('rm -rf') || cmd.includes('sudo')) return 'high';
      if (cmd.includes('write') || cmd.includes('modify')) return 'medium';
      return 'low';
    }

    if (toolName === 'Write' || toolName === 'Edit') return 'medium';
    if (toolName === 'Read') return 'low';

    return 'medium'; // 默认中等风险
  }
}
```

#### 6.3 创建 CLI 确认组件

**文件**: `src/ui/components/ConfirmationPrompt.tsx` (新建)

```typescript
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import React from 'react';
import type { ConfirmationRequest, ConfirmationResult } from '../../tools/execution/types.js';

interface ConfirmationPromptProps {
  request: ConfirmationRequest;
  onConfirm: (result: ConfirmationResult) => void;
}

export const ConfirmationPrompt: React.FC<ConfirmationPromptProps> = ({
  request,
  onConfirm,
}) => {
  // 风险等级颜色
  const riskColor = {
    low: 'green',
    medium: 'yellow',
    high: 'red',
  }[request.riskLevel];

  // 选项列表 (参考 GitHub Copilot CLI)
  const items = [
    { label: '✓ Allow once', value: 'once' },
    { label: '✓ Allow this session', value: 'session' },
    { label: '✓ Allow always (save to settings)', value: 'always' },
    { label: '✗ Deny', value: 'deny' },
  ];

  const handleSelect = (item: { value: string }) => {
    if (item.value === 'deny') {
      onConfirm({ approved: false, scope: 'once', remember: false });
    } else {
      onConfirm({
        approved: true,
        scope: item.value as 'once' | 'session' | 'always',
        remember: item.value === 'always',
      });
    }
  };

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="yellow">
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold color="yellow">⚠️  Permission Required</Text>
      </Box>

      {/* 工具信息 */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>Tool:</Text> <Text color="cyan">{request.toolName}</Text>
        </Text>
        <Text>
          <Text bold>Reason:</Text> {request.reason}
        </Text>
        <Text>
          <Text bold>Risk:</Text> <Text color={riskColor}>{request.riskLevel.toUpperCase()}</Text>
        </Text>
      </Box>

      {/* 受影响的文件 */}
      {request.affectedPaths.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Affected paths:</Text>
          {request.affectedPaths.slice(0, 5).map((p, i) => (
            <Text key={i} dimColor>  • {p}</Text>
          ))}
          {request.affectedPaths.length > 5 && (
            <Text dimColor>  ... and {request.affectedPaths.length - 5} more</Text>
          )}
        </Box>
      )}

      {/* 选项 */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Select an option (use ↑↓ arrows):</Text>
        <SelectInput items={items} onSelect={handleSelect} />
      </Box>
    </Box>
  );
};
```

#### 6.4 集成到 BladeInterface

**文件**: `src/ui/hooks/useCommandHandler.ts`

```typescript
import { useCallback, useRef, useState } from 'react';
import { Agent } from '../../agent/Agent.js';
import { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler, ConfirmationRequest, ConfirmationResult } from '../../tools/execution/types.js';

export const useCommandHandler = () => {
  // ... 现有状态 ...

  // ✨ 新增: 确认请求状态
  const [confirmationRequest, setConfirmationRequest] = useState<ConfirmationRequest | null>(null);
  const confirmationResolverRef = useRef<((result: ConfirmationResult) => void) | null>(null);

  // ✨ 创建 ConfirmationHandler
  const confirmationHandler: ConfirmationHandler = {
    async requestConfirmation(request: ConfirmationRequest): Promise<ConfirmationResult> {
      return new Promise((resolve) => {
        setConfirmationRequest(request);
        confirmationResolverRef.current = resolve;
      });
    }
  };

  // ✨ 处理用户确认响应
  const handleConfirmation = useCallback((result: ConfirmationResult) => {
    if (confirmationResolverRef.current) {
      confirmationResolverRef.current(result);
      confirmationResolverRef.current = null;
    }
    setConfirmationRequest(null);
  }, []);

  // 修改 Agent 创建逻辑
  const initializeAgent = useCallback(async () => {
    // ... 加载配置 ...

    // 创建 ExecutionPipeline (注入 confirmationHandler)
    const registry = new ToolRegistry();
    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: config.permissions,
      confirmationHandler, // ← 注入
    });

    // 创建 Agent
    const agent = await Agent.create({
      systemPrompt,
      // ... 其他配置 ...
    }, pipeline); // ← 传入 pipeline

    agentRef.current = agent;

    // ... 监听事件 ...
  }, [confirmationHandler]);

  return {
    // ... 现有返回值 ...
    confirmationRequest, // ← 暴露给 UI
    handleConfirmation,  // ← 暴露给 UI
  };
};
```

**文件**: `src/ui/components/BladeInterface.tsx`

```typescript
import { ConfirmationPrompt } from './ConfirmationPrompt.js';

export const BladeInterface: React.FC<BladeInterfaceProps> = (props) => {
  const {
    // ... 现有状态 ...
    confirmationRequest,
    handleConfirmation,
  } = useCommandHandler();

  return (
    <Box flexDirection="column" height="100%">
      {/* 消息区域 */}
      <MessageArea ... />

      {/* 🎯 确认提示 (覆盖在输入区域上方) */}
      {confirmationRequest && (
        <ConfirmationPrompt
          request={confirmationRequest}
          onConfirm={handleConfirmation}
        />
      )}

      {/* 输入区域 (确认时禁用) */}
      <InputArea
        ...
        isProcessing={isProcessing || confirmationRequest !== null}
      />

      {/* 状态栏 */}
      <ChatStatusBar ... />
    </Box>
  );
};
```

**预估**: 2-3 小时

---

## 📝 完整文件清单

### 需要修改的文件 (13 个)

1. ✏️ `src/agent/types.ts` - 扩展 AgentConfig
2. ✏️ `src/agent/Agent.ts` - 构造函数 + initialize() + runLoop()
3. ✏️ `src/tools/execution/ExecutionPipeline.ts` - 添加 registry 管理
4. ✏️ `src/tools/execution/PipelineStages.ts` - 实现 ConfirmationStage
5. ✨ `src/tools/execution/types.ts` - 新增确认相关类型 (或扩展现有)
6. ✨ `src/ui/components/ConfirmationPrompt.tsx` - 新建确认 UI 组件
7. ✏️ `src/ui/hooks/useCommandHandler.ts` - 集成 confirmationHandler
8. ✏️ `src/ui/components/BladeInterface.tsx` - 渲染 ConfirmationPrompt
9. ✏️ `src/config/defaults.ts` - 确保权限默认值正确
10. ✏️ `tests/unit/agent/Agent.test.ts` - 更新测试
11. ✏️ `tests/unit/tools/execution/ExecutionPipeline.test.ts` - 更新测试
12. ✨ `tests/unit/tools/execution/ConfirmationStage.test.ts` - 新建测试
13. ✏️ `docs/config-system.md` - 更新文档

### 需要更新的测试

- Agent 单元测试: `tests/unit/agent/Agent.test.ts`
- ExecutionPipeline 测试: `tests/unit/tools/execution/ExecutionPipeline.test.ts`
- 集成测试: `tests/integration/core/Agent.integration.test.ts`

---

## ⚙️ 实施顺序

建议按以下顺序执行,保证每一步都可测试:

```
Phase 1 (类型) → Phase 2 (Agent构造) → Phase 5.1 (Pipeline增强)
  ↓
测试: Agent 可以正常创建,Pipeline 接管 registry
  ↓
Phase 3 (Agent.initialize) → Phase 4 (runLoop重构)
  ↓
测试: 工具执行经过 Pipeline,权限 allow/deny 生效
  ↓
Phase 6.1-6.2 (ConfirmationHandler接口 + Stage)
  ↓
测试: 模拟 handler,确认逻辑正确暂停/恢复
  ↓
Phase 6.3-6.4 (UI 组件 + 集成)
  ↓
测试: 端到端测试,用户可以看到确认提示并响应
```

---

## 🎁 预期收益

### 1. **安全性** 🛡️
- ✅ 所有工具执行都经过 6 阶段验证
- ✅ 危险操作自动拦截或请求确认
- ✅ 用户完全掌控执行权限

### 2. **架构清晰** 🏗️
- ✅ Agent 职责单一 (LLM + 循环控制)
- ✅ ExecutionPipeline 完全负责工具执行
- ✅ 易于测试和扩展

### 3. **用户体验** ✨
- ✅ 内联确认,不打断工作流
- ✅ 明确的风险提示
- ✅ 灵活的权限范围 (once/session/always)
- ✅ 可持久化到配置文件

### 4. **符合业界标准** 🌟
- ✅ 参考 Claude Code / GitHub Copilot 的设计
- ✅ 支持 YOLO 模式 (通过配置 allow 规则)
- ✅ 完整的权限配置系统

---

## ⏱️ 时间预估

| 阶段 | 预估时间 | 说明 |
|------|----------|------|
| Phase 1 | 5 分钟 | 类型定义扩展 |
| Phase 2 | 30 分钟 | Agent 构造函数重构 |
| Phase 3 | 20 分钟 | Agent.initialize 简化 |
| Phase 4 | 1 小时 | runLoop 重构 |
| Phase 5 | 30 分钟 | Pipeline 增强 |
| Phase 6 | 2-3 小时 | ConfirmationHandler + UI |
| **测试** | 2 小时 | 单元测试 + 集成测试 |
| **文档** | 1 小时 | 更新文档和示例 |
| **总计** | **7-8 小时** | 一个工作日 |

---

## 🚨 注意事项

### 1. **会话级别权限缓存**
需要在 Agent 或 Pipeline 中维护会话级别的权限决策缓存:

```typescript
private sessionPermissions = new Map<string, 'allow' | 'deny'>(); // toolName → decision

// 在 ConfirmationStage 中:
if (result.scope === 'session') {
  this.sessionPermissions.set(request.toolName, 'allow');
}
```

### 2. **持久化 "always" 决策**
当用户选择 "Allow always" 时,需要更新 `settings.local.json`:

```typescript
// 在 Agent 或 ConfigManager 中监听事件
pipeline.on('permissionSaved', async (data) => {
  const configManager = new ConfigManager();
  await configManager.addPermissionRule('allow', data.toolPattern);
});
```

### 3. **TODO 工具特殊处理**
TodoWrite/TodoRead 应该默认在 allow 列表,否则频繁确认会很烦人:

```typescript
// src/config/defaults.ts
permissions: {
  allow: ['TodoRead(*)', 'TodoWrite(*)'],
  ask: [],
  deny: ['Read(./.env)', 'Read(./.env.*)'],
}
```

### 4. **性能影响**
- 每个工具调用增加 ~10-20ms (管道开销 + 用户确认时间)
- 对于 allow 规则的工具,开销仅 ~5ms (跳过确认阶段)

---

## ✅ 验收标准

### 功能测试

- [ ] 工具执行经过 6 个阶段
- [ ] `allow` 规则的工具直接通过,无确认
- [ ] `deny` 规则的工具立即拒绝
- [ ] `ask` 规则的工具显示确认提示
- [ ] 用户选择 "Allow once" 后单次通过
- [ ] 用户选择 "Allow session" 后本次会话内通过
- [ ] 用户选择 "Allow always" 后保存到配置文件
- [ ] 用户选择 "Deny" 后工具执行失败
- [ ] 确认提示显示正确的工具名、原因、风险等级
- [ ] 确认时输入框正确禁用

### 集成测试

- [ ] Agent 正常初始化,加载权限配置
- [ ] Agentic Loop 正确等待用户确认
- [ ] 多个工具调用时,每个都正确经过验证
- [ ] 中断信号 (Ctrl+C) 正确终止确认流程

### 性能测试

- [ ] allow 规则工具执行时间 < 200ms (不含工具本身执行时间)
- [ ] ask 规则工具确认显示延迟 < 100ms

---

## 🚀 开始实施

准备好开始实施方案 B 了吗? 建议按照上述 6 个 Phase 的顺序逐步进行,每完成一个 Phase 就进行测试验证。

如有任何疑问或需要调整计划,请随时提出!
