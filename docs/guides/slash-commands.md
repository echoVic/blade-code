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
| `/theme` | - | 切换主题 |
| `/permissions` | - | 管理权限规则 |
| `/mcp` | - | 显示 MCP 状态 |
| `/agents` | - | 管理子代理 |
| `/tasks` | - | 查看后台任务并恢复已结束的子代理 |
| `/skills` | - | 管理 Skills |
| `/plugins` | - | 管理插件 |
| `/hooks` | - | 管理 Hooks |
| `/resume` | - | 恢复历史会话 |
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

### /git

Git 仓库查询和 AI 辅助：

```bash
/git            # 显示 Git 状态（默认）
/git status     # 显示 Git 状态
/git log [n]    # 显示最近 n 条提交（默认 5）
/git diff       # 显示暂存区 diff
/git review     # AI 代码审查
/git commit     # AI 生成 commit message 并提交
/git pre-commit # AI 生成 commit message（不提交）
```

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
```

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
```

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
- Node.js: v20.10.0
```

### /version

显示版本信息：

```bash
/version
```

输出示例：

```
🗡️ Blade Code v0.1.0

构建信息:
- Node.js: v20.10.0
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
