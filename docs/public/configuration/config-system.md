# Blade 配置系统

Blade 使用双文件配置体系：`config.json`（基础配置）和 `settings.json` / `settings.local.json`（行为配置）。加载顺序和字段均来自当前实现的 `ConfigManager` / `defaults.ts`。

## 文件位置与优先级

```
~/.blade/            # 用户级
  ├─ config.json
  └─ settings.json

<project>/.blade/    # 项目级
  ├─ config.json
  ├─ settings.json
  └─ settings.local.json   # 个人覆盖，自动加入 .gitignore
```

优先级（高 → 低）：环境变量插值 > settings.local.json > 项目 settings.json > 用户 settings.json > 项目 config.json > 用户 config.json > 默认值。

## config.json（基础配置）

**模型与连接**

```json
{
  "currentModelId": "qwen-main",
  "models": [
    {
      "id": "qwen-main",
      "name": "Qwen",
      "provider": "openai-compatible",
      "apiKey": "${QWEN_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max",
      "temperature": 0,
      "maxContextTokens": 128000,
      "topP": 0.9,
      "topK": 50
    }
  ]
}
```

**通用参数**

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `temperature` | 默认采样温度 | `0.0` |
| `maxContextTokens` | 上下文窗口（用于压缩判断） | `128000` |
| `maxOutputTokens` | 单次回复输出上限 | `32768` |
| `stream` | 是否请求流式输出 | `true` |
| `topP` / `topK` | 采样参数 | `0.9` / `50` |
| `timeout` | LLM 请求超时（ms） | `180000` |
| `theme` / `language` / `fontSize` | UI 主题/语言/字号 | `GitHub` / `zh-CN` / `14` |
| `debug` | `false` / `true` / `"agent,ui"` 形式的过滤字符串 | `false` |
| `mcpEnabled` | 是否启用 MCP | `false` |
| `mcpServers` | MCP 服务器配置字典 | `{}` |
| `enabledMcpjsonServers` / `disabledMcpjsonServers` | `.mcp.json` 的批准/拒绝记录 | `[]` |

> `fallbackModel`、`allowedTools` 等字段仅存在于运行时类型中，当前代码未消费这些字段。

## settings.json / settings.local.json（行为配置）

| 字段 | 说明 | 默认值（见 `defaults.ts`） |
| --- | --- | --- |
| `permissions` | `allow/ask/deny` 规则数组 | 预置了常见只读 Bash 命令白名单与危险命令黑名单 |
| `permissionMode` | `default` / `autoEdit` / `yolo` / `plan` | `default` |
| `hooks` | Hook 配置（启用、超时、Pre/Post 列表等） | 全部关闭 |
| `env` | 注入到会话的环境变量 | `{}` |
| `disableAllHooks` | 全局禁用 Hooks | `false` |
| `maxTurns` | 最大对话轮次（0 禁用，-1 不限，上限 100） | `-1` |

`settings.local.json` 用于个人偏好或临时授权，`ConfigManager` 会自动把它写入 `.gitignore`。

## 环境变量插值

所有字符串字段支持 `$VAR` / `${VAR}` / `${VAR:-default}` 插值，解析发生在加载阶段。例如：

```json
{
  "apiKey": "${QWEN_API_KEY}",
  "baseUrl": "${BLADE_BASE_URL:-https://apis.iflow.cn/v1}"
}
```

## 典型文件示例

**用户配置：`~/.blade/config.json`**
```json
{
  "currentModelId": "qwen",
  "models": [
    {
      "id": "qwen",
      "name": "Qwen",
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

**项目共享配置：`.blade/settings.json`**
```json
{
  "permissions": {
    "allow": [
      "Bash(git status*)",
      "Bash(ls *)",
      "Read(file_path:**/*.ts)"
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

**个人覆盖：`.blade/settings.local.json`**
```json
{
  "permissions": {
    "allow": ["Bash(npm run build*)"]
  },
  "permissionMode": "autoEdit"
}
```

## 配置入口

- **首次启动**：若未检测到模型，UI 会自动进入模型配置向导；也可在任何时候输入 `/model add` 打开向导。
- **手工编辑**：直接修改上述文件即可，保存后下次启动生效。
- **自动写入**：在权限确认弹窗中选择“会话内记住”会把抽象后的规则写入 `.blade/settings.local.json`。

## 实现要点

- 加载与合并：`src/config/ConfigManager.ts`（包含环境变量插值与 gitignore 处理）。
- 写入与同步：`configActions()` 统一入口，持久化到文件并同步 Zustand Store。
- 校验：`ConfigManager.validateConfig` 会在 Agent 创建前校验模型配置是否存在。
