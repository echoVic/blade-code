# Blade 配置系统

Blade 采用双配置文件系统，参考 Claude Code 的设计理念：

- **config.json** - 基础配置（API、模型、UI 等）
- **settings.json** - 行为配置（权限、Hooks、环境变量等）

> 首次运行 `blade` 时，如果未检测到 `apiKey`，会自动启动终端设置向导（`SetupWizard`）引导填写 provider、Base URL、API Key、模型，并立即保存到用户配置。

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

权限系统通过 `PermissionChecker` 类实现，支持三级权限控制：

```json
{
  "permissions": {
    "allow": [
      "Read(file_path:**/*.ts)",
      "Read(file_path:**/*.js)",
      "Grep",
      "Glob"
    ],
    "ask": [
      "Write",
      "Edit",
      "Bash(command:npm *)",
      "Bash(command:git *)"
    ],
    "deny": [
      "Read(file_path:.env)",
      "Read(file_path:**/.env*)",
      "Read(file_path:**/*.{key,secret})",
      "Bash(command:rm -rf *)",
      "Bash(command:sudo *)"
    ]
  }
}
```

**权限规则说明：**
- `allow` - 自动允许的工具调用（无需用户确认）
- `ask` - 需要用户确认的调用（默认行为）
- `deny` - 拒绝的调用（最高优先级）

**优先级：** `deny` > `allow` > `ask` > 默认(ask)

**匹配模式：**
1. **精确匹配**: `Bash(command:git status)` - 完全匹配
2. **工具名匹配**: `Read` - 匹配该工具的所有调用
3. **通配符匹配**: `Read(file_path:*.env)` - `*` 匹配任意字符（不包括 `/`）
4. **Glob 模式**: `Read(file_path:**/.env)` - `**` 匹配任意层级目录
5. **大括号扩展**: `Read(file_path:**/*.{env,key,secret})` - 匹配多个扩展名
6. **全局通配**: `*` 或 `**` - 匹配所有工具

**实现细节：**
- 工具调用签名格式: `ToolName(param1:value1, param2:value2)`
- 使用 `minimatch` 库进行 glob 模式匹配
- 支持嵌套括号和花括号的智能解析
- 参数值支持 glob 模式匹配

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

## 核心实现

### ConfigManager

配置管理器位于 [src/config/ConfigManager.ts](../src/config/ConfigManager.ts)，负责：

1. **多层级配置加载** - 按优先级加载和合并配置
2. **环境变量插值** - 支持 `$VAR` 和 `${VAR:-default}` 语法
3. **配置验证** - 验证配置格式和必需字段
4. **动态更新** - 运行时更新配置
5. **配置追踪** - 追踪配置项的来源

### PermissionChecker

权限检查器位于 [src/config/PermissionChecker.ts](../src/config/PermissionChecker.ts)，提供：

```typescript
class PermissionChecker {
  check(descriptor: ToolInvocationDescriptor): PermissionCheckResult
  isAllowed(descriptor: ToolInvocationDescriptor): boolean
  isDenied(descriptor: ToolInvocationDescriptor): boolean
  needsConfirmation(descriptor: ToolInvocationDescriptor): boolean
  updateConfig(config: Partial<PermissionConfig>): void
}
```

### ExecutionPipeline 集成

权限检查集成在 6 阶段执行管道中：

```
Discovery → Validation → Permission → Confirmation → Execution → Formatting
                            ↑            ↑
                         检查权限      需要确认时请求用户
```

详见 [执行管道文档](../../architecture/execution-pipeline.md)

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

### Q: 如何调试权限规则？
A: 查看执行日志或使用 `--debug` 模式查看权限检查详情。

## 相关文档

- [权限系统指南](./permissions-guide.md) - 详细的权限配置指南
- [执行管道架构](../../architecture/execution-pipeline.md) - 了解工具执行流程
- [用户确认流程](../../architecture/confirmation-flow.md) - 了解用户确认机制
