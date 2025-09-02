# 🛠️ Blade 配置系统

Blade采用清晰的分层配置架构，将敏感信息和项目设置分离。

## 目录

- [📁 配置文件结构](#-配置文件结构)
- [🔧 配置方式](#-配置方式)
- [⚡ 配置优先级](#-配置优先级)
- [🎯 核心配置项](#-核心配置项)
- [📋 使用示例](#-使用示例)
- [🔍 配置管理命令](#-配置管理命令)
- [🛡️ 安全建议](#️-安全建议)
- [📂 目录结构最佳实践](#-目录结构最佳实践)
- [🎛️ 统一配置系统（开发指南）](#️-统一配置系统开发指南)

## 📁 配置文件结构

### 用户级别配置（敏感信息）
**位置**: `~/.blade/config.json`

包含API密钥等私密信息：
```json
{
  "auth": {
    "apiKey": "sk-你的API密钥",
    "baseUrl": "https://api.example.com",
    "modelName": "qwen3-coder"
  }
}
```

### 项目级别配置（非敏感设置）
**位置**: `./.blade.json`

包含项目特定设置：
```json
{
  "auth": {
    "modelName": "qwen3-coder-project-specific"
  },
  "ui": {
    "theme": "dark",
    "hideTips": false,
    "hideBanner": false
  },
  "security": {
    "sandbox": "none"
  },
  "usage": {
    "usageStatisticsEnabled": true
  }
}
```

## 🔧 配置方式

### 1. 环境变量（最高优先级）
```bash
export BLADE_API_KEY="sk-xxx"
export BLADE_BASE_URL="https://api.example.com"
export BLADE_MODEL="qwen3-coder"
```

### 2. 用户配置文件
```bash
# 创建用户配置
mkdir -p ~/.blade
echo '{
  "auth": {
    "apiKey": "sk-xxx"
  }
}' > ~/.blade/config.json
```

### 3. 项目配置文件
```bash
# 创建项目配置
echo '{
  "ui": {
    "theme": "dark"
  }
}' > .blade.json
```

### 4. CLI命令行参数
```bash
blade chat -k "sk-xxx" -u "https://api.example.com" -m "qwen3-coder" "你好"
```

## ⚡ 配置优先级

```
CLI参数 > 环境变量 > 项目配置文件 > 用户配置文件 > 默认值
```

## 🎯 核心配置项

### 认证配置
- `auth.apiKey`: API密钥（必填）
- `auth.baseUrl`: API基础URL（默认：https://apis.iflow.cn/v1）
- `auth.modelName`: 模型名称（默认：Qwen3-Coder）
- `auth.timeout`: 请求超时时间（毫秒，默认：30000）
- `auth.maxTokens`: 最大令牌数（默认：2048）
- `auth.temperature`: 采样温度（默认：0.7）
- `auth.stream`: 是否流式输出（默认：false）
- `auth.searchApiKey`: 搜索API密钥（可选）

### UI配置
- `ui.theme`: 主题（dark | light | GitHub | auto，默认：dark）
- `ui.hideTips`: 隐藏提示信息（默认：false）
- `ui.hideBanner`: 隐藏横幅（默认：false）
- `ui.outputFormat`: 输出格式（json | text | markdown，默认：text）

### 安全配置
- `security.sandbox`: 沙箱模式（docker | none，默认：none）

### 工具配置
- `tools.toolDiscoveryCommand`: 工具发现命令（可选）
- `tools.toolCallCommand`: 工具调用命令（可选）
- `tools.summarizeToolOutput`: 工具输出摘要配置（可选）

### MCP配置
- `mcp.mcpServers`: MCP服务器配置（可选）
  ```json
  {
    "server-name": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "PORT": "3000"
      }
    }
  }
  ```

### 遥测配置
- `telemetry.enabled`: 启用遥测（默认：false）
- `telemetry.target`: 遥测目标（local | remote，默认：local）
- `telemetry.otlpEndpoint`: OTLP端点（可选）
- `telemetry.logPrompts`: 记录提示（默认：false）

### 使用配置
- `usage.usageStatisticsEnabled`: 启用使用统计（默认：false）
- `usage.maxSessionTurns`: 最大会话轮数（默认：100）

### 调试配置
- `debug.debug`: 启用调试模式（默认：false）

## 📋 使用示例

### 快速开始
```bash
# 1. 设置API密钥
mkdir -p ~/.blade
echo '{
  "auth": {
    "apiKey": "sk-你的密钥"
  }
}' > ~/.blade/config.json

# 2. 开始使用
blade chat "你好世界"
```

### 团队协作
```bash
# 项目设置（可版本控制）
echo '{
  "auth": {
    "modelName": "qwen3-coder-team"
  },
  "ui": {
    "theme": "GitHub"
  }
}' > .blade.json

# 个人API密钥（不应提交）
echo '{
  "auth": {
    "apiKey": "sk-你的密钥"
  }
}' > ~/.blade/config.json
```

## 🔍 配置管理命令

```bash
# 查看当前配置
blade config show

# 验证配置
blade config validate

# 设置配置项
blade config set auth.modelName "new-model"

# 重置配置项
blade config unset ui.theme
```

## 🛡️ 安全建议

1. **用户配置文件** (`~/.blade/config.json`) 包含敏感信息，不应提交到版本控制
2. **项目配置文件** (`./.blade.json`) 可以团队共享
3. 使用环境变量在CI/CD环境中注入敏感配置
4. 定期轮换API密钥
5. 启用沙箱模式以增强安全性
6. 审查MCP服务器配置以防止恶意命令执行

## 📂 目录结构最佳实践

```
项目根目录/
├── .blade.json              # 项目设置（可共享）
├── src/
└── package.json

用户主目录/
└── .blade/
    └── config.json          # 用户API配置（私有）
```

这样设计确保了敏感信息安全，同时项目设置可以方便地团队协作。

## 🎛️ 统一配置系统（开发指南）

### 系统架构

Blade 引入了全新的分层配置系统，支持以下特性：

- **分层配置**：默认值 → 用户配置 → 项目配置 → 环境变量 → CLI参数（优先级从低到高）
- **类型安全**：使用 Zod 进行严格的配置验证
- **实时热重载**：配置文件变更时自动重载（CLI应用层）
- **纯函数式设计**：配置合并逻辑不依赖外部状态（Core包）
- **向后兼容**：保持原有 API 接口不变

### 配置结构

新的配置系统将配置分为以下模块：

```typescript
interface BladeUnifiedConfig {
  auth: AuthConfig;        // 认证配置
  ui: UIConfig;            // UI 配置
  security: SecurityConfig; // 安全配置
  tools: ToolsConfig;      // 工具配置
  mcp: MCPConfig;          // MCP 配置
  telemetry?: TelemetryConfig; // 遥测配置
  usage: UsageConfig;      // 使用配置
  debug: DebugConfig;      // 调试配置
}
```

### 开发者 API

#### createConfig 函数

```typescript
import { createConfig, ConfigLayers } from '@blade-ai/core';

// 定义配置层
const layers: ConfigLayers = {
  defaults: {
    auth: {
      baseUrl: 'https://apis.iflow.cn/v1',
      modelName: 'Qwen3-Coder'
    }
  },
  user: {
    auth: {
      apiKey: 'user-api-key'
    }
  },
  project: {
    ui: {
      theme: 'dark'
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

#### 在 CLI 应用层使用配置

```typescript
// packages/cli/src/config/ConfigService.ts
import { createConfig } from '@blade-ai/core';

export class ConfigService {
  async initialize() {
    // 加载所有配置层
    const layers = {
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
```

#### React Hooks（CLI应用层）

```typescript
// packages/cli/src/contexts/SessionContext.tsx
import React, { createContext, useContext, useReducer } from 'react';

interface SessionState {
  config: any;
  messages: any[];
  isThinking: boolean;
  error: string | null;
}

const SessionContext = createContext<{
  state: SessionState;
  dispatch: React.Dispatch<any>;
} | undefined>(undefined);

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
```

#### 配置验证

```typescript
import { BladeUnifiedConfigSchema } from '@blade-ai/core';

try {
  const validatedConfig = BladeUnifiedConfigSchema.parse(config);
  console.log('配置验证通过');
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('配置验证失败:', error.errors);
  }
}
```

### 配置层加载顺序

1. **defaults**: 系统默认配置（Core包内置）
2. **user**: 用户配置 (`~/.blade/config.json`)
3. **project**: 项目配置 (`./.blade.json`)
4. **environment**: 环境变量 (`BLADE_*`)
5. **cli**: CLI参数

### 配置热重载（CLI应用层）

```typescript
// packages/cli/src/config/ConfigService.ts
import { createConfig } from '@blade-ai/core';
import chokidar from 'chokidar';

export class ConfigService {
  private watcher: any;
  
  async initialize() {
    // ... 初始化配置
    
    // 监听配置文件变更
    this.watcher = chokidar.watch([
      '~/.blade/config.json',
      './.blade.json'
    ]);
    
    this.watcher.on('change', () => {
      this.reloadConfig();
    });
  }
  
  async reloadConfig() {
    const newConfig = await this.initialize();
    // 通知应用配置已更新
    this.emit('configChange', newConfig);
  }
}
```

新的配置系统为 Blade 提供了更强大、更灵活的配置管理能力，完全符合重构后的 Monorepo 架构设计。