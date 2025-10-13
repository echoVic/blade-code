# Blade 配置系统

Blade 采用双配置文件系统，参考 Claude Code 的设计理念：

- **config.json** - 基础配置（API、模型、UI 等）
- **settings.json** - 行为配置（权限、Hooks、环境变量等）

## 配置文件位置

### 用户级配置
```
~/.blade/
├── config.json       # 用户基础配置
└── settings.json     # 用户行为配置
```

### 项目级配置
```
<project>/.blade/
├── config.json              # 项目基础配置
├── settings.json            # 项目行为配置（提交到 git）
└── settings.local.json      # 本地配置（不提交,自动忽略）
```

## 配置优先级

### config.json (2层)
```
环境变量 > 项目配置 > 用户配置 > 默认配置
```

### settings.json (3层)
```
本地配置 > 项目配置 > 用户配置 > 默认配置
```

## config.json 配置项

### 认证
```json
{
  "apiKey": "$BLADE_API_KEY",
  "apiSecret": "optional-secret",
  "baseURL": "https://apis.iflow.cn/v1"
}
```

### 模型
```json
{
  "model": "qwen3-coder-plus",
  "temperature": 0.0,
  "maxTokens": 32000,
  "stream": true,
  "topP": 0.9,
  "topK": 50
}
```

### UI
```json
{
  "theme": "GitHub",
  "language": "zh-CN",
  "fontSize": 14,
  "showStatusBar": true
}
```

### 核心
```json
{
  "debug": false,
  "telemetry": true,
  "autoUpdate": true,
  "workingDirectory": "."
}
```

### 日志
```json
{
  "logLevel": "info",
  "logFormat": "text"
}
```

## settings.json 配置项

### 权限控制

```json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(npm run lint)",
      "Read(~/.zshrc)"
    ],
    "ask": [
      "Bash(git push:*)",
      "WebFetch(*)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./secrets/**)",
      "Bash(rm -rf:*)"
    ]
  }
}
```

**权限规则说明：**
- `allow` - 自动允许的工具调用
- `ask` - 需要用户确认的调用
- `deny` - 拒绝的调用

**匹配模式：**
- 精确匹配: `Bash(git status)`
- 前缀匹配: `Bash(git push:*)` 匹配所有 git push 命令
- 通配符: `WebFetch(*)` 匹配所有 WebFetch 调用
- Glob: `Read(./secrets/**)` 匹配 secrets 目录下所有文件

### Hooks

在工具执行前后自动运行命令：

```json
{
  "hooks": {
    "PreToolUse": {
      "Bash": "echo '[Blade] Executing: {command}' >> .blade/command.log"
    },
    "PostToolUse": {
      "Write": "npx prettier --write {file_path}",
      "Edit": "npx prettier --write {file_path}"
    }
  }
}
```

**变量替换：**
- `{file_path}` - 文件路径
- `{command}` - 命令内容
- `{pattern}` - 匹配模式

### 环境变量

为每个会话注入环境变量：

```json
{
  "env": {
    "NODE_ENV": "development",
    "NPM_CONFIG_LOGLEVEL": "warn",
    "BLADE_DEBUG": "1"
  }
}
```

### 其他配置

```json
{
  "disableAllHooks": false,
  "cleanupPeriodDays": 30,
  "includeCoAuthoredBy": true,
  "apiKeyHelper": "~/.blade/scripts/get-token.sh"
}
```

## 环境变量

### 支持的环境变量

| 环境变量 | 配置字段 | 说明 |
|---------|---------|------|
| `BLADE_API_KEY` | `apiKey` | API 密钥 |
| `BLADE_BASE_URL` | `baseURL` | API 基础 URL |
| `BLADE_MODEL` | `model` | 模型名称 |
| `BLADE_TEMPERATURE` | `temperature` | 温度参数 |
| `BLADE_THEME` | `theme` | UI 主题 |
| `BLADE_LANGUAGE` | `language` | 界面语言 |
| `BLADE_DEBUG` | `debug` | 调试模式 |

### 环境变量插值

在配置文件中引用环境变量：

```json
{
  "apiKey": "$BLADE_API_KEY",
  "baseURL": "${BLADE_BASE_URL}",
  "model": "${BLADE_MODEL:-qwen3-coder-plus}"
}
```

**语法：**
- `$VAR` - 引用环境变量
- `${VAR}` - 引用环境变量
- `${VAR:-default}` - 带默认值的引用

## 使用示例

### 1. 用户配置 (~/.blade/config.json)

```json
{
  "apiKey": "$BLADE_API_KEY",
  "baseURL": "https://apis.iflow.cn/v1",
  "model": "qwen3-coder-plus",
  "theme": "GitHub",
  "language": "zh-CN",
  "debug": false
}
```

### 2. 项目配置 (.blade/settings.json)

团队共享的配置，提交到 git：

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run:*)",
      "Bash(npx:*)"
    ],
    "deny": [
      "Read(./.env.production)",
      "Write(./dist/**)"
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

### 3. 本地配置 (.blade/settings.local.json)

个人实验配置，不提交：

```json
{
  "permissions": {
    "allow": [
      "Bash(rm:*)"
    ]
  },
  "env": {
    "BLADE_DEBUG": "1"
  }
}
```

## 配置方式

### 1. 手动编辑文件（主要方式）

```bash
# 编辑用户配置
vim ~/.blade/config.json
vim ~/.blade/settings.json

# 编辑项目配置
vim .blade/config.json
vim .blade/settings.json

# 编辑本地配置
vim .blade/settings.local.json
```

### 2. REPL 交互式界面

```bash
blade

> /config              # 打开配置界面
> /config show         # 显示当前配置
> /config trace apiKey # 显示配置来源
```

## 配置职责划分

| 配置类型 | config.json | settings.json |
|---------|------------|--------------|
| API 密钥 | ✅ | ❌ |
| 模型选择 | ✅ | ❌ |
| UI 主题 | ✅ | ❌ |
| 权限控制 | ❌ | ✅ |
| Hooks | ❌ | ✅ |
| 环境变量 | ❌ | ✅ |
| 层级数量 | 2层 | 3层 |

## 最佳实践

### 1. 安全性
- 不要在配置文件中硬编码 API Key，使用环境变量
- 敏感配置使用 `.local.json` 避免提交到 git
- 使用权限系统限制敏感文件访问

### 2. 团队协作
- `.blade/settings.json` 提交到 git 共享团队配置
- `.blade/settings.local.json` 用于个人覆盖
- 使用 `env` 统一团队环境变量

### 3. 配置组织
- config.json 保持简洁，只配置必要项
- settings.json 按功能分组（permissions / hooks / env）
- 使用注释（JSON5）说明复杂配置

### 4. 权限配置
- deny 规则优先级最高
- 从严格到宽松逐步放开权限
- 生产环境使用更严格的权限

## FAQ

### Q: 配置文件不存在怎么办？
A: 系统会使用默认配置，不影响运行。

### Q: 如何知道配置加载顺序？
A: 使用 `/config trace <key>` 查看配置来源链。

### Q: settings.local.json 会被 git 追踪吗？
A: 不会，系统会自动添加到 `.gitignore`。

### Q: 如何重置配置？
A: 删除对应的配置文件，系统会使用默认配置。

### Q: 支持 JSON5 或 YAML 吗？
A: 目前只支持标准 JSON 格式。
