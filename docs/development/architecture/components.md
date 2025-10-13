# 🏗️ 核心组件

## 🎯 架构概览

Blade Code 采用现代化的**扁平化单包架构**设计，每个组件都有明确的职责边界。

## 🧠 Agent 系统

### Agent 核心
Agent 是 Blade Code 的核心组件，负责协调 LLM 交互和工具调用。

```typescript
// src/agent/Agent.ts
class Agent {
  private toolManager: ToolManager
  private chatService: ChatService
  private contextManager: ContextManager

  async execute(request: AgentRequest): Promise<AgentResponse>
  setContext(context: ConversationContext): void
}
```

**主要职责：**
- 🎯 LLM 对话管理
- 🔧 工具选择和执行
- 💭 上下文和记忆管理
- 🎛️ 增强的控制能力

### Context Manager
上下文管理器负责会话状态和记忆管理。

```typescript
// src/context/ContextManager.ts
class ContextManager {
  compressContext(context: Context): CompressedContext
  restoreContext(compressed: CompressedContext): Context
  manageMemory(conversation: Conversation): void
}
```

**功能特性：**
- 📝 会话历史管理
- 🗜️ 上下文压缩算法
- 🧠 智能记忆机制
- 🔄 多会话支持

## 🔧 工具系统

### Tool Manager
统一的工具注册和执行系统，提供验证和安全控制。

```typescript
// src/tools/ToolManager.ts
class ToolManager {
  register(name: string, tool: Tool): void
  execute(name: string, params: ToolParams): Promise<ToolResult>
  validate(tool: Tool): boolean
  getAvailableTools(): Tool[]
}
```

**内置工具类别：**
- 📂 **文件操作**: 读写文件、多文件编辑
- 🔍 **搜索工具**: 文件搜索、全文检索
- 🖥️ **Shell 工具**: 命令执行、脚本运行
- 🌐 **网络工具**: HTTP 请求、API 调用
- ⚙️ **任务管理**: 任务调度、并发执行

### 工具安全机制

```typescript
// src/security/ToolValidator.ts
class ToolValidator {
  validateInput(input: any): boolean
  checkPermissions(tool: string, action: string): boolean
  assessRisk(operation: Operation): RiskLevel
}
```

**安全等级：**
- 🟢 **安全**: 只读操作，自动执行
- 🟡 **中等**: 普通写入，需要确认
- 🟠 **高风险**: 覆盖文件，重点确认
- 🔴 **极高风险**: 危险操作，严格确认

## 💬 聊天服务

### Chat Service
统一的 LLM 接口，支持多个提供商。

```typescript
// src/services/ChatService.ts
class ChatService {
  private providers: Map<string, LLMProvider>

  async sendMessage(message: string, options?: ChatOptions): Promise<ChatResponse>
  setProvider(provider: LLMProvider): void
  enableFallback(fallbackProvider: LLMProvider): void
}
```

**支持的 LLM 提供商：**
- 🎯 **千问 (Qwen)**: 阿里云大语言模型
- 🌋 **豆包 (VolcEngine)**: 火山引擎大语言模型
- 🤖 **OpenAI**: GPT 系列模型
- 🧠 **Anthropic**: Claude 系列模型

### 回退机制

```typescript
// 自动回退配置
const chatService = new ChatService({
  primary: 'qwen',
  fallback: ['volcengine', 'openai'],
  retryAttempts: 3
})
```

## 🔗 MCP 协议

### MCP Client/Server
Model Context Protocol 集成，支持外部工具和资源。

```typescript
// src/mcp/McpClient.ts
class McpClient {
  connect(serverUrl: string): Promise<void>
  listTools(): Promise<Tool[]>
  callTool(name: string, params: any): Promise<any>
  listResources(): Promise<Resource[]>
}
```

**MCP 功能：**
- 🔌 外部工具集成
- 📚 资源访问扩展
- 🌐 协议标准化
- 🔄 动态工具加载

## 📱 用户界面

### UI Components
基于 React/Ink 的命令行用户界面。

```typescript
// src/ui/App.tsx
function App({ initialMessage }: AppProps) {
  const [conversation, setConversation] = useState<Conversation>()
  const [isLoading, setIsLoading] = useState(false)

  return (
    <Box flexDirection="column">
      <Header />
      <ConversationView conversation={conversation} />
      <InputArea onSubmit={handleSubmit} />
    </Box>
  )
}
```

**UI 特性：**
- 🎨 现代化界面设计
- ⚡ 实时流式输出
- 📱 响应式布局
- 🎯 智能建议系统

### 交互组件

```typescript
// 关键 UI 组件
export const ConversationView: React.FC<ConversationViewProps>
export const MessageBubble: React.FC<MessageBubbleProps>
export const InputArea: React.FC<InputAreaProps>
export const ToolConfirmation: React.FC<ToolConfirmationProps>
export const LoadingSpinner: React.FC<LoadingSpinnerProps>
```

## ⚙️ 配置系统

### Config Manager
分层配置管理系统，支持加密存储。

```typescript
// src/config/ConfigManager.ts
class ConfigManager {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): Promise<void>
  load(configPath?: string): Promise<void>
  encrypt(sensitive: any): string
  decrypt(encrypted: string): any
}
```

**配置层级：**
1. **命令行参数** (最高优先级)
2. **环境变量**
3. **项目配置文件** (.blade.json)
4. **用户配置文件** (~/.blade/config.json)
5. **默认配置** (最低优先级)

## 🛡️ 安全管理

### Security Manager
安全管理器负责权限控制和风险评估。

```typescript
// src/security/SecurityManager.ts
class SecurityManager {
  assessRisk(operation: Operation): RiskLevel
  requireConfirmation(operation: Operation): boolean
  validateInput(input: string): ValidationResult
  sanitizeCommand(command: string): string
}
```

**安全特性：**
- 🔐 输入验证和清理
- 🛡️ 权限检查机制
- ⚠️ 风险评估系统
- 🔒 敏感数据加密

## 📊 遥测系统

### Telemetry SDK
指标收集和错误跟踪系统。

```typescript
// src/telemetry/TelemetrySDK.ts
class TelemetrySDK {
  trackEvent(event: string, properties?: any): void
  trackError(error: Error, context?: any): void
  trackMetric(name: string, value: number): void
  setUser(userId: string): void
}
```

**收集指标：**
- 📈 使用统计数据
- 🐛 错误和异常
- ⚡ 性能指标
- 👤 用户行为分析

## 🚨 错误处理

### Error System
统一的错误处理和恢复机制。

```typescript
// src/error/ErrorHandler.ts
class ErrorHandler {
  handle(error: Error): ErrorResponse
  recover(error: RecoverableError): Promise<void>
  report(error: Error, context: ErrorContext): void
}

// 错误类型定义
export class BladeError extends Error
export class ToolExecutionError extends BladeError
export class ConfigurationError extends BladeError
export class SecurityError extends BladeError
```

## 📝 日志系统

### Logger
结构化日志记录系统。

```typescript
// src/logging/Logger.ts
class Logger {
  info(message: string, meta?: any): void
  warn(message: string, meta?: any): void
  error(message: string, error?: Error): void
  debug(message: string, meta?: any): void
}
```

**日志级别：**
- 🔴 **ERROR**: 错误和异常
- 🟡 **WARN**: 警告信息
- 🔵 **INFO**: 一般信息
- 🟢 **DEBUG**: 调试信息

## 🔄 服务层

### 共享服务
跨组件的共享服务实现。

```typescript
// 核心服务
export class FileSystemService    // 文件系统操作
export class GitService          // Git 仓库管理
export class ProxyService        // HTTP 客户端
export class ValidationService   // 数据验证
export class CacheService        // 缓存管理
```

## 📦 组件间通信

### 事件系统

```typescript
// src/utils/EventEmitter.ts
class EventEmitter {
  on(event: string, listener: Function): void
  emit(event: string, ...args: any[]): void
  off(event: string, listener: Function): void
}

// 系统事件
export const Events = {
  TOOL_EXECUTED: 'tool:executed',
  MESSAGE_SENT: 'message:sent',
  ERROR_OCCURRED: 'error:occurred',
  CONFIG_CHANGED: 'config:changed'
}
```

## 🎛️ CLI 系统

### Command Handler
CLI 命令处理和路由系统。

```typescript
// src/cli/CommandHandler.ts
class CommandHandler {
  register(command: string, handler: CommandFunction): void
  execute(args: string[]): Promise<void>
  showHelp(): void
}

// 可用命令
export const Commands = {
  chat: ChatCommand,
  config: ConfigCommand,
  mcp: McpCommand,
  doctor: DoctorCommand,
  update: UpdateCommand
}
```

## 🔗 依赖关系图

```
Agent (核心协调者)
├── ChatService (LLM 通信)
├── ToolManager (工具执行)
│   └── SecurityManager (安全控制)
├── ContextManager (上下文管理)
└── ConfigManager (配置管理)

UI Layer (用户界面)
├── App (主应用)
├── Components (界面组件)
└── CLI (命令行接口)

Services (共享服务)
├── FileSystemService
├── GitService
├── ProxyService
└── TelemetrySDK

Infrastructure (基础设施)
├── Logger (日志系统)
├── ErrorHandler (错误处理)
└── EventEmitter (事件系统)
```

---

这种模块化的组件设计使 Blade Code 具有良好的可维护性和扩展性。🏗️✨