# ⚡ Slash 命令

Slash 命令是 Blade 的快捷操作入口，输入 `/` 触发建议，`Tab` 补全，`Enter` 执行。

## 内置命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help` | `/h` | 显示所有可用命令 |
| `/clear` | `/cls` | 清空消息区（同 `Ctrl+L`） |
| `/exit` | `/quit`, `/q` | 退出程序 |
| `/version` | `/v` | 显示版本信息 |
| `/status` | - | 显示当前项目/配置状态 |
| `/context` | - | 显示上下文使用情况 |
| `/init` | - | 分析项目生成 BLADE.md |
| `/model` | - | 模型管理 |
| `/effort [level]` | - | 查看或切换当前 Session 的推理强度 |
| `/speed [tier]` | `/fast [on\|off]` | 查看或切换当前 Session 的 Provider 服务等级 |
| `/verbosity [level]` | `/detail [level]` | 查看或切换当前 Session 的响应详略 |
| `/style [name]` | `/personality [name]` | 查看或切换当前 Session 的沟通风格 |
| `/theme` | - | 切换主题 |
| `/permissions` | - | 管理权限规则 |
| `/mcp` | - | 显示 MCP 状态 |
| `/agents` | - | 管理子代理 |
| `/tasks` | - | 查看后台任务并恢复已结束的子代理 |
| `/team [action]` | - | 查看团队状态、发送消息或删除团队 |
| `/skills` | - | 管理 Skills |
| `/plugins` | - | 管理插件 |
| `/hooks` | - | 管理 Hooks |
| `/resume` | - | 恢复历史会话 |
| `/archive [sessionId]` | - | 归档当前或指定的 inactive 会话树 |
| `/unarchive <sessionId>` | - | 恢复归档根会话 |
| `/export [path] [--reasoning]` | - | 导出当前 durable 会话为安全 Markdown |
| `/btw <question>` | - | 在独立旁路中询问单轮问题 |
| `/compact` | - | 手动压缩上下文 |
| `/memory` | - | 管理项目记忆 |
| `/git` | `/g` | Git 操作 |
| `/login` | - | 登录 OAuth 服务 |
| `/logout` | - | 登出 OAuth 服务 |

## 命令详解

### /init

分析当前项目并生成或改进 `BLADE.md` 配置文件：

```bash
/init
```

- 如果 `BLADE.md` 不存在，会自动分析项目结构并生成
- 如果已存在，会分析现有内容并提供改进建议

### /model

模型管理命令：

```bash
/model              # 打开模型选择器（交互式切换）
/model add          # 添加新模型配置（交互式向导）
/model remove <名称> # 删除指定模型（按名称模糊匹配）
```

示例：
```bash
/model remove 千问   # 删除名称包含"千问"的模型
```

### /effort

```bash
/effort
/effort auto
/effort off
/effort minimal
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

无参数时显示当前 selected/effective level 和模型支持的级别。显式选择不受支持时
fail closed；`auto` 会根据模型能力解析，但仍作为 Session 策略持久化。活动回合期间
不能切换。完整契约见
[Session Reasoning Effort](../reference/session-reasoning-effort.md)。

### /speed 与 /fast

```bash
/speed
/speed auto
/speed standard
/speed fast
/speed flex
/fast
/fast on
/fast off
```

`auto` 保留 Provider 默认策略，`standard` 显式回到基线，`fast` 请求优先/低延迟
通道，`flex` 请求低成本可延迟通道。`/fast on` 等价于 `/speed fast`，
`/fast off` 等价于 `/speed standard`。模型不支持显式等级时 fail closed，活动
回合期间不能切换。完整契约见
[Session Service Tier](../reference/session-service-tier.md)。

### /verbosity 与 /detail

```bash
/verbosity
/verbosity auto
/verbosity low
/verbosity medium
/verbosity high
/detail high
```

`auto` 保留 Provider 默认策略，显式 `low/medium/high` 使用模型的原生响应详略能力。
`/detail` 是完整别名。模型不支持显式值时 fail closed，活动回合期间不能切换。
完整契约见
[Session Response Verbosity](../reference/session-response-verbosity.md)。

### /style 与 /personality

```bash
/style
/style auto
/style pragmatic
/style friendly
/style explanatory
/style project:review:strict
/personality friendly
```

`auto` 保留 Blade 默认沟通规则；其他值只改变语气和解释框架，不改变权限、工具行为、
任务范围或 Provider 原生响应详略。`/personality` 是完整别名。活动回合期间不能切换。
完整契约见
[Session Communication Style](../reference/session-communication-style.md) 和
[Trusted Custom Output Styles](../reference/trusted-output-styles.md)。

### /git

Git 仓库查询和 AI 辅助：

```bash
/git            # 显示 Git 状态（默认）
/git status     # 显示 Git 状态
/git log [n]    # 显示最近 n 条提交（默认 5）
/git diff       # 显示暂存区 diff
/git review     # 原生只读审查（等同 /review uncommitted）
/git commit     # AI 生成 commit message 并提交
/git pre-commit # AI 生成 commit message（不提交）
```

### /review

在独立只读 reviewer 中审查当前改动、base branch 或单个 commit：

```bash
/review
/review uncommitted
/review base main
/review commit <sha>
```

reviewer 不能写文件、修改 Git 或访问网络；结果以 P0-P3 finding、relative path、
line range 和 confidence 结构化持久化。详见
[Native Read-Only Code Review](../reference/native-code-review.md)。

### /agents

子代理管理：

```bash
/agents         # 打开代理管理器
/agents list    # 列出所有代理
/agents create  # 创建新代理
/agents help    # 显示帮助
```

### /resume

会话恢复：

```bash
/resume         # 打开会话选择器
```

### /archive 与 /unarchive

```bash
/archive                    # 释放当前 idle Runtime，归档当前会话并退出
/archive <sessionId>        # 归档另一个未被 owner 占用的会话树
/unarchive <sessionId>      # 恢复直接归档根
```

归档保留 transcript、任务证据、Goal、Snapshot、worktree 元数据及 fork/subagent
lineage。父会话归档后，后代通过 lineage 原子继承归档状态；默认 catalog 和
`/resume` 不再显示它们。任一后代仍在 queued/running 或持有 Session lease 时，整次
归档零写入失败。完整契约见 [Durable Session Archive](../reference/session-archive.md)。

### /export

```bash
/export
/export reports/conversation.md
/export --reasoning
```

导出 materialized durable history，包括 user/assistant 文本、图片标签、compaction
summary 和经过清理的 tool/subagent/file activity。reasoning 默认省略；`--reasoning`
是显式可见性开关。TUI 使用 `0600` exclusive create，已有文件不会被覆盖；ACP
不写宿主文件，而是返回不超过 1 MiB 的 inline Markdown。Web 可从 active Session 行
或 Archive Popover 下载。完整契约见
[Portable Session Markdown Export](../reference/session-markdown-export.md)。

### /tasks

查看当前 parent session 与 workspace 拥有的后台 Shell 和 Subagents：

```bash
/tasks
/tasks resume <agentId> <follow-up prompt>
/tasks clean
```

`resume` 只接受已结束的 agent。Blade 会保留源运行并创建新的 child ID，继承源
transcript、模型、权限、工具与隔离配置；列表中的 `Lineage` 列显示来源和恢复深度。
parent session 正在执行回合或存在 durable pending input 时，直接恢复会被拒绝。

### /btw

复用当前 Session 的持久化上下文回答一个旁路问题：

```bash
/btw 上一次测试失败的原因是什么？
```

旁路请求只执行一轮且不会调用工具。它可以与主 Agent 回合并行运行，结果显示在
TUI 或 Web 的独立临时面板中；问题和回答都不会写入主会话 JSONL，也不会成为后续
模型上下文。ACP 同样通过 `/btw` 返回临时回答。Headless 模式没有交互式 Session
runtime，因此会明确拒绝该命令。

### /compact

手动压缩上下文，生成总结并节省 token：

```bash
/compact
```

### /memory

管理项目的自动记忆系统。Agent 在工作中自动记录的项目知识（构建命令、代码模式、调试洞察等）会跨会话持久化。

```bash
/memory              # 等同于 /memory list
/memory list         # 列出所有记忆文件
/memory show         # 显示 MEMORY.md 索引内容
/memory show <topic> # 显示指定主题文件内容
/memory edit         # 用 $EDITOR 编辑 MEMORY.md
/memory edit <topic> # 用 $EDITOR 编辑指定主题文件
/memory clear        # 清空所有记忆文件
```

记忆文件存储在 `~/.blade/projects/{project}/memory/` 目录下。

可通过环境变量 `BLADE_AUTO_MEMORY=0` 禁用自动记忆功能。

### /permissions

打开权限管理器，编辑 `.blade/settings.local.json`：

```bash
/permissions
```

### /mcp

显示 MCP 服务器状态和可用工具：

```bash
/mcp
/mcp logs [server] [limit]
/mcp log-level <server> <debug|info|notice|warning|error|critical|alert|emergency>
/mcp instructions [server]
/mcp complete <server> <prompt|resource> <reference> <argument> [value] [key=value...]
/mcp tasks [server]
/mcp task <mcp_task_*>
/mcp task-cancel <mcp_task_*>
```

日志查询和级别调整只作用于当前 Session；日志不会进入模型上下文。
instructions 显示当前连接经过安全预算处理的 server 工具文档与 SHA-256。
complete 只查询当前 Session catalog 中声明的 prompt 参数或 resource template 变量。
tasks 命令只读取或取消当前 Session 创建的 opaque MCP task；server 原始 task ID
不会暴露。

### /skills

管理 Skills 系统：

```bash
/skills         # 列出所有可用 Skills
/skills list    # 列出所有 Skills
/skills info <name>  # 查看 Skill 详情
```

### /plugins

管理插件系统：

```bash
/plugins        # 列出已安装插件
/plugins list   # 列出所有插件
/plugins install <source|name@marketplace> --trust [--ref <ref>]
/plugins update <name> --trust
/plugins uninstall <name> --confirm
/plugins enable <name> [--scope local|project|global]
/plugins disable <name> [--scope local|project|global]
/plugins marketplace add <source> [--ref <ref>]
/plugins marketplace list
/plugins marketplace update [name]
/plugins marketplace remove <name> --confirm
/plugins policy show
/plugins policy set --restrict true --require-sha true \
  --hosts github.com,git.corp.example \
  --marketplaces team-market \
  --local-roots /opt/approved/plugins \
  --scope global
/plugins refresh
```

安装和更新需要显式 `--trust`，因为插件可以提供 Hooks、MCP、Skills、Agents
和 Commands。本地来源还要求当前 Workspace 已受信任。Marketplace 删除会在仍有
受管插件依赖时拒绝执行。项目层来源策略只能收紧 global 策略；开启
`--require-sha` 后远程 Git 来源必须固定到完整 40 字符 commit SHA。

### /hooks

管理 Hooks 系统：

```bash
/hooks          # 显示当前 Hooks 配置
/hooks list     # 列出所有 Hooks
```

### /theme

打开主题选择器：

```bash
/theme
```

### /context

显示当前上下文使用情况：

```bash
/context
```

输出示例：

```
📊 上下文使用情况

当前会话:
- 消息数量: 15
- Token 使用: 12,345 / 128,000
- 使用率: 9.6%
- 剩余容量: 90.4%

模型信息:
- 模型: qwen-max
- 上下文窗口: 128,000 tokens

状态: 🟢 正常
```

### /status

显示当前项目和配置状态：

```bash
/status
```

输出示例：

```
📊 当前状态

项目信息:
- 名称: blade-code
- 类型: Node.js 项目
- 路径: /path/to/project

配置状态:
- BLADE.md: ✅ 已配置

环境信息:
- 工作目录: /path/to/project
- Node.js: v22.19.0 或更高
```

### /version

显示版本信息：

```bash
/version
```

输出示例：

```
🗡️ Blade Code vX.Y.Z

构建信息:
- Node.js: v22.19.0 或更高
- 平台: darwin
- 架构: arm64

功能特性:
- 🤖 智能 AI 对话
- 🔧 项目自动分析
- 📝 自定义系统提示
- 🎯 多工具集成支持
```

## 自定义命令

Blade 支持自定义 Slash 命令，通过 Markdown 文件定义：

### 命令位置

```
~/.blade/commands/          # 用户级命令
<project>/.blade/commands/  # 项目级命令
```

### 命令格式

创建 `.md` 文件，使用 YAML frontmatter 定义元数据：

```markdown
---
name: review
description: 代码审查命令
argumentHint: <file_path>
---

请对以下文件进行代码审查：

{{args}}

重点关注：
1. 代码质量
2. 潜在 bug
3. 性能问题
```

### 元数据字段

| 字段 | 说明 |
|------|------|
| `name` | 命令名称（必填） |
| `description` | 命令描述 |
| `argumentHint` | 参数提示 |

### 使用自定义命令

```bash
/review src/agent/Agent.ts
```

## 补全与导航

- 输入 `/` 自动展示建议
- 继续输入可模糊匹配
- `Tab` 选中当前高亮项
- `↑/↓` 在建议列表中移动
- 输入包含空格后不再展示命令建议

## 典型用法

```bash
# 项目初始化
/init

# Git 工作流
/git status
/git review
/git commit

# 模型切换
/model

# 会话管理
/resume
/compact

# 配置管理
/permissions
/theme

# 扩展管理
/skills
/plugins
/hooks
/agents

# 状态查看
/status
/context
/mcp
```

## 相关资源

- [快速开始](../getting-started/quick-start.md) - 基础使用
- [Subagents](subagents.md) - 子代理系统
- [CLI 命令](../reference/cli-commands.md) - 命令行参数
