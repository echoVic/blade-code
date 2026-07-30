# API 文档

Blade Code 提供了完善的 API，支持编程式集成和扩展开发。

## 📋 目录

- [核心 API](#核心-api)
- [配置 API](#配置-api)
- [Agent API](#agent-api)
- [工具 API](#工具-api)
- [MCP API](#mcp-api)
- [类型定义](#类型定义)

---

## 核心 API

### BladeClient

主要的客户端类，提供与 Blade Code 交互的接口。

```typescript
import { BladeClient } from 'blade-code';

// 创建客户端
const client = new BladeClient({
  baseUrl: 'http://localhost:4097',
  apiKey: 'your-api-key'
});

// 发送消息
const response = await client.chat({
  message: 'Hello, Blade!',
  sessionId: 'my-session'
});

// 流式响应
for await (const chunk of client.streamChat({
  message: 'Tell me a story',
  sessionId: 'my-session'
})) {
  console.log(chunk);
}
```

#### 方法

##### `chat(options: ChatOptions): Promise<ChatResponse>`

发送消息并获取完整响应。

**参数**：
- `message` (string): 用户消息
- `sessionId` (string, 可选): 会话 ID
- `model` (string, 可选): 模型 ID
- `systemPrompt` (string, 可选): 自定义系统提示

**返回**：
```typescript
interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  sessionId: string;
  timestamp: number;
}
```

##### `streamChat(options: ChatOptions): AsyncIterable<ChatChunk>`

流式发送消息。

**返回**：
```typescript
interface ChatChunk {
  type: 'text' | 'tool_call' | 'error';
  content: string;
  delta?: string;
}
```

---

## 配置 API

### ConfigManager

配置管理器，负责加载和管理配置。

```typescript
import { ConfigManager } from 'blade-code/config';

// 获取单例实例
const configManager = ConfigManager.getInstance();

// 初始化配置
const config = await configManager.initialize();

// 验证配置
configManager.validateConfig(config);
```

#### 方法

##### `initialize(): Promise<BladeConfig>`

初始化配置系统，加载所有配置文件。

**返回**：完整的 `BladeConfig` 对象

##### `validateConfig(config: BladeConfig): void`

验证配置完整性。

**抛出**：配置无效时抛出错误

### ConfigService

配置持久化服务。

```typescript
import { ConfigService } from 'blade-code/config';

const service = new ConfigService();

// 保存配置
await service.saveConfig({
  theme: 'dark',
  language: 'zh-CN'
}, 'global');

// 保存权限配置
await service.savePermissions({
  allow: ['Read', 'Write'],
  ask: ['Bash'],
  deny: []
}, 'project');
```

#### 方法

##### `saveConfig(config: Partial<BladeConfig>, scope: ConfigScope): Promise<void>`

保存配置到指定作用域。

**参数**：
- `config`: 配置对象（部分）
- `scope`: 'global' | 'project' | 'local'

---

## Agent API

### Agent

无状态 Agent 核心。

```typescript
import { Agent } from 'blade-code/agent';

const agent = new Agent({
  config: bladeConfig,
  tools: toolRegistry
});

// 执行对话轮次
const result = await agent.executeTurn({
  messages: chatHistory,
  context: chatContext
});
```

#### 方法

##### `executeTurn(options: ExecuteTurnOptions): Promise<TurnResult>`

执行单个对话轮次。

**参数**：
```typescript
interface ExecuteTurnOptions {
  messages: Message[];
  context: ChatContext;
  signal?: AbortSignal;
}
```

**返回**：
```typescript
interface TurnResult {
  message: AssistantMessage;
  toolResults?: ToolResult[];
  status: 'success' | 'error' | 'aborted';
}
```

---

## 工具 API

### ToolRegistry

工具注册表。

```typescript
import { ToolRegistry } from 'blade-code/tools';

const registry = new ToolRegistry();

// 注册工具
registry.register({
  name: 'MyTool',
  description: '自定义工具',
  parameters: z.object({
    input: z.string()
  }),
  execute: async (params, context) => {
    return { result: `Processed: ${params.input}` };
  }
});

// 获取工具
const tool = registry.get('MyTool');

// 执行工具
const result = await tool.execute({ input: 'test' }, context);
```

### 创建自定义工具

```typescript
import { z } from 'zod';
import type { Tool, ToolContext } from 'blade-code/tools';

export const MyCustomTool: Tool = {
  name: 'MyCustomTool',
  description: '这是一个自定义工具',
  
  // Zod schema 定义参数
  parameters: z.object({
    query: z.string().describe('查询字符串'),
    limit: z.number().optional().default(10)
  }),
  
  // 执行函数
  async execute(params, context: ToolContext) {
    const { query, limit } = params;
    
    // 访问上下文
    const { cwd, config, sessionId } = context;
    
    // 执行逻辑
    const results = await searchSomething(query, limit);
    
    return {
      success: true,
      data: results
    };
  },
  
  // 可选：权限检查
  category: 'readonly', // 'readonly' | 'write' | 'execute'
};
```

---

## MCP API

### MCP Client

Model Context Protocol 客户端。

```typescript
import { MCPClient } from 'blade-code/mcp';

const client = new MCPClient({
  type: 'stdio',
  command: 'node',
  args: ['path/to/server.js']
});

// 连接
await client.connect();

// 列出工具
const tools = await client.listTools();

// 调用工具
const result = await client.callTool('tool-name', {
  param1: 'value1'
});

// 断开连接
await client.disconnect();
```

---

## 类型定义

### BladeConfig

```typescript
interface BladeConfig {
  // 模型配置
  currentModelId: string;
  models: ModelConfig[];
  
  // 全局参数
  temperature: number;
  maxContextTokens: number;
  maxOutputTokens?: number;
  stream: boolean;
  topP: number;
  topK: number;
  timeout: number;
  
  // UI
  theme: string;
  uiTheme: UiTheme;
  language: string;
  fontSize: number;
  
  // 权限
  permissions: PermissionConfig;
  permissionMode: PermissionMode;
  
  // MCP
  mcpEnabled: boolean;
  mcpServers: Record<string, McpServerConfig>;
  
  // Hooks
  hooks: HookConfig;
  
  // 其他
  debug: boolean | string;
  env: Record<string, string>;
  maxTurns: number;
}
```

### ModelConfig

```typescript
interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  apiVersion?: string;
  projectId?: string;
}
```

### ChatContext

```typescript
interface ChatContext {
  sessionId: string;
  cwd: string;
  config: BladeConfig;
  tools: ToolRegistry;
  messages: Message[];
  abortSignal?: AbortSignal;
}
```

### Message Types

```typescript
type Message = UserMessage | AssistantMessage | SystemMessage;

interface UserMessage {
  role: 'user';
  content: string;
  timestamp: number;
}

interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

interface SystemMessage {
  role: 'system';
  content: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}
```

---

## 示例

### 创建自定义 CLI

```typescript
#!/usr/bin/env node
import { BladeClient } from 'blade-code';
import { ConfigManager } from 'blade-code/config';

async function main() {
  // 加载配置
  const configManager = ConfigManager.getInstance();
  const config = await configManager.initialize();
  
  // 创建客户端
  const client = new BladeClient({
    config
  });
  
  // 发送消息
  const response = await client.chat({
    message: process.argv[2] || 'Hello!',
    sessionId: 'cli-session'
  });
  
  console.log(response.content);
}

main();
```

### 集成到 Express

```typescript
import express from 'express';
import { BladeClient } from 'blade-code';

const app = express();
app.use(express.json());

const client = new BladeClient();

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  
  try {
    const response = await client.chat({ message, sessionId });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000);
```

---

## 📚 相关文档

- [工具开发指南](./tool-development.md)
- [MCP 协议](./mcp-protocol.md)
- [插件开发](./plugin-development.md)
- [类型参考](./type-reference.md)
