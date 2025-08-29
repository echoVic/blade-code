# 🗡️ Blade 配置系统文档

Blade 实现了分层配置系统，灵感来源于 [iflow](https://platform.iflow.cn/cli/configuration/settings) 的配置架构。

## 📊 配置分层架构

Blade 使用以下优先级顺序加载配置（从低到高）：

```
默认值 < 用户全局配置 < 项目级配置 < 环境变量 < CLI参数
```

### 配置优先级解释

| 来源类型 | 优先级 | 描述 |
|---------|--------|------|
| **默认值** | 0 | 内置在 Blade 中的默认设置 |
| **用户全局配置** | 1 | 保存在 `~/.blade/config.json` 中的用户级设置 |
| **项目级配置** | 2 | 保存在项目根目录的 `.blade.json` 或 `package.json#blade` |
| **环境变量** | 3 | 以 `BLADE_` 前缀的环境变量 |
| **CLI参数** | 4 | 通过命令行参数传入的配置 |

## 🔧 配置使用方式

### 1. 用户全局配置
创建用户级配置文件：
```bash
blade config init --global
```

文件位置：`~/.blade/config.json`

示例：
```json
{
  "debug": false,
  "llm": {
    "provider": "qwen",
    "apiKey": "your-api-key",
    "modelName": "qwen-turbo",
    "temperature": 0.7
  },
  "ui": {
    "theme": "dark",
    "vimMode": true
  }
}
```

### 2. 项目级配置

在项目根目录创建：

#### 方式1：`.blade.json`
```bash
blade config init --project
```

#### 方式2：package.json
```json
{
  "name": "your-project",
  "blade": {
    "debug": true,
    "llm": {
      "modelName": "qwen-plus",
      "baseUrl": "https://custom-api.com"
    },
    "security": {
      "maxFileSize": 5242880
    }
  }
}
```

### 3. 环境变量配置

所有配置项都支持环境变量，使用 `BLADE_` 前缀：

```bash
# 设置 API 密钥
export BLADE_API_KEY="your-api-key"

# 设置提供商
export BLADE_PROVIDER="qwen"

# 设置调试模式
export BLADE_DEBUG="true"

# 设置主题
export BLADE_THEME="dark"
```

完整的环境变量映射表：

| 环境变量 | 配置路径 | 示例值 |
|----------|----------|---------|
| `BLADE_API_KEY` | `llm.apiKey` | `your-api-key` |
| `BLADE_PROVIDER` | `llm.provider` | `qwen`, `volcengine` |
| `BLADE_BASE_URL` | `llm.baseUrl` | `https://api.example.com` |
| `BLADE_MODEL` | `llm.modelName` | `qwen-turbo` |
| `BLADE_TEMPERATURE` | `llm.temperature` | `0.7` |
| `BLADE_MAX_TOKENS` | `llm.maxTokens` | `2048` |
| `BLADE_DEBUG` | `debug` | `false` |
| `BLADE_THEME` | `ui.theme` | `light`, `dark`, `auto` |
| `BLADE_VIM_MODE` | `ui.vimMode` | `true`, `false` |

### 4. CLI参数配置

通过命令行参数直接设置配置：

```bash
# 设置提供商和密钥
blade chat --provider qwen --api-key your-key "你的问题"

# 设置模型和温度
blade chat --model qwen-plus --temperature 0.8 "生成代码"
```

## 📋 配置命令

### 基本命令

```bash
# 显示当前配置
blade config show

# 显示配置来源（查看各层级配置）
blade config show --source

# 显示特定配置项
blade config show --path llm.apiKey

# 设置配置值
blade config set llm.apiKey "your-key" --global
blade config set ui.theme "dark" --project

# 验证配置
blade config validate

# 初始化配置文件
blade config init --global
blade config init --project
```

### 配置向导

使用交互式向导快速配置：

```bash
blade config wizard
```

逐步引导完成：
1. 选择 LLM 提供商
2. 输入 API 密钥
3. 选择模型
4. 设置偏好

## 📁 配置文件结构

### 完整配置格式

```typescript
interface BladeConfig {
  debug?: boolean;
  
  llm: {
    provider?: 'qwen' | 'volcengine' | 'openai' | 'anthropic';
    apiKey?: string;
    baseUrl?: string;
    modelName?: string;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    timeout?: number;
    retryCount?: number;
  };
  
  tools: {
    enabled?: boolean;
    includeBuiltinTools?: boolean;
    excludeTools?: string[];
    includeCategories?: string[];
    autoConfirm?: boolean;
  };
  
  context: {
    enabled?: boolean;
    storagePath?: string;
    maxTurns?: number;
    compressionEnabled?: boolean;
  };
  
  mcp: {
    enabled?: boolean;
    servers?: string[];
    configPath?: string;
    timeout?: number;
  };
  
  logging: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    file?: string;
    console?: boolean;
  };
  
  ui: {
    theme?: 'light' | 'dark' | 'auto';
    vimMode?: boolean;
    compactOutput?: boolean;
    showProgress?: boolean;
  };
  
  security: {
    sandboxEnabled?: boolean;
    confirmDangerousOperations?: boolean;
    maxFileSize?: number;
    allowedExtensions?: string[];
  };
}
```

## 🔧 示例配置

### 开发环境

```json
{
  "debug": true,
  "llm": {
    "provider": "qwen",
    "apiKey": "sk-dev-key",
    "modelName": "qwen-turbo",
    "temperature": 0.8,
    "maxTokens": 1000
  },
  "ui": {
    "theme": "light"
  },
  "logging": {
    "level": "debug",
    "file": "blade-debug.log"
  }
}
```

### 生产环境

```json
{
  "debug": false,
  "llm": {
    "provider": "volcengine",
    "apiKey": "sk-prod-key",
    "modelName": "ep-20250612135125-br9k7",
    "timeout": 30000,
    "retryCount": 3
  },
  "security": {
    "sandboxEnabled": true,
    "confirmDangerousOperations": true,
    "maxFileSize": 10485760
  }
}
```

### 团队成员共享

```json
{
  "llm": {
    "provider": "qwen",
    "modelName": "qwen-plus",
    "temperature": 0.7
  },
  "ui": {
    "theme": "auto",
    "showProgress": true
  },
  "tools": {
    "autoConfirm": false
  }
}
```

## ⚡ 快速开始

### 首次使用

1. **使用向导**：
   ```bash
   blade config wizard
   ```

2. **手动设置 API**：
   ```bash
   # 方式1: 直接设置
   blade config set llm.apiKey "your-key" --global
   blade config set llm.provider "qwen" --global
   
   # 方式2: 环境变量
   export BLADE_API_KEY="your-key"
   ```

3. **验证配置**：
   ```bash
   blade config validate
   blade config show
   ```

### 环境变量快速设置

```bash
# 在终端中设置
export BLADE_API_KEY="your-api-key"
export BLADE_PROVIDER="qwen"
export BLADE_MODEL="qwen-turbo"

# 添加到 .bashrc 或 .zshrc
echo 'export BLADE_API_KEY="your-key"' >> ~/.zshrc
```

## 🛠️ 配置管理工具

### 编程接口

```typescript
import { ConfigManager } from 'blade-ai';

// 创建配置管理器
const configManager = new ConfigManager();

// 获取配置
const config = configManager.getConfig();
console.log(config.llm.apiKey);

// 设置配置
configManager.updateConfig({
  llm: { modelName: 'qwen-plus' }
});

// 保存到用户配置
await configManager.saveUserConfig({
  ui: { theme: 'dark' }
});

// 验证配置
const validation = configManager.validate();
```

### 高级用例

#### 多环境配置

```bash
# 开发环境
export BLADE_DEBUG=true
export BLADE_MODEL=qwen-turbo

# 生产环境
export BLADE_DEBUG=false
export BLADE_MODEL=ep-20250612135125-br9k7
```

#### 项目专用配置

在项目根目录创建 `.blade.json`：

```json
{
  "llm": {
    "apiKey": "${PROJECT_API_KEY}",
    "modelName": "qwen-coder-plus"
  },
  "tools": {
    "excludeTools": ["git_push", "git_tag"]
  }
}
```

## 📚 配置验证

Blade 会自动验证配置：

- **API密钥必备性**：检查是否配置了 API 密钥
- **数值范围**：验证 temperature (0-2), maxTokens > 0
- **枚举值验证**：provider、theme 等枚举值的正确性
- **文件存在性**：检查配置文件的存在性和可读性

验证警告示例：
```
❌ 配置验证失败：
  • API密钥未配置
  • 温度值必须在 0-2 之间
  • 最大tokens必须大于0
```

## 🔄 迁移指南

从旧配置文件迁移：

### 配置文件升级

1. 备份现有配置
2. 使用新的配置命令：
   ```bash
   blade config init --global  # 创建新格式
   blade config wizard        # 向导式配置
   ```

3. 手动迁移关键配置项

### 向后兼容性

- `AgentConfig` 接口仍然可用
- 新的配置系统优先级更高
- 老的用户配置文件将被继续使用

这就是完整的 Blade 分层配置系统文档！