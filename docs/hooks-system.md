# Blade Hooks System

Blade Hooks System 允许您在工具执行的关键时刻运行自定义命令或脚本,实现工作流自动化和验证。

## 快速开始

### 1. 启用 Hooks

在 `.blade/settings.json` 中启用 hooks:

```json
{
  "hooks": {
    "enabled": true
  }
}
```

### 2. 配置你的第一个 Hook

在 `.blade/settings.json` 中添加 hook 配置:

```json
{
  "hooks": {
    "enabled": true,
    "PostToolUse": [
      {
        "matcher": {
          "tools": "Edit",
          "paths": "**/*.ts"
        },
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write {{file_path}}",
            "statusMessage": "Formatting code..."
          }
        ]
      }
    ]
  }
}
```

这个配置会在每次编辑 TypeScript 文件后自动运行 Prettier 格式化。

## Hook 事件类型

Blade 支持 11 种 Hook 事件，与 Claude Code 完全对齐：

| 事件 | 触发时机 | 主要用途 |
|------|---------|---------|
| PreToolUse | 工具执行前 | 拦截、修改工具调用 |
| PostToolUse | 工具执行后 | 注入上下文、运行验证 |
| PostToolUseFailure | 工具执行失败后 | 错误处理、重试逻辑 |
| PermissionRequest | 权限确认前 | 自动批准/拒绝 |
| UserPromptSubmit | 用户提交消息时 | 动态上下文注入 |
| SessionStart | 会话开始时 | 环境变量注入 |
| SessionEnd | 会话结束时 | 清理、记录 |
| Stop | Agent 完成响应时 | 阻止停止、强制继续 |
| SubagentStop | 子 Agent 完成时 | 阻止停止、请求继续 |
| Notification | 通知发送时 | 过滤、转发通知 |
| Compaction | 上下文压缩时 | 阻止压缩 |

---

### PreToolUse

在工具执行**前**触发,可以:
- 阻止工具执行 (返回 `deny`)
- 修改工具输入参数 (通过 `updatedInput`)
- 请求用户确认 (返回 `ask`)

**示例: 安全检查**

```json
{
  "PreToolUse": [
    {
      "matcher": {
        "tools": "Edit|Write|Delete",
        "paths": "**/.env*|**/credentials.json"
      },
      "hooks": [
        {
          "type": "command",
          "command": ".blade/hooks/security-check.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

---

### PostToolUse

在工具执行**后**触发,可以:
- 添加额外上下文给 LLM (通过 `additionalContext`)
- 运行验证和测试
- 触发后续操作

**示例: 自动运行测试**

```json
{
  "PostToolUse": [
    {
      "matcher": {
        "tools": "Edit",
        "paths": "src/**/*.ts"
      },
      "hooks": [
        {
          "type": "command",
          "command": "npm test -- --findRelatedTests {{file_path}} --bail",
          "timeout": 60,
          "statusMessage": "Running tests..."
        }
      ]
    }
  ]
}
```

---

### PostToolUseFailure

在工具执行**失败**后触发,可以:
- 提供额外错误上下文
- 记录失败日志
- 触发告警

**Hook 输入**:
```json
{
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "error": "Command failed with exit code 1",
  "is_timeout": false,
  "is_interrupt": false
}
```

---

### PermissionRequest

在请求用户权限确认**前**触发,可以:
- 自动批准 (返回 `approve`)
- 自动拒绝 (返回 `deny`)
- 交给用户决定 (返回 `ask`)

**示例: 自动批准测试命令**

```json
{
  "PermissionRequest": [
    {
      "matcher": {
        "tools": "Bash(npm test*)"
      },
      "hooks": [
        {
          "type": "command",
          "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"permissionDecision\":\"approve\"}}'"
        }
      ]
    }
  ]
}
```

---

### UserPromptSubmit

在用户提交消息、Claude 处理**前**触发,可以:
- 修改用户输入 (通过 `updatedPrompt`)
- 注入动态上下文 (stdout 内容会添加到上下文)
- 拒绝处理某些消息

**示例: 注入 Git 状态**

```json
{
  "UserPromptSubmit": [
    {
      "matcher": {},
      "hooks": [
        {
          "type": "command",
          "command": "git status --porcelain 2>/dev/null | head -20"
        }
      ]
    }
  ]
}
```

---

### SessionStart

在会话**开始**时触发,可以:
- 注入环境变量 (通过 `BLADE_ENV_FILE` 持久化)
- 执行初始化脚本
- 记录会话信息

**Hook 输入**:
```json
{
  "hook_event_name": "SessionStart",
  "session_id": "abc123",
  "is_resume": false,
  "permission_mode": "default"
}
```

**环境变量注入**:

Hook 可以输出环境变量到 stdout，格式为 `KEY=VALUE`（每行一个）：

```bash
#!/bin/bash
echo "PROJECT_VERSION=$(cat package.json | jq -r .version)"
echo "GIT_BRANCH=$(git branch --show-current)"
```

或者使用 `BLADE_ENV_FILE` 环境变量指定的文件路径写入环境变量。

---

### SessionEnd

在会话**结束**时触发,可以:
- 清理临时文件
- 记录会话统计
- 触发后续流程

**Hook 输入**:
```json
{
  "hook_event_name": "SessionEnd",
  "reason": "user_exit",  // 或 "ctrl_c", "error"
  "session_id": "abc123"
}
```

> 注意: SessionEnd hooks 在后台执行,不会阻塞退出流程。

---

### Stop

在 Agent 完成响应、准备停止时触发,可以:
- 阻止停止,强制继续执行 (返回 `continue: false`)
- 清理临时状态
- 记录完成信息

**阻止停止示例**:

```bash
#!/bin/bash
# 检查是否有未完成的任务
if [ -f ".blade/pending-tasks" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","continue":false,"continueReason":"还有未完成的任务"}}'
  exit 0
fi
echo '{"hookSpecificOutput":{"hookEventName":"Stop","continue":true}}'
```

---

### SubagentStop

在子 Agent (Task 工具) 完成时触发,可以:
- 阻止子 Agent 停止
- 请求继续执行其他任务

**Hook 输入**:
```json
{
  "hook_event_name": "SubagentStop",
  "agent_type": "Explore",
  "task_description": "Find API endpoints",
  "success": true,
  "result_summary": "Found 15 endpoints..."
}
```

---

### Notification

在发送通知时触发,可以:
- 过滤某些通知
- 转发到其他系统
- 修改通知内容

**Hook 输入**:
```json
{
  "hook_event_name": "Notification",
  "notification_type": "info",
  "message": "Task completed successfully"
}
```

---

### Compaction

在上下文压缩时触发,可以:
- 阻止压缩 (返回 `blockCompaction: true`)
- 记录压缩事件

**Hook 输入**:
```json
{
  "hook_event_name": "Compaction",
  "trigger": "auto",
  "messages_before": 150,
  "tokens_before": 45000
}
```

## Hook 配置

### 完整配置示例

```json
{
  "hooks": {
    "enabled": true,
    "defaultTimeout": 60,
    "timeoutBehavior": "ignore",
    "failureBehavior": "ignore",
    "maxConcurrentHooks": 5,

    "PreToolUse": [...],
    "PostToolUse": [...],
    "PostToolUseFailure": [...],
    "PermissionRequest": [...],
    "UserPromptSubmit": [...],
    "SessionStart": [...],
    "SessionEnd": [...],
    "Stop": [...],
    "SubagentStop": [...],
    "Notification": [...],
    "Compaction": [...]
  }
}
```

### 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | false | 是否启用 hooks |
| `defaultTimeout` | number | 60 | 默认超时时间(秒) |
| `timeoutBehavior` | string | 'ignore' | 超时行为: ignore/deny/ask |
| `failureBehavior` | string | 'ignore' | 失败行为: ignore/deny/ask |
| `maxConcurrentHooks` | number | 5 | 最大并发 hook 数 |

## Matcher 配置

Matcher 用于匹配哪些工具调用会触发 hook:

```json
{
  "matcher": {
    "tools": "Edit|Write",        // 工具名匹配
    "paths": "src/**/*.{ts,tsx}",  // 文件路径匹配(glob)
    "commands": "npm.*"            // 命令匹配(Bash工具)
  }
}
```

### Tools 匹配模式

- **精确匹配**: `"Edit"`
- **多个工具**: `"Edit|Write|Delete"` (管道分隔)
- **正则表达式**: `".*Tool$"`
- **通配符**: `"*"` (匹配所有)
- **参数模式**: `"Bash(npm test*)"` (匹配特定命令)

#### 参数模式语法

参数模式允许匹配工具调用的特定参数，格式为 `工具名(参数模式)`：

```json
{
  "matcher": {
    "tools": "Bash(npm test*)"  // 匹配 npm test 开头的命令
  }
}
```

支持的参数模式：

| 工具 | 匹配参数 | 示例 |
|-----|---------|------|
| Bash | command | `Bash(npm*)`, `Bash(git commit*)` |
| Read | file_path | `Read(src/**/*.ts)` |
| Write | file_path | `Write(**/test/*.ts)` |
| Edit | file_path | `Edit(package.json)` |
| Glob | pattern | `Glob(**/*.md)` |
| Grep | pattern | `Grep(TODO\|FIXME)` |

参数模式使用 [picomatch](https://github.com/micromatch/picomatch) 进行匹配，支持：
- `*` - 匹配任意字符（不含路径分隔符）
- `**` - 匹配任意字符（含路径分隔符）
- `{a,b}` - 匹配 a 或 b
- `[abc]` - 匹配字符集

### Paths 匹配模式

使用 glob 模式:
- `"**/*.ts"` - 所有 TypeScript 文件
- `"src/**/*.{ts,tsx}"` - src 目录下的 TS/TSX 文件
- `"test/**"` - test 目录下的所有文件

## Hook 输入输出

### Hook 输入 (通过 stdin)

每个 hook 命令会通过 stdin 接收一个 JSON 对象:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_use_id": "tool_abc123",
  "tool_input": {
    "file_path": "src/app.ts",
    "content": "..."
  },
  "project_dir": "/path/to/project",
  "session_id": "session_xyz",
  "permission_mode": "default"
}
```

### Hook 输出 (通过 stdout)

#### 简单模式 - 使用退出码

```bash
#!/bin/bash
# 退出码 0: 成功,继续执行
# 退出码 2: 阻塞,停止执行
# 其他: 非阻塞错误,记录但继续

exit 0
```

#### 高级模式 - 输出 JSON

```json
{
  "decision": {
    "behavior": "approve"  // 或 "block"
  },
  "systemMessage": "操作被允许",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "代码符合规范"
  }
}
```

## 示例 Hooks

### 1. 代码格式化

```json
{
  "PostToolUse": [
    {
      "matcher": {
        "tools": "Edit|Write",
        "paths": "**/*.{ts,tsx,js,jsx,json}"
      },
      "hooks": [
        {
          "type": "command",
          "command": "prettier --write {{file_path}}",
          "timeout": 10
        }
      ]
    }
  ]
}
```

### 2. 安全检查脚本

创建 `.blade/hooks/security-check.sh`:

```bash
#!/bin/bash

# 读取 hook 输入
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path')

# 检查敏感文件
if [[ "$FILE_PATH" =~ \.env|credentials|secrets ]]; then
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "禁止修改敏感文件"
    }
  }'
  exit 2
fi

# 允许操作
echo '{"decision": {"behavior": "approve"}}'
exit 0
```

不要忘记添加执行权限:
```bash
chmod +x .blade/hooks/security-check.sh
```

### 3. Lint 检查

```json
{
  "PreToolUse": [
    {
      "matcher": {
        "tools": "Edit|Write",
        "paths": "src/**/*.ts"
      },
      "hooks": [
        {
          "type": "command",
          "command": "npm run lint-staged",
          "timeout": 30,
          "statusMessage": "Linting changes..."
        }
      ]
    }
  ]
}
```

### 4. 自动测试

```json
{
  "PostToolUse": [
    {
      "matcher": {
        "tools": "Edit",
        "paths": "src/**/*.ts"
      },
      "hooks": [
        {
          "type": "command",
          "command": "npm test -- --findRelatedTests {{file_path}} --passWithNoTests",
          "timeout": 60
        }
      ]
    }
  ]
}
```

## 环境变量

Hook 命令可以访问以下环境变量:

- `BLADE_PROJECT_DIR` - 项目目录
- `BLADE_SESSION_ID` - 会话 ID
- `BLADE_HOOK_EVENT` - Hook 事件名称
- `BLADE_TOOL_NAME` - 工具名称
- `BLADE_TOOL_USE_ID` - 工具使用 ID

## 最佳实践

### 1. 使用专用的 hooks 目录

```
.blade/
├── settings.json
└── hooks/
    ├── security-check.sh
    ├── run-tests.sh
    └── format-code.sh
```

### 2. 设置合理的超时

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "npm test",
      "timeout": 60  // 根据实际情况设置
    }
  ]
}
```

### 3. 使用 failureBehavior 控制错误处理

```json
{
  "hooks": {
    "failureBehavior": "ignore",  // 或 "deny", "ask"
  }
}
```

### 4. 限制并发数

```json
{
  "hooks": {
    "maxConcurrentHooks": 3  // 避免系统负载过高
  }
}
```

## 调试 Hooks

### 启用详细日志

```bash
blade --debug
```

### 查看 Hook 执行状态

Hook 执行信息会显示在 UI 中,包括:
- Hook 名称
- 执行时长
- 成功/失败状态
- 决策结果 (allow/deny/ask)

## 安全注意事项

1. **限制输入大小**: Hook 输入限制为 100KB
2. **限制输出大小**: stdout/stderr 各限制为 1MB
3. **超时保护**: 默认 60 秒超时
4. **隔离环境**: Hook 运行在受限的环境变量中
5. **权限检查**: 建议在 hook 中验证文件路径

## 故障排除

### Hook 没有执行?

1. 检查 `hooks.enabled` 是否为 `true`
2. 检查 matcher 配置是否正确
3. 使用 `--debug` 查看详细日志

### Hook 超时?

1. 增加 `timeout` 值
2. 优化 hook 脚本性能
3. 考虑使用异步模式

### Hook 失败导致工具无法执行?

1. 修改 `failureBehavior` 为 `ignore`
2. 检查 hook 脚本的退出码
3. 确保 hook 脚本有执行权限

## 更多信息

- 查看完整实施计划: [hooks-implementation-plan.md](../hooks-implementation-plan.md)
- Claude Code Hooks 分析: [claude-code-hooks-analysis.md](../claude-code-hooks-analysis.md)
