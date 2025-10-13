# 📖 Blade API 参考

## 🎯 核心包结构

```
@blade-ai/core/
├── agent/          # Agent 核心组件系统
├── config/         # 统一配置系统
├── context/        # 上下文管理系统
├── llm/            # LLM 提供商实现
├── mcp/            # MCP 协议支持
├── services/       # 核心业务服务
├── tools/          # 工具系统
├── telemetry/      # 遥测系统
├── types/          # 共享类型定义
└── utils/          # 通用工具函数
```

## 🚀 快速开始

### 安装

```bash
npm install @blade-ai/core
# 或
pnpm add @blade-ai/core
# 或
yarn add @blade-ai/core
```

### 基本使用

```typescript
import { createAgent } from '@blade-ai/core';

// 创建 Agent 实例
const agent = await createAgent({
  auth: {
    apiKey: process.env.BLADE_API_KEY || 'sk-xxx',
    baseUrl: 'https://api.example.com',
    model: 'qwen3-coder'
  }
});

// 基础聊天
const response = await agent.chat('你好，世界！');
console.log(response.content);

// 系统提示词聊天
const response2 = await agent.chatWithSystem(
  '你是一个专业的 JavaScript 开发者', 
  '帮我写一个快速排序函数'
);
console.log(response2.content);
```

## 🧠 Agent 核心 API

### `createAgent` - 创建 Agent 实例

```typescript
import { createAgent, BladeUnifiedConfig } from '@blade-ai/core';

// 配置选项
const config: BladeUnifiedConfig = {
  auth: {
    apiKey: 'sk-xxx',
    baseUrl: 'https://api.example.com',
    model: 'qwen3-coder',
    timeout: 30000,
    maxTokens: 2048
  },
  ui: {
    theme: 'dark',
    hideTips: false,
    hideBanner: false
  },
  security: {
    sandbox: 'none'
  }
};

// 创建 Agent
const agent = await createAgent(config);

// 使用 Agent
const response = await agent.chat('你好');
```

### Agent 实例方法

```typescript
// 基础聊天
const response = await agent.chat('你好');

// 系统提示词聊天
const response = await agent.chatWithSystem(
  '你是一个代码助手', 
  '写一个快速排序函数'
);

// 多轮对话
const messages = [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好！有什么可以帮助你的吗？' },
  { role: 'user', content: '再问一个问题' }
];
const response = await agent.conversation(messages);

// 工具调用
const result = await agent.executeTool('git.status');

// 获取配置
const config = agent.getConfig();

// 更新配置
await agent.updateConfig({
  auth: {
    model: 'new-model'
  }
});

// 销毁 Agent（清理资源）
await agent.destroy();
```

## ⚙️ 配置系统 API

### `createConfig` - 创建分层配置

```typescript
import { createConfig, ConfigLayers } from '@blade-ai/core';

// 定义配置层
const layers: ConfigLayers = {
  defaults: {
    auth: {
      baseUrl: 'https://apis.iflow.cn/v1',
      model: 'Qwen3-Coder'
    },
    ui: {
      theme: 'dark'
    }
  },
  user: {
    auth: {
      apiKey: 'user-api-key'
    }
  },
  project: {
    ui: {
      theme: 'light'
    }
  },
  environment: {
    auth: {
      apiKey: process.env.BLADE_API_KEY
    }
  },
  cli: {
    debug: {
      debug: true
    }
  }
};

// 创建合并后的配置
const result = createConfig(layers, { validate: true });
console.log(result.config); // 合并后的配置
console.log(result.sources); // 配置来源信息
```

## 🛠️ 工具系统 API

### 内置工具调用

```typescript
import { createAgent } from '@blade-ai/core';

const agent = await createAgent(config);

// Git 工具
const gitStatus = await agent.executeTool('git.status');
const gitDiff = await agent.executeTool('git.diff', {
  file: 'src/index.ts'
});

// 文件系统工具
const fileContent = await agent.executeTool('fs.readFile', {
  path: 'src/index.ts'
});

const writeFile = await agent.executeTool('fs.writeFile', {
  path: 'output.txt',
  content: 'Hello World'
});

// 网络工具
const fetchResult = await agent.executeTool('net.fetch', {
  url: 'https://api.example.com/data',
  method: 'GET'
});
```

## 📋 核心类型定义

### `BladeUnifiedConfig` - 统一配置接口

```typescript
interface BladeUnifiedConfig {
  // 认证配置
  auth: {
    apiKey: string;
    baseUrl: string;
    model: string;
    searchApiKey?: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
  };
  
  // UI 配置
  ui: {
    theme: 'GitHub' | 'dark' | 'light' | 'auto';
    hideTips?: boolean;
    hideBanner?: boolean;
    outputFormat?: 'json' | 'text' | 'markdown';
  };
  
  // 安全配置
  security: {
    sandbox: 'docker' | 'none';
  };
  
  // 工具配置
  tools: {
    toolDiscoveryCommand?: string;
    toolCallCommand?: string;
    summarizeToolOutput?: Record<string, { tokenBudget?: number }>;
  };
  
  // MCP 配置
  mcp: {
    mcpServers?: Record<string, {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
  
  // 遥测配置
  telemetry?: {
    enabled?: boolean;
    target?: 'local' | 'remote';
    otlpEndpoint?: string;
    logPrompts?: boolean;
  };
  
  // 使用配置
  usage: {
    usageStatisticsEnabled?: boolean;
    maxSessionTurns?: number;
  };
  
  // 调试配置
  debug: {
    debug?: boolean;
  };
}
```

### `ConfigLayers` - 配置层接口

```typescript
interface ConfigLayers {
  defaults?: Partial<BladeUnifiedConfig>;
  user?: Partial<BladeUnifiedConfig>;
  project?: Partial<BladeUnifiedConfig>;
  environment?: Partial<BladeUnifiedConfig>;
  cli?: Partial<BladeUnifiedConfig>;
}
```

### `AgentResponse` - Agent 响应接口

```typescript
interface AgentResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
  tools?: Array<{
    name: string;
    arguments: Record<string, any>;
    result: any;
  }>;
}
```

### `ToolResult` - 工具执行结果接口

```typescript
interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  metadata?: Record<string, any>;
}
```

## 🔄 配置加载和合并

### 配置层优先级

Blade 使用分层配置系统，配置层按以下优先级从低到高合并：

1. **defaults** - 系统默认配置
2. **user** - 用户配置 (~/.blade/config.json)
3. **project** - 项目配置 (./.blade.json)
4. **environment** - 环境变量 (BLADE_*)
5. **cli** - CLI 参数

### 配置验证

所有配置在合并后都会通过 Zod Schema 进行验证，确保类型安全和数据有效性。

## 📦 CLI 应用层 API

CLI 应用层通过 `@blade-ai/core` 包的公共 API 完成所有业务逻辑：

```typescript
// packages/cli/src/config/ConfigService.ts
import { createConfig, ConfigLayers } from '@blade-ai/core';

export class ConfigService {
  async initialize() {
    // 加载所有配置层
    const layers: ConfigLayers = {
      defaults: await this.loadDefaultConfig(),
      user: await this.loadUserConfig(),
      project: await this.loadProjectConfig(),
      environment: this.loadEnvironmentConfig(),
      cli: this.loadCliConfig()
    };
    
    // 创建合并配置
    const result = createConfig(layers, { validate: true });
    return result.config;
  }
}

// packages/cli/src/services/CommandOrchestrator.ts
import { createAgent } from '@blade-ai/core';

export class CommandOrchestrator {
  private agent: any;
  
  async initialize() {
    const config = await this.configService.initialize();
    this.agent = await createAgent(config);
  }
  
  async executeNaturalLanguage(input: string) {
    return await this.agent.chat(input);
  }
  
  async executeSlashCommand(command: string, args: string[]) {
    switch (command) {
      case 'help':
        return { success: true, output: this.generateHelpText() };
      case 'config':
        return { success: true, output: JSON.stringify(this.agent.getConfig(), null, 2) };
      default:
        return { success: false, error: `未知命令: ${command}` };
    }
  }
}
```

## 🔧 错误处理

### 核心错误类型

```typescript
// 配置错误
class ConfigValidationError extends Error {
  constructor(message: string, public errors: ZodError[]) {
    super(message);
  }
}

// 工具执行错误
class ToolExecutionError extends Error {
  constructor(message: string, public toolName: string) {
    super(message);
  }
}

// LLM 调用错误
class LLMApiError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
  }
}
```

### 错误处理示例

```typescript
import { ConfigValidationError, ToolExecutionError } from '@blade-ai/core';

try {
  const agent = await createAgent(config);
  const result = await agent.executeTool('git.status');
  console.log(result.output);
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error('配置验证失败:', error.errors);
  } else if (error instanceof ToolExecutionError) {
    console.error(`工具执行失败 ${error.toolName}:`, error.message);
  } else {
    console.error('未知错误:', error);
  }
}
```

## 🧪 测试和集成

### 单元测试

```typescript
// packages/core/tests/config.test.ts
import { createConfig } from '../src/config';

describe('配置系统', () => {
  test('配置层正确合并', () => {
    const layers = {
      defaults: { auth: { model: 'default' } },
      user: { auth: { model: 'user' } }
    };
    
    const result = createConfig(layers);
    expect(result.config.auth.model).toBe('user');
  });
});
```

### 集成测试

```typescript
// packages/core/tests/integration.test.ts
import { createAgent } from '../src';

describe('核心集成测试', () => {
  test('Agent 创建和基本功能', async () => {
    const agent = await createAgent({
      auth: {
        apiKey: 'test-key',
        model: 'test-model'
      }
    });
    
    expect(agent).toBeDefined();
    expect(agent.getConfig().auth.model).toBe('test-model');
  });
});
```

## 🚀 最佳实践

### 1. 配置管理

```typescript
// 推荐：使用分层配置系统
import { createConfig } from '@blade-ai/core';

const config = createConfig({
  defaults: defaultConfig,
  user: userConfig,
  project: projectConfig,
  environment: envConfig
});
```

### 2. 资源管理

```typescript
// 推荐：正确销毁 Agent 以释放资源
const agent = await createAgent(config);

try {
  // 使用 Agent
  const response = await agent.chat('Hello');
  console.log(response.content);
} finally {
  // 确保资源被正确释放
  await agent.destroy();
}
```

### 3. 错误处理

```typescript
// 推荐：完整的错误处理
try {
  const agent = await createAgent(config);
  const result = await agent.executeTool('git.status');
  
  if (result.success) {
    console.log(result.output);
  } else {
    console.error('工具执行失败:', result.error);
  }
} catch (error) {
  console.error('系统错误:', error);
}
```