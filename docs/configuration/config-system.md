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

### 临时 CLI 设置

CLI、TUI、print 和 headless 模式支持通过 `--settings` 传入一个 JSON 文件或内联 JSON。该配置仅对当前进程生效，不会写入用户或项目配置：

```bash
# 文件路径相对于启动 Blade 时的工作目录解析
blade --settings ./automation-settings.json

# 也可以直接传入 JSON
blade --settings '{"permissionMode":"autoEdit","maxTurns":8}'
```

`--settings` 位于用户、项目和 `settings.local.json` 之上的临时配置层。显式命令行参数仍然具有最高优先级，例如 `--yolo` 会覆盖设置中的 `permissionMode`，`--max-turns 12` 会覆盖设置中的 `maxTurns`。

Blade 会在启动模型请求前校验临时设置。无效 JSON、未知字段或已知字段的错误类型都会直接终止启动，避免自动化任务在错误配置下继续运行。不要把 API key 作为内联 JSON 传入；密钥应继续通过受保护的环境变量或本地配置提供，以免进入 shell 历史和进程参数。

## 模型配置向导

### 80+ Provider 支持

Blade 集成了 [models.dev](https://models.dev) API，支持 **80+ LLM Provider**，包括：

| 分类 | Provider |
|------|----------|
| **热门** | Anthropic, OpenAI, DeepSeek, Google, Groq, OpenRouter |
| **云服务** | Azure, AWS Bedrock, Google Vertex, Cloudflare |
| **开源友好** | Together AI, Fireworks, Cerebras, Novita AI |
| **本地部署** | Ollama, LM Studio |
| **其他** | Mistral, Cohere, Perplexity, xAI, NVIDIA 等 |

### 向导配置流程

输入 `/model add` 启动配置向导：

```
Step 1: 选择 Provider（支持搜索 80+ 选项）
        ┌─────────────────────────────────────┐
        │  📡 选择 Provider          [搜索]   │
        │  ▶ Anthropic (🤖)                   │
        │    OpenAI (⚡)                       │
        │    DeepSeek (🌊)                    │
        │    Google (✨)                      │
        │    Groq (🚀)                        │
        │    OpenRouter (🔀)                  │
        │    ... 更多                         │
        └─────────────────────────────────────┘

Step 2: 输入 API Key
        ┌─────────────────────────────────────┐
        │  🔑 输入 Anthropic API Key          │
        │  ▶ sk-ant-___________________________│
        │  💡 环境变量: ANTHROPIC_API_KEY     │
        │  📖 获取密钥: docs.anthropic.com    │
        └─────────────────────────────────────┘

Step 3: 选择模型（从内置列表选择）
        ┌─────────────────────────────────────┐
        │  🤖 选择模型              [搜索]    │
        │  ▶ claude-sonnet-4-0 (推荐)         │
        │    claude-opus-4-0                  │
        │    claude-3-5-sonnet-latest         │
        │    ... 更多                         │
        └─────────────────────────────────────┘
```

### 自定义 Provider

如果你的 Provider 不在列表中，选择 **🔧 自定义 OpenAI Compatible**：

```
Step 1: 选择 "🔧 自定义 OpenAI Compatible"
        ┌─────────────────────────────────────┐
        │  📡 选择 Provider          [搜索]   │
        │  ▶ 🔧 自定义 OpenAI Compatible      │
        │    🤖 Anthropic                     │
        │    ... 更多                         │
        └─────────────────────────────────────┘

Step 2: 输入 API Key
        ┌─────────────────────────────────────┐
        │  🔑 输入 API Key                    │
        │  ▶ sk-_____________________________ │
        └─────────────────────────────────────┘

Step 3: 输入 Base URL（必填）
        ┌─────────────────────────────────────┐
        │  🌐 输入 Base URL                   │
        │  ▶ https://api.example.com/v1______ │
        └─────────────────────────────────────┘

Step 4: 输入模型名称
        ┌─────────────────────────────────────┐
        │  🤖 输入模型名称                    │
        │  ▶ gpt-4o-mini_____________________ │
        └─────────────────────────────────────┘
```

适用于任何兼容 OpenAI API 格式的服务，如：
- 私有部署的 LLM 服务
- 企业内部 API 网关
- 其他未列出的第三方服务

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
      "apiKey": "sk-xxxxx",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max",
      "temperature": 0,
      "maxContextTokens": 128000
    },
    {
      "id": "deepseek-r1",
      "name": "DeepSeek R1",
      "provider": "openai-compatible",
      "apiKey": "sk-xxxxx",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-reasoner",
      "supportsThinking": true,
      "thinkingBudget": 16000
    },
    {
      "id": "claude-sonnet",
      "name": "Claude Sonnet 4",
      "provider": "anthropic",
      "apiKey": "sk-ant-api03-xxxxx",
      "model": "claude-sonnet-4-0"
    },
    {
      "id": "gemini-pro",
      "name": "Gemini 2.0 Flash",
      "provider": "gemini",
      "apiKey": "AIzaSy-xxxxx",
      "model": "gemini-2.0-flash",
      "maxContextTokens": 1000000
    }
  ]
}
```

> **注意**: API Key 直接写在配置文件中。推荐使用 `/model add` 向导配置。

### 支持的 Provider 类型

| Provider | 说明 | 必填字段 |
|----------|------|----------|
| `openai-compatible` | OpenAI 兼容接口（60+ Provider 通用） | baseUrl, apiKey, model |
| `anthropic` | Anthropic Claude | apiKey, model |
| `gemini` | Google Gemini | apiKey, model |
| `azure-openai` | Azure OpenAI Service | baseUrl, apiKey, model, apiVersion |

### Provider 与 Service 映射

大多数 Provider 使用 **OpenAI 兼容 API**，只需配置不同的 `baseUrl`：

| models.dev Provider | Blade Service | 说明 |
|---------------------|---------------|------|
| `anthropic` | `anthropic` | Claude 专有 API |
| `google`, `google-vertex` | `gemini` | Gemini 专有 API |
| `azure` | `azure-openai` | Azure 特殊认证 |
| 其他 60+ Provider | `openai-compatible` | OpenAI 兼容 API |

### 常用 Provider Base URL

| Provider | Base URL |
|----------|----------|
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Together AI | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Perplexity | `https://api.perplexity.ai` |
| xAI | `https://api.x.ai/v1` |
| Cerebras | `https://api.cerebras.ai/v1` |
| NVIDIA | `https://integrate.api.nvidia.com/v1` |

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
| `providerId` | string | models.dev Provider ID（用于自动注入特定 headers） |

### Provider 特定 Headers

某些 Provider 需要特殊的 HTTP Headers，Blade 会自动注入：

| Provider | Headers | 用途 |
|----------|---------|------|
| `anthropic` | `anthropic-beta` | 启用 Claude Code、Interleaved Thinking 等 beta 功能 |
| `openrouter` | `HTTP-Referer`, `X-Title` | 标识来源应用 |
| `cerebras` | `X-Cerebras-3rd-Party-Integration` | 第三方集成标识 |

当通过向导配置时，`providerId` 会自动设置，无需手动配置。

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

**顶层字符串字段**支持环境变量插值：

```json
{
  "theme": "${BLADE_THEME:-GitHub}",
  "language": "${BLADE_LANG:-zh-CN}"
}
```

支持的语法：

- `$VAR` - 简单引用
- `${VAR}` - 花括号引用
- `${VAR:-default}` - 带默认值

> **限制**: 环境变量插值仅适用于顶层字符串字段。`models` 数组中的 `apiKey` 等嵌套字段**不支持**环境变量插值，需要直接填写实际值。

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
  "currentModelId": "claude",
  "models": [
    {
      "id": "claude",
      "name": "Claude Sonnet 4",
      "provider": "anthropic",
      "providerId": "anthropic",
      "apiKey": "sk-ant-api03-xxxxx",
      "model": "claude-sonnet-4-0"
    },
    {
      "id": "deepseek",
      "name": "DeepSeek R1",
      "provider": "openai-compatible",
      "providerId": "deepseek",
      "apiKey": "sk-xxxxx",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-reasoner",
      "supportsThinking": true
    },
    {
      "id": "groq",
      "name": "Groq Llama 3.3",
      "provider": "openai-compatible",
      "providerId": "groq",
      "apiKey": "gsk_xxxxx",
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "llama-3.3-70b-versatile"
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
- **UI 内配置**：输入 `/model add` 打开向导添加自定义模型（支持 80+ Provider）
- **手工编辑**：直接修改配置文件，保存后下次启动生效
- **自动写入**：在权限确认弹窗中选择"会话内记住"会写入 `settings.local.json`

## 相关资源

- [权限控制](permissions.md) - 详细的权限配置说明
- [主题配置](themes.md) - 主题自定义
- [CLI 命令](../reference/cli-commands.md) - 命令行参数
