# Blade 工具系统改进规划文档

## 一、背景与目标

基于对 Claude Code 和 Gemini CLI 的深入调研，Blade 需要构建一个更加强大、灵活和安全的工具系统。本规划旨在整合两个系统的优秀设计，打造适合 Blade 的工具体系架构。

**重要决策：本次重构将完全替换现有工具系统，不考虑向下兼容性，以便采用最优的架构设计。**

## 二、调研分析总结

### 2.1 Claude Code 工具体系

#### 核心特点
- **6阶段执行管道**：工具发现 → 输入验证 → 权限检查 → 中断控制 → 执行 → 结果格式化
- **并发调度**：最多10个并发工具，动态任务队列管理
- **基础工具集**：15类工具覆盖文件、搜索、任务、系统、网络等操作
- **MCP扩展**：支持通过Model Context Protocol扩展外部工具

#### 基础工具分类
```
文件操作：Read, Write, Edit, MultiEdit, NotebookEdit
搜索发现：Glob, Grep, Bash (包含ls等)
网络工具：WebFetch, WebSearch  
任务管理：Task (Agent调度), TodoWrite, ExitPlanMode
辅助工具：BashOutput, KillBash
```

### 2.2 Gemini CLI 工具体系

#### 架构设计
```
packages/
├── cli/          # 用户界面层
├── core/         # 业务逻辑层
    └── tools/    # 工具系统
        ├── tool-registry.ts      # 工具注册表
        ├── tools.ts              # 基类定义
        ├── mcp-tool.ts          # MCP工具
        └── [具体工具实现]
```

#### 核心概念
- **声明式工具模式**：DeclarativeTool基类，分离验证和执行
- **ToolInvocation模式**：工具调用抽象，解耦参数和执行
- **MCP深度集成**：DiscoveredMCPTool类，自动发现和注册
- **富媒体支持**：支持图片、音频等多媒体内容

## 三、Blade 工具系统架构重构

### 3.1 重构策略

**完全重构方案**：
- 移除现有 ToolManager 类和相关类型定义
- 采用 Gemini CLI 的声明式工具模式
- 集成 Claude Code 的6阶段执行管道
- 重新设计目录结构和模块划分

### 3.2 新架构设计

```typescript
packages/core/src/tools/
├── index.ts                     # 统一导出
├── types/                       # 类型定义
│   ├── ToolTypes.ts            # 工具基础类型
│   ├── ExecutionTypes.ts       # 执行相关类型
│   ├── SecurityTypes.ts        # 安全相关类型
│   └── McpTypes.ts             # MCP相关类型
├── base/                        # 基础抽象类
│   ├── BaseTool.ts             # 工具基类
│   ├── DeclarativeTool.ts      # 声明式工具
│   └── ToolInvocation.ts       # 执行调用抽象
├── registry/                    # 工具注册系统
│   ├── ToolRegistry.ts         # 主注册表
│   ├── ToolDiscovery.ts        # 工具发现
│   └── ToolResolver.ts         # 工具解析器
├── execution/                   # 执行引擎
│   ├── ExecutionPipeline.ts    # 6阶段执行管道
│   ├── PipelineStages.ts       # 管道各阶段实现
│   ├── ConcurrencyManager.ts   # 并发管理
│   └── ResultProcessor.ts      # 结果处理
├── security/                    # 安全控制
│   ├── PermissionManager.ts    # 权限管理
│   ├── ValidationService.ts    # 参数验证
│   ├── ConfirmationService.ts  # 用户确认
│   └── SecurityPolicy.ts       # 安全策略
├── mcp/                         # MCP集成
│   ├── McpClientManager.ts     # MCP客户端管理
│   ├── McpToolAdapter.ts       # MCP工具适配
│   ├── McpTransport.ts         # 传输层
│   └── McpProtocol.ts          # 协议实现
└── builtin/                     # 内置工具
    ├── file/                    # 文件操作工具
    │   ├── ReadTool.ts
    │   ├── WriteTool.ts
    │   ├── EditTool.ts
    │   └── MultiEditTool.ts
    ├── search/                  # 搜索工具
    │   ├── GlobTool.ts
    │   ├── GrepTool.ts
    │   └── FindTool.ts
    ├── shell/                   # 命令执行工具
    │   ├── ShellTool.ts
    │   ├── BashTool.ts
    │   └── ScriptTool.ts
    ├── web/                     # 网络工具
    │   ├── WebFetchTool.ts
    │   ├── WebSearchTool.ts
    │   └── ApiCallTool.ts
    └── task/                    # 任务管理工具
        ├── TaskTool.ts
        ├── TodoTool.ts
        └── WorkflowTool.ts
```

### 3.3 核心组件设计

#### 3.3.1 核心类型定义

```typescript
// 工具类型枚举
export enum ToolKind {
  Read = 'read',
  Edit = 'edit', 
  Delete = 'delete',
  Move = 'move',
  Search = 'search',
  Execute = 'execute',
  Fetch = 'fetch',
  Think = 'think',
  Other = 'other'
}

// 工具执行结果
export interface ToolResult {
  success: boolean;
  llmContent: string | object;      // 传递给LLM的内容
  displayContent: string;           // 显示给用户的内容
  error?: ToolError;
  metadata?: Record<string, any>;
}

// 工具错误类型
export interface ToolError {
  message: string;
  type: ToolErrorType;
  code?: string;
  details?: any;
}

export enum ToolErrorType {
  VALIDATION_ERROR = 'validation_error',
  PERMISSION_DENIED = 'permission_denied',
  EXECUTION_ERROR = 'execution_error',
  TIMEOUT_ERROR = 'timeout_error',
  NETWORK_ERROR = 'network_error'
}
```

#### 3.3.2 工具调用接口

```typescript
// 工具调用抽象
export interface ToolInvocation<TParams = any, TResult = ToolResult> {
  readonly toolName: string;
  readonly params: TParams;
  
  getDescription(): string;
  getAffectedPaths(): string[];
  shouldConfirm(): Promise<ConfirmationDetails | null>;
  execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<TResult>;
}

// 确认详情
export interface ConfirmationDetails {
  type: 'edit' | 'execute' | 'delete' | 'network' | 'mcp';
  title: string;
  message: string;
  risks?: string[];
  affectedFiles?: string[];
}
```

#### 3.3.3 声明式工具基类

```typescript
// 声明式工具抽象基类
export abstract class DeclarativeTool<TParams = any, TResult = ToolResult> {
  constructor(
    public readonly name: string,
    public readonly displayName: string,
    public readonly description: string,
    public readonly kind: ToolKind,
    public readonly parameterSchema: JSONSchema7,
    public readonly requiresConfirmation: boolean = false
  ) {}

  // 工具模式定义（用于LLM函数调用）
  get functionDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameterSchema
    };
  }

  // 验证并构建工具调用
  abstract build(params: TParams): ToolInvocation<TParams, TResult>;

  // 一键执行（内部调用build+execute）
  async execute(params: TParams, signal?: AbortSignal): Promise<TResult> {
    const invocation = this.build(params);
    return invocation.execute(signal || new AbortController().signal);
  }
}
```

#### 3.3.4 工具注册表

```typescript
export class ToolRegistry {
  private tools = new Map<string, DeclarativeTool>();
  private mcpTools = new Map<string, McpToolAdapter>();
  
  // 注册内置工具
  register(tool: DeclarativeTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  // 批量注册
  registerAll(tools: DeclarativeTool[]): void {
    tools.forEach(tool => this.register(tool));
  }

  // 获取工具
  get(name: string): DeclarativeTool | undefined {
    return this.tools.get(name) || this.mcpTools.get(name);
  }

  // 获取所有工具
  getAll(): DeclarativeTool[] {
    return [
      ...Array.from(this.tools.values()),
      ...Array.from(this.mcpTools.values())
    ];
  }

  // 获取函数声明（用于LLM）
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll().map(tool => tool.functionDeclaration);
  }

  // MCP工具注册
  registerMcpTool(adapter: McpToolAdapter): void {
    this.mcpTools.set(adapter.name, adapter);
  }

  // 移除MCP工具
  removeMcpTools(serverName: string): void {
    for (const [name, tool] of this.mcpTools.entries()) {
      if (tool.serverName === serverName) {
        this.mcpTools.delete(name);
      }
    }
  }
}
```
#### 3.3.5 执行管道

```typescript
// 6阶段执行管道
export class ExecutionPipeline {
  private stages: PipelineStage[] = [
    new DiscoveryStage(),      // 工具发现
    new ValidationStage(),     // 参数验证
    new PermissionStage(),     // 权限检查
    new ConfirmationStage(),   // 用户确认
    new ExecutionStage(),      // 实际执行
    new FormattingStage()      // 结果格式化
  ];

  async execute<T>(
    toolName: string,
    params: any,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const execution = new ToolExecution(toolName, params, context);
    
    for (const stage of this.stages) {
      await stage.process(execution);
      if (execution.shouldAbort()) {
        return execution.getResult();
      }
    }
    
    return execution.getResult();
  }
}

// 执行上下文
export interface ExecutionContext {
  userId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

// 并发管理器
export class ConcurrencyManager {
  private readonly maxConcurrent = 10;
  private running = new Map<string, Promise<ToolResult>>();
  
  async execute<T>(
    invocation: ToolInvocation<T>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const id = `${invocation.toolName}-${Date.now()}`;
    
    if (this.running.size >= this.maxConcurrent) {
      throw new Error('Maximum concurrent tool executions reached');
    }
    
    const promise = invocation.execute(context.signal, context.onProgress);
    this.running.set(id, promise);
    
    try {
      return await promise;
    } finally {
      this.running.delete(id);
    }
  }
}
```
### 3.4 重构后的内置工具集

**完全重写现有工具，基于新的声明式架构**：

#### 文件操作工具
- **ReadTool**: 读取文件内容，支持多种格式
- **WriteTool**: 写入文件
- **EditTool**: 精确字符串替换
- **MultiEditTool**: 批量编辑
- **DeleteTool**: 删除文件/目录

#### 搜索发现工具
- **GlobTool**: 文件模式匹配
- **GrepTool**: 基于ripgrep的搜索
- **FindTool**: 高级文件查找

#### 命令执行工具
- **ShellTool**: 执行shell命令
- **BashTool**: 持久化bash会话
- **ScriptTool**: 执行脚本文件

#### 网络工具
- **WebFetchTool**: 获取网页内容
- **WebSearchTool**: 网络搜索
- **ApiCallTool**: API调用

#### 任务管理工具
- **TaskTool**: Agent任务调度
- **TodoTool**: 任务列表管理
- **WorkflowTool**: 工作流执行

### 3.4 MCP集成方案

```typescript
// MCP客户端管理器
class McpClientManager {
  private clients: Map<string, McpClient>;
  private transports: Map<string, McpTransport>;
  
  // 连接MCP服务器
  async connectServer(
    name: string,
    config: McpServerConfig
  ): Promise<void>;
  
  // 发现MCP工具
  async discoverTools(serverName: string): Promise<McpTool[]>;
  
  // 执行MCP工具
  async executeTool(
    serverName: string,
    toolName: string,
    params: any
  ): Promise<any>;
}

// MCP工具适配器
class McpToolAdapter extends DeclarativeTool {
  constructor(
    private mcpClient: McpClient,
    private serverName: string,
    private toolDefinition: McpToolDefinition
  ) {
    super(/* ... */);
  }
  
  build(params: any): ToolInvocation {
    return new McpToolInvocation(
      this.mcpClient,
      this.serverName,
      this.toolDefinition.name,
      params
    );
  }
}
```

### 3.5 安全控制机制

#### 3.5.1 权限模型

```typescript
enum PermissionLevel {
  Allow = 'allow',      // 自动允许
  Deny = 'deny',        // 自动拒绝
  Ask = 'ask'           // 询问用户
}

class PermissionManager {
  private permissions: Map<string, PermissionLevel>;
  private trustedPaths: Set<string>;
  private trustedServers: Set<string>;
  
  async checkPermission(
    tool: DeclarativeTool,
    params: any,
    context: ExecutionContext
  ): Promise<PermissionResult>;
  
  setToolPermission(toolName: string, level: PermissionLevel): void;
  addTrustedPath(path: string): void;
  addTrustedServer(serverName: string): void;
}
```

#### 3.5.2 参数验证

```typescript
class ValidationService {
  // JSON Schema验证
  validateSchema(schema: JSONSchema, params: any): ValidationResult;
  
  // 自定义验证规则
  addValidator(toolName: string, validator: Validator): void;
  
  // 参数净化
  sanitizeParams(params: any): any;
}
```

#### 3.5.3 用户确认

```typescript
interface ConfirmationDetails {
  type: 'edit' | 'exec' | 'mcp' | 'info';
  title: string;
  message: string;
  risks?: string[];
  onConfirm: (outcome: ConfirmationOutcome) => Promise<void>;
}

class ConfirmationService {
  async requestConfirmation(
    details: ConfirmationDetails
  ): Promise<ConfirmationOutcome>;
  
  // 记住用户选择
  rememberChoice(pattern: string, outcome: ConfirmationOutcome): void;
}
```

## 四、重构实施策略

### 4.1 破坏性变更清单

**以下现有组件将被完全移除**：
- `packages/core/src/tools/ToolManager.ts` - 替换为 ToolRegistry + ExecutionPipeline
- `packages/core/src/tools/types.ts` - 重新设计类型系统
- 所有现有工具实现 - 基于新架构重写

**新增组件**：
- 完整的 `tools/` 目录结构
- 声明式工具基类体系
- 6阶段执行管道
- MCP协议集成

### 4.2 迁移计划

#### 第一阶段：基础架构重构（1-2周）
1. **移除旧代码**
   - 删除现有 ToolManager 和相关类型
   - 清理现有工具实现
   
2. **建立新架构**
   - 实现新的类型定义系统
   - 构建声明式工具基类
   - 创建工具注册表
   - 实现基础执行管道

#### 第二阶段：核心工具重写（2-3周）
1. **文件操作工具**
   - ReadTool：支持文本、图片、PDF等格式
   - WriteTool：安全的文件写入
   - EditTool：精确字符串替换
   - MultiEditTool：批量编辑操作

2. **搜索工具**
   - GlobTool：文件模式匹配
   - GrepTool：基于ripgrep的内容搜索
   - FindTool：高级文件查找

#### 第三阶段：高级功能（2-3周）
1. **命令执行工具**
   - ShellTool：单次命令执行
   - BashTool：持久化会话
   - ScriptTool：脚本文件执行

2. **网络工具**
   - WebFetchTool：网页内容获取
   - WebSearchTool：搜索引擎集成
   - ApiCallTool：RESTful API调用

#### 第四阶段：MCP集成（2-3周）
1. **MCP协议实现**
   - McpClient：协议客户端
   - McpTransport：多种传输方式
   - McpToolAdapter：工具适配器

2. **自动发现机制**
   - 服务器连接管理
   - 工具动态注册
   - 生命周期管理

## 五、重构收益

### 5.1 架构优势
1. **清晰的职责分离**：工具定义、注册、执行完全解耦
2. **类型安全**：完整的TypeScript类型定义，编译时错误检查
3. **可扩展性**：插件式架构，易于添加新工具和新功能
4. **一致性**：统一的工具接口和执行流程

### 5.2 功能增强
1. **MCP协议支持**：可扩展外部工具生态
2. **6阶段执行管道**：严格的安全控制和错误处理
3. **并发执行**：提升工具执行效率
4. **富媒体支持**：图片、音频等多媒体内容处理

### 5.3 开发体验
1. **简化的API**：更直观的工具开发接口
2. **完善的错误处理**：详细的错误信息和恢复机制
3. **测试友好**：模块化设计便于单元测试
4. **文档完善**：清晰的架构说明和使用指南

## 六、风险控制

### 6.1 技术风险
| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 架构过度设计 | 中 | 采用增量式开发，优先核心功能 |
| 性能下降 | 中 | 性能基准测试，优化关键路径 |
| MCP协议复杂性 | 高 | 分阶段实现，先支持基础功能 |

### 6.2 实施风险
| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 开发时间超期 | 高 | 严格的里程碑管理，及时调整 |
| 团队学习成本 | 中 | 详细文档，代码示例，技术分享 |
| 集成测试复杂 | 中 | 模块化测试，持续集成流水线 |

## 七、总结

本次工具系统重构将采用**完全重写**的策略，不考虑向下兼容性，以确保能够充分吸收 Claude Code 和 Gemini CLI 的优秀设计理念。

### 核心改进
1. **声明式工具架构**：清晰的工具定义和执行分离
2. **6阶段执行管道**：严格的安全控制和错误处理
3. **MCP协议集成**：可扩展的外部工具生态
4. **并发执行支持**：提升系统执行效率
5. **完整类型系统**：编译时安全和更好的开发体验

### 预期成果
- **强大的工具能力**：覆盖文件、搜索、命令、网络、任务等15类基础工具
- **高度可扩展**：通过MCP协议支持无限扩展
- **安全可控**：三级权限模型和用户确认机制
- **开发友好**：清晰的API设计和完善的文档

这次重构将为 Blade 提供一个现代化、可扩展、安全的工具系统基础，为AI Agent的强大能力提供坚实支撑。

## 八、工具体系与CLI/Agent集成架构

### 8.1 整体集成架构

```typescript
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CLI Layer     │    │   Agent Layer   │    │   Tools Layer   │
│  (用户界面)      │    │  (智能决策)      │    │  (执行能力)      │
├─────────────────┤    ├─────────────────┤    ├─────────────────┤
│ • Commands      │───▶│ • Agent Core    │───▶│ • ToolRegistry  │
│ • UI Components │    │ • LLM Interface │    │ • Execution     │
│ • User Input    │    │ • Context Mgmt  │    │ • Built-in Tools│
│ • Output Display│◀───│ • Tool Calling  │◀───│ • MCP Tools     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 8.2 Agent层集成实现

Agent 作为连接 CLI 和 Tools 的核心桥梁：

```typescript
// packages/core/src/agent/Agent.ts
export class Agent {
  private toolRegistry: ToolRegistry;
  private executionPipeline: ExecutionPipeline;
  private llmClient: LLMClient;

  constructor(config: AgentConfig) {
    this.toolRegistry = new ToolRegistry();
    this.executionPipeline = new ExecutionPipeline();
    this.llmClient = new LLMClient(config.llm);
    
    // 注册内置工具
    this.registerBuiltinTools();
    
    // 发现和注册MCP工具
    this.discoverMcpTools();
  }

  // 核心对话循环
  async chat(message: string, context: ChatContext): Promise<AgentResponse> {
    // 1. 构建LLM请求，包含可用工具列表
    const llmRequest = {
      messages: context.messages,
      tools: this.toolRegistry.getFunctionDeclarations(), // 关键：提供工具列表
      temperature: 0.7
    };

    // 2. 调用LLM
    const llmResponse = await this.llmClient.generate(llmRequest);

    // 3. 处理工具调用
    if (llmResponse.toolCalls) {
      return await this.handleToolCalls(llmResponse.toolCalls, context);
    }

    return {
      message: llmResponse.content,
      toolResults: []
    };
  }

  // 处理工具调用
  private async handleToolCalls(
    toolCalls: ToolCall[], 
    context: ChatContext
  ): Promise<AgentResponse> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      try {
        // 通过执行管道调用工具
        const result = await this.executionPipeline.execute(
          toolCall.name,
          toolCall.parameters,
          {
            userId: context.userId,
            sessionId: context.sessionId,
            workspaceRoot: context.workspaceRoot,
            signal: new AbortController().signal
          }
        );
        
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          llmContent: `Tool execution failed: ${error.message}`,
          displayContent: `Error: ${error.message}`,
          error: {
            message: error.message,
            type: ToolErrorType.EXECUTION_ERROR
          }
        });
      }
    }

    return {
      message: this.formatToolResults(results),
      toolResults: results
    };
  }

  private registerBuiltinTools() {
    const builtinTools = [
      new ReadTool(),
      new WriteTool(), 
      new EditTool(),
      new GlobTool(),
      new GrepTool(),
      new ShellTool(),
      new WebFetchTool(),
      // ... 其他内置工具
    ];

    this.toolRegistry.registerAll(builtinTools);
  }
}
```

### 8.3 CLI层集成实现

CLI层负责用户交互和结果显示：

```typescript
// packages/cli/src/commands/ChatCommand.tsx
export function ChatCommand() {
  const [agent] = useState(() => new Agent(getAgentConfig()));
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const handleUserInput = async (input: string) => {
    // 1. 添加用户消息
    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);

    try {
      // 2. 调用Agent处理
      const response = await agent.chat(input, {
        messages: [...messages, userMessage],
        userId: 'current-user',
        sessionId: 'current-session',
        workspaceRoot: process.cwd()
      });

      // 3. 显示Agent响应
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: response.message
      }]);

      // 4. 显示工具执行结果（如果有）
      if (response.toolResults.length > 0) {
        displayToolResults(response.toolResults);
      }

    } catch (error) {
      console.error('Chat error:', error);
    }
  };

  return (
    <Box flexDirection="column">
      <ChatHistory messages={messages} />
      <ChatInput onSubmit={handleUserInput} />
    </Box>
  );
}

// 工具结果显示组件
function displayToolResults(results: ToolResult[]) {
  results.forEach(result => {
    if (result.success) {
      console.log(`✅ Tool executed successfully`);
      console.log(result.displayContent);
    } else {
      console.error(`❌ Tool failed: ${result.error?.message}`);
    }
  });
}
```

### 8.4 核心系统初始化

在应用启动时建立各层连接：

```typescript
// packages/core/src/index.ts
export class BladeCore {
  public readonly agent: Agent;
  public readonly toolRegistry: ToolRegistry;

  constructor(config: BladeCoreConfig) {
    // 1. 初始化工具注册表
    this.toolRegistry = new ToolRegistry();
    
    // 2. 注册内置工具
    this.registerBuiltinTools();
    
    // 3. 初始化Agent，传入工具注册表
    this.agent = new Agent({
      ...config.agent,
      toolRegistry: this.toolRegistry
    });
    
    // 4. 如果配置了MCP，启动MCP服务器
    if (config.mcp?.enabled) {
      this.initializeMcp(config.mcp);
    }
  }

  private registerBuiltinTools() {
    const builtinTools = [
      new ReadTool(),
      new WriteTool(), 
      new EditTool(),
      new GlobTool(),
      new GrepTool(),
      new ShellTool(),
      new WebFetchTool(),
      // ... 其他内置工具
    ];

    this.toolRegistry.registerAll(builtinTools);
  }

  private async initializeMcp(config: McpConfig) {
    const mcpManager = new McpClientManager(config);
    await mcpManager.connectAll();
    
    // MCP工具会自动注册到toolRegistry
    mcpManager.on('toolDiscovered', (tool) => {
      this.toolRegistry.registerMcpTool(tool);
    });
  }
}
```

### 8.5 CLI应用入口

```typescript
// packages/cli/src/blade.tsx
async function main() {
  // 1. 初始化核心系统
  const core = new BladeCore({
    agent: {
      llm: {
        provider: 'qwen',
        apiKey: process.env.QWEN_API_KEY
      }
    },
    mcp: {
      enabled: true,
      servers: {
        'github': {
          command: 'npx',
          args: ['@modelcontextprotocol/server-github']
        }
      }
    }
  });

  // 2. 启动CLI界面
  const app = (
    <BladeApp core={core} />
  );

  render(app);
}

function BladeApp({ core }: { core: BladeCore }) {
  return (
    <Box flexDirection="column">
      <Header />
      <ChatCommand agent={core.agent} />
      <ToolStatus registry={core.toolRegistry} />
    </Box>
  );
}
```

### 8.6 关键接口定义

确保各层之间的类型一致性：

```typescript
// 跨层通信接口
export interface AgentResponse {
  message: string;
  toolResults: ToolResult[];
  context?: any;
}

export interface ChatContext {
  messages: ChatMessage[];
  userId: string;
  sessionId: string;
  workspaceRoot: string;
}

export interface BladeCoreConfig {
  agent: AgentConfig;
  mcp?: McpConfig;
  tools?: ToolConfig;
}

// Agent配置
export interface AgentConfig {
  llm: LLMConfig;
  toolRegistry?: ToolRegistry;
  maxConcurrency?: number;
  timeout?: number;
}

// LLM配置
export interface LLMConfig {
  provider: 'qwen' | 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
```

### 8.7 集成优势

这种集成架构的优势：

1. **清晰的分层**：CLI -> Agent -> Tools，职责明确
2. **松耦合设计**：各层通过接口交互，易于测试和维护
3. **可扩展性**：新工具只需注册到ToolRegistry即可被Agent使用
4. **类型安全**：完整的TypeScript类型定义确保编译时检查
5. **配置驱动**：通过配置文件控制工具启用和MCP服务器
6. **统一的错误处理**：一致的错误类型和处理机制
7. **实时反馈**：支持工具执行进度和结果的实时显示

通过这种架构，Agent 自然地成为了 CLI 和工具体系之间的智能协调者，负责：
- 理解用户意图
- 选择合适的工具
- 管理工具执行
- 处理执行结果
- 向用户展示结果

这确保了整个系统的协调一致和高效运行。

## 九、附录

### A. Claude Code 工具详细列表

#### 文件操作类
- **Read**: 读取文件内容，支持图片、PDF、Jupyter notebooks
- **Write**: 写入文件（会覆盖现有文件）
- **Edit**: 精确字符串替换
- **MultiEdit**: 批量编辑单个文件
- **NotebookEdit**: 编辑 Jupyter notebook 单元格

#### 搜索发现类
- **Glob**: 文件模式匹配（如 `**/*.js`）
- **Grep**: 基于 ripgrep 的强大搜索工具
- **Bash**: 执行 shell 命令（包括 ls 等）

#### 网络工具类
- **WebFetch**: 获取网页内容并用 AI 处理
- **WebSearch**: 网络搜索

#### 任务管理类
- **Task**: 启动专门的 Agent 处理复杂任务
- **TodoWrite**: 管理任务列表
- **ExitPlanMode**: 退出计划模式

#### 其他辅助工具
- **BashOutput**: 获取后台 shell 输出
- **KillBash**: 终止后台 shell

### B. MCP 扩展工具

Claude Code 通过 MCP (Model Context Protocol) 支持的扩展工具：

#### 已集成的 MCP 服务器
- **mcp__sequential-thinking__sequentialthinking**: 顺序思考工具
- **mcp__github__***: GitHub 操作工具集（20+ 个工具）
- **mcp__context7__***: 文档获取工具
- **mcp__ide__***: IDE 集成工具

### C. Gemini CLI 工具架构细节

#### packages/core/src/tools/ 结构
```
├── tool-registry.ts          # 工具注册表
├── tools.ts                  # 基类定义
├── mcp-tool.ts              # MCP工具
├── mcp-client.ts            # MCP客户端
├── mcp-client-manager.ts    # MCP客户端管理器
├── edit.ts                  # 编辑工具
├── glob.ts                  # 文件匹配工具
├── grep.ts                  # 搜索工具
├── ls.ts                    # 列表工具
├── read-file.ts             # 文件读取工具
├── write-file.ts            # 文件写入工具
├── shell.ts                 # Shell执行工具
├── web-fetch.ts             # 网络获取工具
└── web-search.ts            # 网络搜索工具
```

#### 核心设计模式
1. **声明式工具模式**: DeclarativeTool基类，分离验证和执行
2. **ToolInvocation模式**: 工具调用抽象，解耦参数和执行
3. **MCP深度集成**: DiscoveredMCPTool类，自动发现和注册
4. **富媒体支持**: 支持图片、音频等多媒体内容

这些详细信息为 Blade 工具系统的设计和实现提供了宝贵的参考。