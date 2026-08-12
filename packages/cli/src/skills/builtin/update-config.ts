/**
 * 内置 update-config Skill
 *
 * 帮助 AI 配置 Blade 运行环境：settings、hooks、permissions 等。
 * 当用户请求自动化行为时自动激活。
 */

import type { SkillContent, SkillMetadata } from '../types.js';

/**
 * update-config 的元数据
 */
export const updateConfigMetadata: SkillMetadata = {
  name: 'update-config',
  description:
    '配置 Blade harness（settings/hooks/permissions）。' +
    '用户请求自动化行为时使用此 Skill。',
  allowedTools: ['ConfigTool', 'Read', 'Bash', 'AskUserQuestion'],
  version: '1.0.0',
  userInvocable: true,
  disableModelInvocation: false,
  whenToUse:
    '用户说"从现在起..."、"每次..."、"当...时..."、' +
    '需要改配置、安装 hooks、修改权限',
  path: 'builtin://update-config',
  basePath: '',
  source: 'builtin',
};

/**
 * update-config 的完整指令内容
 */
const updateConfigInstructions = `# Update Config Skill

配置 Blade 运行环境。管理 settings、hooks、permissions、环境变量等。

## 三层配置体系

Blade 采用三层配置，优先级从低到高：

| 层级 | 路径 | 用途 | scope 值 |
|------|------|------|----------|
| Global | \`~/.blade/config.json\` + \`~/.blade/settings.json\` | 用户全局默认 | \`global\` |
| Project | \`.blade/settings.json\` | 项目级设置，提交到 git | \`project\` |
| Local | \`.blade/settings.local.json\` | 本地覆盖，.gitignore | \`local\` |

**选择原则：**
- 个人偏好（codeTheme, language, fontSize）→ \`global\`
- 团队共享（hooks, permissions, env）→ \`project\`
- 临时调试（debug, maxTurns）→ \`local\`

## ConfigTool 使用

### GET - 读取配置

\`\`\`
# 获取全部配置
ConfigTool({ operation: "get", key: "*" })

# 获取特定配置
ConfigTool({ operation: "get", key: "hooks" })

# 获取嵌套值
ConfigTool({ operation: "get", key: "hooks.PreToolUse" })

# 获取权限设置
ConfigTool({ operation: "get", key: "permissions" })
\`\`\`

### SET - 设置配置

\`\`\`
# 设置温度
ConfigTool({ operation: "set", key: "temperature", value: 0.7, scope: "global" })

# 设置语言
ConfigTool({ operation: "set", key: "language", value: "zh-CN", scope: "global" })

# 设置最大轮次
ConfigTool({ operation: "set", key: "maxTurns", value: 50, scope: "local" })

# 启用调试
ConfigTool({ operation: "set", key: "debug", value: true, scope: "local" })

# 设置环境变量
ConfigTool({ operation: "set", key: "env", value: { "NODE_ENV": "development" }, scope: "project" })
\`\`\`

### LIST - 列举可配置项

\`\`\`
ConfigTool({ operation: "list" })
\`\`\`

返回所有白名单配置项及其当前值。

## 白名单字段

以下字段可通过 ConfigTool SET 修改：

| 字段 | 类型 | 说明 |
|------|------|------|
| temperature | number | 模型温度 |
| maxContextTokens | number | 上下文窗口大小 |
| maxOutputTokens | number | 输出 token 限制 |
| timeout | number | HTTP 请求超时（毫秒）|
| codeTheme | string | 代码与终端主题 |
| uiTheme | string | Web UI 主题 |
| language | string | 界面语言 |
| fontSize | number | 字体大小 |
| debug | boolean/string | 调试模式 |
| autoSaveSessions | boolean | 自动保存会话 |
| maxTurns | number | Agent 最大轮次 |
| disableAllHooks | boolean | 禁用所有 hooks |
| permissions | object | 权限规则 |
| hooks | object | Hooks 配置 |
| env | object | 环境变量 |
| mcpServers | object | MCP 服务器配置 |

**禁止修改的字段：** models、currentModelId（保护 API Key 安全）

## Hooks 安装指南

Hooks 是 Blade 的自动化机制，在特定事件发生时执行 shell 命令。

### HookEvent 类型

| 事件 | 触发时机 | 典型用途 |
|------|----------|----------|
| PreToolUse | 工具执行前 | 代码检查、格式化验证 |
| PostToolUse | 工具执行后 | 自动运行 lint/test |
| PostToolUseFailure | 工具执行失败后 | 错误日志 |
| PermissionRequest | 权限请求时 | 自动批准/拒绝 |
| UserPromptSubmit | 用户提交提示时 | 注入上下文 |
| SessionStart | 会话启动时 | 环境初始化 |
| SessionEnd | 会话结束时 | 清理操作 |
| Stop | Agent 停止时 | 阻止过早停止 |
| SubagentStop | 子 Agent 停止时 | 同上 |
| Notification | 通知事件时 | 自定义通知 |
| Compaction | 上下文压缩时 | 阻止压缩 |

### HookMatcher 结构

每个 HookMatcher 包含：
- \`name\`（可选）: 名称，用于日志
- \`matcher\`（可选）: 匹配器，不指定则匹配所有
  - \`tools\`: 工具名匹配（支持字符串或数组，如 \`"Edit"\` 或 \`["Edit", "Write"]\`）
  - \`paths\`: 文件路径匹配（glob 模式，如 \`"**/*.ts"\`）
  - \`commands\`: 命令匹配（正则，如 \`"^git"\`）
- \`hooks\`: Hook 列表

### CommandHook 结构

\`\`\`json
{
  "type": "command",
  "command": "shell command to execute",
  "timeout": 30,
  "statusMessage": "Running check..."
}
\`\`\`

Hook 接收 JSON 格式的输入通过 stdin，输出 JSON 到 stdout。

### 完整安装示例

**示例 1：安装 biome check 作为 PostToolUse hook**

当 Edit 或 Write 工具修改 .ts/.tsx 文件后，自动运行 biome check：

\`\`\`
ConfigTool({
  operation: "set",
  key: "hooks",
  value: {
    "PostToolUse": [
      {
        "name": "biome-check",
        "matcher": {
          "tools": ["Edit", "Write"],
          "paths": ["**/*.ts", "**/*.tsx"]
        },
        "hooks": [
          {
            "type": "command",
            "command": "biome check --write $(echo $TOOL_INPUT | jq -r '.file_path // empty')",
            "timeout": 30,
            "statusMessage": "Running biome check..."
          }
        ]
      }
    ]
  },
  scope: "project"
})
\`\`\`

**示例 2：安装 eslint 作为 PostToolUse hook**

\`\`\`
ConfigTool({
  operation: "set",
  key: "hooks",
  value: {
    "PostToolUse": [
      {
        "name": "eslint-fix",
        "matcher": {
          "tools": ["Edit", "Write"],
          "paths": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
        },
        "hooks": [
          {
            "type": "command",
            "command": "eslint --fix $(echo $TOOL_INPUT | jq -r '.file_path // empty')",
            "timeout": 30,
            "statusMessage": "Running ESLint..."
          }
        ]
      }
    ]
  },
  scope: "project"
})
\`\`\`

**示例 3：安装 SessionStart hook 打印环境信息**

\`\`\`
ConfigTool({
  operation: "set",
  key: "hooks",
  value: {
    "SessionStart": [
      {
        "name": "env-info",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Node:' $(node -v) '| Git branch:' $(git branch --show-current)",
            "timeout": 10,
            "statusMessage": "Gathering environment info..."
          }
        ]
      }
    ]
  },
  scope: "project"
})
\`\`\`

**示例 4：设置权限白名单**

\`\`\`
ConfigTool({
  operation: "set",
  key: "permissions",
  value: {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(bun:*)",
      "Read(**/*.ts)"
    ],
    "ask": [],
    "deny": [
      "Bash(rm -rf:*)"
    ]
  },
  scope: "project"
})
\`\`\`

## 自动行为关键词映射

当用户使用以下关键词时，映射到对应的配置操作：

| 用户说的 | 映射到 |
|----------|--------|
| "从现在起 lint 每个文件" | PostToolUse hook（Edit/Write 后运行 lint）|
| "每次提交前运行测试" | PreToolUse hook（Bash git commit 前运行 test）|
| "当编辑 TS 文件时检查类型" | PostToolUse hook（Edit 后运行 tsc）|
| "允许所有 git 命令" | permissions.allow 添加 \`Bash(git:*)\` |
| "设置调试模式" | debug = true |
| "改成中文" | language = "zh-CN" |
| "提高温度" | temperature 调整 |
| "限制 50 轮" | maxTurns = 50 |
| "禁用 hooks" | disableAllHooks = true |
| "添加环境变量" | env 对象更新 |

## 验证流程

每次安装 hook 或修改配置后，**必须**验证：

1. 用 \`ConfigTool({ operation: "get", key: "<modified-key>" })\` 确认值已生效
2. 如果是 hooks，检查结构是否正确（包含 matcher 和 hooks 数组）
3. 如果是 permissions，确认 allow/ask/deny 数组格式正确
4. 告知用户配置已保存到哪个文件（根据 scope 判断）

## 注意事项

1. **hooks 字段使用 deep-merge 策略**：设置新的 hook 不会覆盖已有的 hook。但如果同一事件下设置新的 matcher 数组，会替换该事件的整个 matcher 列表
2. **permissions 字段使用 replace 策略**：设置 permissions 会完全替换现有值。如果只想添加规则，先 GET 当前值，合并后再 SET
3. **env 字段使用 deep-merge 策略**：可以逐个添加环境变量
4. **scope 默认值**：不指定 scope 时，根据字段路由表决定（hooks/permissions/env 默认 local，temperature/codeTheme 等默认 global）
`;

/**
 * 获取 update-config 的完整内容
 */
export function getUpdateConfigContent(): SkillContent {
  return {
    metadata: updateConfigMetadata,
    instructions: updateConfigInstructions,
  };
}
