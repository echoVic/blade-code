# 架构设计文档

本文档详细介绍 Blade Code 的架构设计理念和实现细节。

## 📋 目录

- [设计理念](#设计理念)
- [系统架构](#系统架构)
- [核心模块](#核心模块)
- [数据流](#数据流)
- [扩展性](#扩展性)

---

## 设计理念

### 核心原则

1. **无状态 Agent**: Agent 不持有状态，所有状态通过 Context 传递
2. **工具驱动**: Agent 的能力通过工具系统扩展
3. **分层配置**: 支持多层配置优先级（Global > Project > Local）
4. **类型安全**: 使用 Zod 进行运行时验证
5. **可测试性**: 模块解耦，便于单元测试

### 架构模式

- **分层架构**: UI -> Service -> Core -> Utils
- **插件系统**: MCP、Tools、Hooks 都是插件化设计
- **依赖注入**: 通过 Context 传递依赖

---

## 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────┐
│                  User Interface                      │
│  ┌────────────┐  ┌──────────┐  ┌──────────────┐    │
│  │ Terminal UI│  │  Web UI  │  │   Headless   │    │
│  │  (Ink)     │  │  (Vite)  │  │   (API)      │    │
│  └────────────┘  └──────────┘  └──────────────┘    │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│                Service Layer                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │
│  │  Chat    │  │ Session  │  │  Permission  │     │
│  │ Service  │  │ Service  │  │   Service    │     │
│  └──────────┘  └──────────┘  └──────────────┘     │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│                  Agent Core                          │
│  ┌────────────────────────────────────────┐         │
│  │   Stateless Agent                      │         │
│  │   - Message Processing                 │         │
│  │   - Tool Orchestration                 │         │
│  │   - Context Management                 │         │
│  └────────────────────────────────────────┘         │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│              Tool & Plugin System                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │
│  │ Builtin  │  │   MCP    │  │    Hooks     │     │
│  │  Tools   │  │  Tools   │  │   System     │     │
│  └──────────┘  └──────────┘  └──────────────┘     │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│              Infrastructure Layer                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │
│  │  Config  │  │ Logging  │  │    Utils     │     │
│  │  System  │  │  System  │  │              │     │
│  └──────────┘  └──────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────┘
```

---

## 核心模块

### 1. Agent Core

**职责**: 无状态对话处理核心

**设计**:
```typescript
class Agent {
  async executeTurn(options: ExecuteTurnOptions): Promise<TurnResult> {
    // 1. 构建消息
    const messages = this.buildMessages(options);
    
    // 2. 调用 LLM API
    const response = await this.llm.chat(messages);
    
    // 3. 解析工具调用
    const toolCalls = this.parseToolCalls(response);
    
    // 4. 执行工具
    const toolResults = await this.executeTools(toolCalls);
    
    // 5. 返回结果
    return { message: response, toolResults };
  }
}
```

**关键特性**:
- 无状态：所有状态通过 Context 传递
- 可测试：纯函数设计，易于单元测试
- 可扩展：工具系统插件化

### 2. Tool Registry

**职责**: 工具注册、查找、执行

**设计**:
```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  
  register(tool: Tool): void {
    this.validateTool(tool);
    this.tools.set(tool.name, tool);
  }
  
  async execute(
    name: string,
    params: unknown,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.get(name);
    
    // 1. 验证参数
    const validatedParams = tool.parameters.parse(params);
    
    // 2. 权限检查
    await this.checkPermission(tool, context);
    
    // 3. 执行工具
    const result = await tool.execute(validatedParams, context);
    
    return result;
  }
}
```

**关键特性**:
- 类型安全：Zod schema 验证
- 权限控制：三级权限系统
- 可扩展：支持自定义工具

### 3. Config System

**职责**: 分层配置管理

**配置层级**:
```
Runtime (CLI args) ← 优先级最高
    ↓
Local (.blade/settings.local.json)
    ↓
Project (.blade/config.json, settings.json)
    ↓
Global (~/.blade/config.json, settings.json) ← 优先级最低
```

**设计**:
```typescript
class ConfigManager {
  async initialize(): Promise<BladeConfig> {
    // 1. 加载基础配置 (config.json)
    const baseConfig = await this.loadConfigFiles();
    
    // 2. 加载行为配置 (settings.json)
    const settingsConfig = await this.loadSettingsFiles();
    
    // 3. 合并配置
    const config = this.mergeConfigs(
      DEFAULT_CONFIG,
      baseConfig,
      settingsConfig
    );
    
    // 4. 环境变量插值
    this.resolveEnvInterpolation(config);
    
    return config;
  }
}
```

**关键特性**:
- 分层加载：多级配置优先级
- 环境变量：支持 ${VAR} 插值
- 加密存储：敏感信息加密
- 验证迁移：配置版本迁移

### 4. MCP Integration

**职责**: Model Context Protocol 集成

**架构**:
```
┌─────────────────────┐
│   Blade Agent       │
│   (Tool Registry)   │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│   MCP Client        │
│   - Connection Pool │
│   - Tool Adapter    │
└──────────┬──────────┘
           │
     ┌─────┴─────┬─────────┬─────────┐
     │           │         │         │
┌────▼────┐ ┌───▼────┐ ┌──▼─────┐ ┌▼────────┐
│ Server  │ │ Server │ │ Server │ │ Server  │
│ (stdio) │ │ (HTTP) │ │ (SSE)  │ │ (...)   │
└─────────┘ └────────┘ └────────┘ └─────────┘
```

**设计**:
```typescript
class MCPClient {
  async connect(): Promise<void> {
    // 根据配置建立连接
    switch (this.config.type) {
      case 'stdio':
        this.transport = new StdioTransport(this.config);
        break;
      case 'http':
        this.transport = new HttpTransport(this.config);
        break;
      // ...
    }
    
    await this.transport.connect();
  }
  
  async listTools(): Promise<Tool[]> {
    const response = await this.transport.request({
      method: 'tools/list'
    });
    
    return response.tools.map(this.adaptTool);
  }
}
```

**关键特性**:
- 多传输：stdio、HTTP、SSE
- 工具适配：MCP 工具转换为 Blade 工具
- 健康监控：自动重连、健康检查

---

## 数据流

### 对话流程

```
1. User Input
   ↓
2. UI Layer (Ink/Web/Headless)
   ↓
3. Chat Service
   ├─ Session Management
   ├─ Message History
   └─ Context Building
   ↓
4. Agent Core
   ├─ Build Messages
   ├─ Call LLM API
   └─ Parse Response
   ↓
5. Tool Execution (if needed)
   ├─ Parse Tool Calls
   ├─ Permission Check
   ├─ Execute Tools
   └─ Collect Results
   ↓
6. Response Processing
   ├─ Format Output
   ├─ Update Session
   └─ Trigger Hooks
   ↓
7. UI Rendering
```

### 配置加载流程

```
1. Application Start
   ↓
2. ConfigManager.initialize()
   ├─ Load global config
   ├─ Load project config
   ├─ Load local config
   └─ Merge with priority
   ↓
3. Resolve env variables
   ├─ Load .env files
   └─ Interpolate ${VAR}
   ↓
4. Validate & Migrate
   ├─ Schema validation
   └─ Version migration
   ↓
5. Decrypt sensitive fields
   ↓
6. Store.setConfig()
```

---

## 扩展性

### 添加新工具

```typescript
// 1. 定义工具
export const MyTool: Tool = {
  name: 'MyTool',
  description: '工具描述',
  parameters: z.object({
    input: z.string()
  }),
  async execute(params, context) {
    // 实现逻辑
    return { result: 'success' };
  },
  category: 'readonly'
};

// 2. 注册工具
toolRegistry.register(MyTool);
```

### 添加新 Hook

```typescript
// .blade/settings.json
{
  "hooks": {
    "myCustomHook": {
      "enabled": true,
      "command": "node my-hook.js",
      "args": ["--option", "value"]
    }
  }
}
```

### 添加新 MCP Server

```typescript
// .blade/config.json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["./my-mcp-server.js"]
    }
  }
}
```

---

## 性能优化

### 1. Context 压缩

```typescript
// 当 token 使用超过 90% 时自动压缩
if (tokenUsage > maxTokens * 0.9) {
  messages = await compressor.compress(messages, {
    strategy: 'sliding-window',
    keepRecent: 10
  });
}
```

### 2. 工具并行执行

```typescript
// 并行执行独立工具调用
const results = await Promise.all(
  toolCalls.map(call => registry.execute(call))
);
```

### 3. 配置缓存

```typescript
// 配置只在启动时加载一次
const configManager = ConfigManager.getInstance();
const config = await configManager.initialize();
Store.setConfig(config); // 缓存到内存
```

---

## 安全设计

### 1. 路径安全

```typescript
// 限制文件访问在项目目录内
const safePath = validatePath(requestedPath, {
  allowedRoots: [cwd, ...config.addDirs],
  denyPatterns: ['node_modules', '.git']
});
```

### 2. 命令注入防护

```typescript
// 参数验证和转义
const safeArgs = args.map(arg => 
  shellEscape(arg)
);
```

### 3. 敏感信息加密

```typescript
// API Key 加密存储
const encrypted = await encrypt(apiKey);
config.models[0].apiKey = encrypted; // encrypted:base64...
```

---

## 📚 相关文档

- [贡献指南](../CONTRIBUTING.md)
- [API 文档](./api/README.md)
- [工具开发](./guides/tool-development.md)
