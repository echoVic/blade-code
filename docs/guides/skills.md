# ⚡ Skills 系统

Skills 是 Blade 的动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力。

## 概述

Skills 基于文件系统的简单架构：

- 每个 Skill 是一个目录，包含 `SKILL.md` 文件
- 通过 YAML frontmatter 定义元数据
- 正文作为 Skill 的指令内容
- 可选包含脚本、模板等资源

## 目录结构

```
~/.blade/skills/           # 用户级 Skills
  └─ my-skill/
      ├─ SKILL.md          # Skill 定义（必需）
      ├─ scripts/          # 可选脚本
      └─ templates/        # 可选模板

<project>/.blade/skills/   # 项目级 Skills（优先级更高）
  └─ project-skill/
      └─ SKILL.md
```

## SKILL.md 格式

```markdown
---
name: code-review
description: 对代码进行专业审查，发现潜在问题和改进建议。当用户请求代码审查时使用。
version: 1.0.0
allowedTools:
  - Read
  - Grep
  - Glob
argumentHint: <file_path>
userInvocable: true
---

# Code Review Skill

你是一名专业的代码审查专家。

## 审查流程

1. 首先使用 Read 工具读取目标文件
2. 分析代码结构和逻辑
3. 识别潜在问题和改进点
4. 给出具体的修改建议

## 审查重点

- 代码质量和可读性
- 潜在的 Bug 和边界条件
- 安全风险
- 性能问题
- 最佳实践遵循情况

## 输出格式

请按以下格式输出审查结果：

### 问题列表

| 严重程度 | 位置 | 问题 | 建议 |
|----------|------|------|------|
| 高/中/低 | 行号 | 描述 | 修复方案 |

### 总结

简要总结代码质量和主要改进建议。
```

## 元数据字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 唯一标识，小写+数字+连字符，≤64字符 |
| `description` | string | ✅ | 激活描述，≤1024字符，包含"什么"和"何时使用" |
| `version` | string | - | 版本号 |
| `allowedTools` | string[] | - | 工具访问限制，如 `['Read', 'Grep']` |
| `argumentHint` | string | - | 参数提示，如 `<file_path>` |
| `userInvocable` | boolean | - | 是否支持用户通过命令调用（默认 false） |
| `disableModelInvocation` | boolean | - | 是否禁止 AI 自动调用（默认 false） |
| `model` | string | - | 指定执行模型 |
| `whenToUse` | string | - | 额外的触发条件描述 |

## 使用方式

### AI 自动调用

当 AI 识别到用户请求匹配某个 Skill 时，会自动调用：

```
用户: 帮我审查 src/agent/Agent.ts 的代码

AI: [识别到 code-review skill，自动调用]
    正在使用 code-review skill 进行代码审查...
```

### 用户手动调用

如果 Skill 设置了 `userInvocable: true`，可以通过 Skill 工具调用：

```
用户: 使用 code-review skill 审查 src/utils/git.ts
```

### 管理命令

```bash
/skills         # 列出所有可用 Skills
/skills list    # 列出所有 Skills
/skills info <name>  # 查看 Skill 详情
```

## 内置 Skills

`skill-creator` 和 `update-config` 随 Blade 包提供，无需下载即可使用。首次启动、工作区初始化和刷新只发现本地技能，不会自动 clone GitHub 仓库或创建默认技能目录。

已安装的同名本地 Skill 仍按原有优先级覆盖内置版本，目录符号链接也会被发现。可在 Web 设置的「技能」面板显式安装官方、仓库或本地技能；卸载用户级覆盖版本后恢复内置内容。卸载本地链接只移除链接，不删除源目录。

Web 的「已安装」列表、刷新、启用和卸载只访问本地技能，不会提前请求远端目录。打开「安装技能」并查看「目录」页时才加载官方目录；目录失败会显示错误并允许重试，不阻止切换到仓库或本地路径安装。关闭弹窗、停留在仓库或本地页时不会新发目录请求。

## 安装输入要求

- 技能安装名为 1–64 个小写字母、数字或连字符，首尾必须是字母或数字；省略名称时，从仓库名或本地目录名推导，同样需要校验。
- 仓库地址支持 `https://`、`ssh://` 和 `git@host:owner/repo.git`。不接受内嵌凭据、查询参数、片段、本地 `file://` 地址或 Git 外部协议；私有仓库沿用 Git 凭据管理器或 SSH 配置。
- 本地安装路径可以包含空格。源目录与安装目标不得相同，也不得互相包含；拒绝时不会删除源内容。正常符号链接安装与重复安装保持可用。
- 非法请求返回 400；网络失败或缺少 `SKILL.md` 等安装失败仍返回非成功状态。

## 示例 Skills

### Base64 编解码

```markdown
---
name: base64-parser
description: 编码或解码 Base64 字符串。当用户需要处理 Base64 数据时使用。
allowedTools:
  - Bash
argumentHint: <encode|decode> <text>
userInvocable: true
---

# Base64 Parser

根据用户请求进行 Base64 编码或解码。

## 使用方式

- 编码: `encode <text>`
- 解码: `decode <base64_string>`

## 实现

使用 Bash 工具执行 base64 命令：

- 编码: `echo -n "text" | base64`
- 解码: `echo "base64_string" | base64 -d`
```

### Git 提交助手

```markdown
---
name: git-commit-helper
description: 分析代码改动并生成规范的 commit message。当用户需要提交代码时使用。
allowedTools:
  - Bash
  - Read
userInvocable: true
---

# Git Commit Helper

分析暂存区的改动，生成符合 Conventional Commits 规范的 commit message。

## 流程

1. 执行 `git diff --staged` 获取改动
2. 分析改动类型（feat/fix/docs/refactor 等）
3. 生成简洁准确的 commit message
4. 可选：自动执行 git commit

## 输出格式

```
<type>(<scope>): <subject>

<body>
```
```

## 工具限制

通过 `allowedTools` 可以限制 Skill 执行期间可用的工具：

```yaml
allowedTools:
  - Read
  - Grep
  - Glob
  - Bash(git:*)  # 只允许 git 相关命令
```

限制仅作用于调用 Skill 的当前逻辑回合，包含该回合的多次模型请求与 Plan 批准后执行。
回合完成、失败、取消或关闭后释放限制；同一会话的下一条普通任务不会继承旧限制。
被拒绝的并发调用不会清除正在运行回合的限制。历史 Skill 正文仍保留在对话中。

## 与 Subagents 的区别

| 特性 | Skills | Subagents |
|------|--------|-----------|
| 用途 | 特定任务的 Prompt 扩展 | 独立的子代理执行任务 |
| 执行方式 | 在当前会话中执行 | 创建新的 Agent 实例 |
| 状态 | 共享当前会话状态 | 无状态，独立上下文 |
| 工具限制 | 可限制可用工具 | 可限制可用工具 |
| 适用场景 | 简单的专业任务 | 复杂的多步骤任务 |

## 相关资源

- [Subagents](subagents.md) - 子代理系统
- [工具列表](../reference/tool-list.md) - Skill 工具
- [权限控制](../configuration/permissions.md) - 工具权限
