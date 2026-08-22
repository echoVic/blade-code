# 🤖 Subagents 系统

Subagent 是可定制的子代理，用于执行特定类型的任务。Task 工具会根据配置选择合适的子代理执行子任务。

## 内置 Subagents

Blade 内置 4 个核心子代理：

| 名称 | 用途 | 可用工具 |
|------|------|----------|
| `general-purpose` | 通用任务代理，用于复杂问题研究和多步骤任务 | 所有工具 |
| `Explore` | 代码探索专家，快速搜索和分析代码库 | Glob, Grep, Read, WebFetch, WebSearch |
| `Plan` | 软件架构师，设计实现计划和架构方案 | 所有工具 |
| `statusline-setup` | 状态栏配置专家 | Read, Edit |

### general-purpose

通用任务代理，用于复杂问题研究、代码搜索和多步骤任务：

```
当你搜索关键字或文件时，如果不确定能否在前几次尝试中找到正确匹配，
可以使用此代理来执行搜索。
```

### Explore

代码探索专家，快速搜索和分析代码库：

```
快速查找文件模式（如 "src/components/**/*.tsx"）
搜索代码关键字（如 "API endpoints"）
回答关于代码库的问题（如 "API 端点是如何工作的？"）

支持三种详细程度：
- quick: 基础搜索
- medium: 中等探索
- very thorough: 全面分析
```

### Plan

软件架构师，设计实现计划：

```
分析需求
探索代码库理解现有模式
设计分步实现计划
识别关键文件和依赖
考虑架构权衡
```

## 自定义 Subagents

### 配置位置

```
~/.blade/agents/*.md        # 用户级（全局）
<project>/.blade/agents/*.md  # 项目级（优先级更高）
```

### 配置格式

创建 `.md` 文件，使用 YAML frontmatter 定义元数据：

```markdown
---
name: code-reviewer
description: Review code for bugs and risks. Use this when you need critical feedback.
tools:
  - Read
  - Grep
  - Glob
color: blue
---

# Code Reviewer

你是一名代码审查专家，专注于发现代码中的问题和风险。

## 审查重点

1. **代码质量** - 可读性、可维护性、命名规范
2. **潜在 Bug** - 边界条件、空值处理、类型安全
3. **安全风险** - 注入攻击、敏感信息泄露
4. **性能问题** - 算法复杂度、内存泄漏

## 输出格式

请按以下格式输出审查结果：

### 问题列表

| 严重程度 | 位置 | 问题描述 | 建议 |
|----------|------|----------|------|
| 高/中/低 | 文件:行号 | 问题描述 | 修复建议 |

### 总结

简要总结代码质量和主要改进建议。
```

### 元数据字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 唯一标识（kebab-case） |
| `description` | string | 简要用途，建议包含 "Use this when …" |
| `tools` | string[] | 允许的工具列表，留空则不限制 |
| `color` | string | UI 标记颜色（可选） |

### 单次运行定义

使用 `--agents <json>` 可以为当前进程注入一个或多个 Subagents，无需创建配置文件。它同时适用于桌面 TUI、print 和 headless，定义不会持久化：

```bash
blade --agents '{
  "code-reviewer": {
    "description": "Review code changes and run focused checks",
    "prompt": "Find correctness risks, inspect the diff, and run tests.",
    "tools": ["Read", "Grep", "Bash"],
    "disallowedTools": ["Write"],
    "model": "deepseek-v4-pro",
    "permissionMode": "dontAsk",
    "maxTurns": 8,
    "isolation": "worktree"
  }
}'
```

支持字段：

| 字段 | 必需 | 说明 |
|------|------|------|
| `description` | 是 | 提供给主代理的用途说明 |
| `prompt` | 是 | 子代理系统提示词 |
| `tools` | 否 | 工具白名单 |
| `disallowedTools` | 否 | 工具黑名单，优先于白名单 |
| `model` | 否 | 子代理使用的模型 |
| `permissionMode` | 否 | `default`、`acceptEdits`、`dontAsk`、`bypassPermissions`、`plan` 或 `ignore`；省略时继承主会话 |
| `maxTurns` | 否 | 正整数，最大 100 |
| `isolation` | 否 | `none` 或 `worktree` |

单次运行定义的优先级高于同名的内置、用户级和项目级定义。解析采用严格模式：未知字段、非法 agent 名称、空提示词和错误类型都会在 Agent runtime 初始化前终止启动。

### 可用颜色

`red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`

## 使用方式

### 在对话中使用

直接在对话中提出需求，AI 会自动选择合适的子代理：

```
请帮我审查 src/agent/Agent.ts 的代码
```

或明确指定子代理：

```
使用 code-reviewer 代理审查这段代码
```

### 通过 Task 工具

AI 会通过 Task 工具调用子代理：

```json
{
  "name": "Task",
  "arguments": {
    "subagent_type": "code-reviewer",
    "description": "审查错误处理",
    "prompt": "审查 src/agent/Agent.ts 的错误处理逻辑"
  }
}
```

### Durable resume

foreground 和 background Task 都会生成 durable agent ID。完成结果中的
`resume_from_hint` 可用于后续工作：

```json
{
  "name": "Task",
  "arguments": {
    "description": "继续错误处理审查",
    "prompt": "检查上轮发现是否已经修复，并运行相关测试。",
    "resume_from": "agent-source-id"
  }
}
```

每次恢复都会创建新的不可变 child run，不会覆盖源 sidecar。Blade 持久化
`rootAgentId`、`resumedFrom` 和 `resumeDepth`，因此 root → child → grandchild
链路可在进程重启后继续。恢复时：

- `subagent_type` 可以省略；如果提供，必须与源运行一致；
- 模型、权限、工具白名单/黑名单、系统提示、最大回合数和隔离方式使用源快照，
  不受之后配置文件变化影响；
- 只能由相同 `parent sessionId + projectPath` 的 Runtime 读取或恢复；
- source 必须已经结束，且 parent session 必须 idle、没有 durable pending input；
- worktree resume 复用原 lease，新的 child ID 不改变 worktree owner；
- `resume` 仍可作为兼容别名，新调用应使用 `resume_from`。

用户也可以通过 TUI/ACP 的 `/tasks resume <agentId> <prompt>` 或 Web subagent
卡片中的 **Resume** 操作执行同一协议。Web 刷新后会从持久化 lineage 找到最新
descendant，不会从旧 ancestor 创建 sibling。

## Agent Teams

Agent Team 是 Blade 在 Subagents 之上的团队协作层。启用后，主 Agent 可启动多个
角色化 teammate，共享带依赖关系的任务图，并通过持久化 mailbox 点对点或广播通信。
TUI、Web 与 ACP 都会投影同一个团队状态。

Agent Teams 默认关闭。在 `~/.blade/config.json` 或 Web 设置页开启：

```json
{
  "agentTeamsEnabled": true
}
```

团队配置存储位置：

```
~/.blade/teams/<team-name>/config.json
```

### TeamCreate

当用户明确需要“团队 / swarm / 多个 agents 协作”，或任务适合并行拆分时，AI 可以调用 `TeamCreate`：

```json
{
  "name": "TeamCreate",
  "arguments": {
    "team_name": "checkout-refactor",
    "description": "并行分析和实现 checkout 重构",
    "peer_messaging": true,
    "members": [
      {
        "name": "researcher",
        "subagent_type": "Explore",
        "description": "梳理 checkout 流程",
        "prompt": "查找 checkout 入口、状态流转和风险点。"
      },
      {
        "name": "planner",
        "subagent_type": "Plan",
        "description": "实现重构",
        "prompt": "根据共享任务图实现 checkout 重构。"
      }
    ],
    "tasks": [
      {
        "subject": "梳理 checkout 流程",
        "description": "定位入口、状态流转和风险点",
        "assigned_to": "researcher",
        "priority": "high"
      },
      {
        "subject": "实现 checkout 重构",
        "description": "根据调研结果完成实现和测试",
        "assigned_to": "planner",
        "depends_on": ["1"]
      }
    ]
  }
}
```

每个 member 会作为后台 agent 启动，并共享以 team name 为作用域的任务图。写能力
角色默认使用独立 worktree；只读角色继续在当前 workspace 中运行。角色定义直接复用
`.blade/agents` 和 `.claude/agents` 的 Markdown frontmatter。

### 协作工具

```json
{ "name": "TeamStatus", "arguments": { "team_name": "checkout-refactor" } }
{ "name": "TeamTaskClaim", "arguments": { "team_name": "checkout-refactor" } }
{ "name": "SendMessage", "arguments": { "team_name": "checkout-refactor", "to": "planner", "message": "接口约束已确认" } }
{ "name": "TeamInbox", "arguments": { "team_name": "checkout-refactor" } }
{ "name": "TeamDelete", "arguments": { "team_name": "checkout-refactor" } }
```

- `TeamTaskClaim` 在文件锁内原子领取依赖已完成的任务，不会被并发成员重复领取。
- `SendMessage` 支持成员名和 `*` 广播；消息会持久化，并注入目标成员的下一个安全边界。
- `TeamInbox` 读取和确认未即时投递的消息。
- teammate 不能创建嵌套 team。
- `TeamDelete` 默认取消仍在运行的成员。

### 状态与命令

Web 和 TUI 会显示成员状态、worktree 标记与任务图进度。TUI/ACP 还支持：

```bash
/team
/team status checkout-refactor
/team message checkout-refactor planner 请复核接口边界
/team inbox checkout-refactor
/team delete checkout-refactor
```

### 管理命令

```bash
/agents         # 打开代理管理器
/agents list    # 列出所有代理
/agents create  # 创建新代理（向导）
/agents help    # 显示帮助
```

## 示例配置

### 测试专家

```markdown
---
name: test-expert
description: Write and improve tests. Use this when you need to add or fix tests.
tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash
color: green
---

# Test Expert

你是一名测试专家，专注于编写高质量的测试代码。

## 职责

1. 分析现有代码，识别需要测试的场景
2. 编写单元测试、集成测试
3. 确保测试覆盖边界条件
4. 遵循项目的测试规范和框架

## 测试原则

- 每个测试只测试一个功能点
- 测试名称要清晰描述测试内容
- 使用 AAA 模式（Arrange-Act-Assert）
- 避免测试实现细节
```

### 文档专家

```markdown
---
name: doc-writer
description: Write and improve documentation. Use this when you need to document code or features.
tools:
  - Read
  - Grep
  - Glob
  - Write
color: purple
---

# Documentation Expert

你是一名技术文档专家，专注于编写清晰、准确的文档。

## 文档类型

1. **API 文档** - 函数签名、参数说明、返回值
2. **使用指南** - 快速开始、常见用法
3. **架构文档** - 系统设计、模块关系
4. **注释** - 代码内注释、JSDoc

## 写作原则

- 简洁明了，避免冗余
- 提供实际可用的示例
- 保持与代码同步更新
```

## 注意事项

1. **无状态** - 每次调用使用新的上下文
2. **权限继承** - 默认继承主会话权限模式；单次运行定义可显式覆盖，工具仍受白名单和黑名单约束
3. **重新加载** - 修改配置后需重启 Blade 或重新进入 UI

## 相关资源

- [Slash 命令](slash-commands.md) - `/agents` 命令
- [工具列表](../reference/tool-list.md) - Task 工具
- [权限控制](../configuration/permissions.md) - 权限模式
