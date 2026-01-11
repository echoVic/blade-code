# ⚙️ 配置系统

Blade 使用双文件配置体系：`config.json`（基础配置）和 `settings.json` / `settings.local.json`（行为配置）。

## 文件位置与优先级

```
~/.blade/                    # 用户级
  ├─ config.json             # 基础配置（模型、UI）
  └─ settings.json           # 行为配置（权限、Hooks）

<project>/.blade/            # 项目级
  ├─ config.json             # 项目基础配置
  ├─ settings.json           # 项目行为配置
  └─ settings.local.json     # 个人覆盖（自动加入 .gitignore）
```

**优先级**（高 → 低）：

环境变量插值 > settings.local.json > 项目 settings.json > 用户 settings.json > 项目 config.json > 用户 config.json > 默认值

## 内置免费模型

Blade Code v0.1.0 内置了免费的 GLM-4.7 模型，无需任何配置即可使用：

- **模型**: GLM-4.7 Thinking（智谱）
- **特性**: 支持思维链推理
- **上下文**: 204,800 tokens
- **输出**: 16,384 tokens

首次启动时会自动使用内置模型。如需使用自己的 API 密钥，可通过 `/model add` 向导或手动编辑配置文件。

## config.json（基础配置）

### 多模型配置

Blade 支持配置多个模型，通过 `currentModelId` 指定当前使用的模型：

```json
{
  "currentModelId": "qwen-main",
  "models": [
    {
      "id": "qwen-main",
      "name": "Qwen Max",
      "provider": "openai-compatible",
      "apiKey": "${QWEN_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max",
      "temperature": 0,
      "maxContextTokens": 128000
    },
    {
      "id": "deepseek-r1",
      "name": "DeepSeek R1",
      "provider": "openai-compatible",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-reasoner",
      "supportsThinking": true,
      "thinkingBudget": 16000
    },
    {
      "id": "claude-sonnet",
      "name": "Claude 3.5 Sonnet",
      "provider": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-3-5-sonnet-20241022"
    },
    {
      "id": "gemini-pro",
      "name": "Gemini 1.5 Pro",
      "provider": "gemini",
      "apiKey": "${GEMINI_API_KEY}",
      "model": "gemini-1.5-pro-latest",
      "maxContextTokens": 1000000
    }
  ]
}
```

### 支持的 Provider

| Provider | 说明 | 必填字段 |
|----------|------|----------|
| `openai-compatible` | OpenAI 兼容接口（Qwen、DeepSeek、Ollama 等） | baseUrl, apiKey, model |
| `anthropic` | Anthropic Claude | apiKey, model |
| `gemini` | Google Gemini | apiKey, model |
| `azure-openai` | Azure OpenAI Service | baseUrl, apiKey, model, apiVersion |
| `copilot` | GitHub Copilot（OAuth 认证） | - |
| `antigravity` | Google Antigravity（OAuth 认证） | projectId |

### 模型字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识（自动生成或手动指定） |
| `name` | string | 显示名称 |
| `provider` | string | 提供商类型 |
| `apiKey` | string | API 密钥（支持环境变量插值） |
| `baseUrl` | string | API 端点地址 |
| `model` | string | 模型标识 |
| `temperature` | number | 采样温度（0-2） |
| `maxContextTokens` | number | 上下文窗口大小 |
| `maxOutputTokens` | number | 输出 token 限制 |
| `topP` | number | Top-P 采样参数 |
| `topK` | number | Top-K 采样参数 |
| `supportsThinking` | boolean | 是否支持思维链（DeepSeek R1 等） |
| `thinkingBudget` | number | 思维链 token 预算 |
| `apiVersion` | string | API 版本（Azure OpenAI 必填） |

### 通用参数

```json
{
  "temperature": 0.0,
  "maxContextTokens": 128000,
  "maxOutputTokens": 32768,
  "stream": true,
  "topP": 0.9,
  "topK": 50,
  "timeout": 180000,
  "theme": "GitHub",
  "language": "zh-CN",
  "debug": false,
  "mcpEnabled": false,
  "mcpServers": {}
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `temperature` | 默认采样温度 | `0.0` |
| `maxContextTokens` | 上下文窗口（用于压缩判断） | `128000` |
| `maxOutputTokens` | 单次回复输出上限 | `32768` |
| `stream` | 是否流式输出 | `true` |
| `timeout` | LLM 请求超时（毫秒） | `180000` |
| `theme` | UI 主题 | `GitHub` |
| `language` | 界面语言 | `zh-CN` |
| `debug` | 调试模式 | `false` |
| `mcpEnabled` | 是否启用 MCP | `false` |
| `mcpServers` | MCP 服务器配置 | `{}` |

## settings.json（行为配置）

### 权限配置

```json
{
  "permissionMode": "default",
  "permissions": {
    "allow": [
      "Bash(git status*)",
      "Bash(ls *)",
      "Read(file_path:**/*.ts)"
    ],
    "ask": [
      "Write",
      "Edit"
    ],
    "deny": [
      "Read(file_path:**/.env*)",
      "Bash(rm -rf *)",
      "Bash(sudo *)"
    ]
  }
}
```

### 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 只读工具自动通过，写入和执行需确认 |
| `autoEdit` | 只读+写入自动通过，执行需确认 |
| `plan` | 仅允许只读工具，拒绝所有修改 |
| `yolo` | 所有工具自动通过（危险） |
| `spec` | Spec 模式，结构化开发工作流 |

### Hooks 配置

```json
{
  "hooks": {
    "enabled": true,
    "timeout": 30000,
    "PostToolUse": {
      "Write": "npx prettier --write {file_path}",
      "Edit": "npx prettier --write {file_path}"
    }
  }
}
```

### 其他配置

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `env` | 注入到会话的环境变量 | `{}` |
| `disableAllHooks` | 全局禁用 Hooks | `false` |
| `maxTurns` | 轮次上限（0 禁用，-1 默认，上限 100） | `-1` |

## settings.local.json

用于个人偏好或临时授权，自动加入 `.gitignore`：

```json
{
  "permissionMode": "autoEdit",
  "permissions": {
    "allow": [
      "Bash(npm run build*)",
      "Bash(pnpm *)"
    ]
  }
}
```

## 环境变量插值

所有字符串字段支持环境变量插值：

```json
{
  "apiKey": "${QWEN_API_KEY}",
  "baseUrl": "${BLADE_BASE_URL:-https://api.example.com/v1}"
}
```

支持的语法：

- `$VAR` - 简单引用
- `${VAR}` - 花括号引用
- `${VAR:-default}` - 带默认值

## MCP 服务器配置

```json
{
  "mcpEnabled": true,
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    "remote-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

### MCP 服务器字段

| 字段 | 说明 |
|------|------|
| `type` | 传输类型：`stdio`、`http`、`sse` |
| `command` | stdio 类型的命令 |
| `args` | 命令参数 |
| `env` | 环境变量 |
| `url` | http/sse 类型的 URL |
| `headers` | HTTP 请求头 |
| `timeout` | 超时时间（毫秒） |

## 完整配置示例

### 用户配置 `~/.blade/config.json`

```json
{
  "currentModelId": "qwen",
  "models": [
    {
      "id": "qwen",
      "name": "Qwen Max",
      "provider": "openai-compatible",
      "apiKey": "${QWEN_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max"
    }
  ],
  "theme": "GitHub",
  "language": "zh-CN",
  "debug": false
}
```

### 项目配置 `.blade/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm run *)",
      "Read(file_path:**/*.{ts,tsx,js,jsx})"
    ],
    "deny": [
      "Read(file_path:**/.env*)",
      "Bash(rm -rf *)"
    ]
  },
  "hooks": {
    "PostToolUse": {
      "Write": "npx prettier --write {file_path}"
    }
  },
  "env": {
    "NODE_ENV": "development"
  }
}
```

### 个人覆盖 `.blade/settings.local.json`

```json
{
  "permissionMode": "autoEdit",
  "permissions": {
    "allow": [
      "Bash(npm run build*)"
    ]
  }
}
```

## 配置入口

- **首次启动**：若未检测到模型，自动使用内置免费模型 GLM-4.7
- **UI 内配置**：输入 `/model add` 打开向导添加自定义模型
- **手工编辑**：直接修改配置文件，保存后下次启动生效
- **自动写入**：在权限确认弹窗中选择"会话内记住"会写入 `settings.local.json`

## 相关资源

- [权限控制](permissions.md) - 详细的权限配置说明
- [主题配置](themes.md) - 主题自定义
- [CLI 命令](../reference/cli-commands.md) - 命令行参数
