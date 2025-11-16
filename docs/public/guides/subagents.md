# Subagents 系统

Subagents 是 Blade 的专用子代理系统,允许你创建具有特定职责和工具集的专门化 AI 代理。

## 什么是 Subagent?

Subagent 是一个专门化的 AI 代理,具有:

- **明确的职责** - 专注于特定类型的任务(如代码探索、实施规划、代码审查)
- **受限的工具集** - 只能使用配置中指定的工具,提高执行效率
- **自定义系统提示** - 针对特定任务优化的行为指令
- **独立执行** - 在主 Agent 调用后自主完成任务,返回结果

## 内置 Subagents

Blade 提供三个内置 subagent:

### Explore

**用途**: 快速探索代码库,查找文件和代码模式

**可用工具**: Glob, Grep, Read

**使用场景**:
- 查找特定文件或模式
- 搜索代码关键字
- 回答代码库相关问题

**示例**:
```
用 Explore 找到所有 React 组件
用 Explore 搜索错误处理相关代码
```

### Plan

**用途**: 创建详细的实施计划

**可用工具**: Glob, Grep, Read

**使用场景**:
- 将复杂任务分解为可执行步骤
- 分析需求并设计实施策略
- 创建带有文件路径和具体步骤的计划

**示例**:
```
用 Plan 设计一个用户认证系统
用 Plan 规划如何重构这个模块
```

### code-reviewer

**用途**: 分析代码质量并识别潜在问题

**可用工具**: Read, Grep, Glob

**使用场景**:
- 审查代码错误和安全漏洞
- 检查性能问题
- 验证最佳实践

**示例**:
```
用 code-reviewer 审查认证模块
用 code-reviewer 检查安全漏洞
```

## 如何使用 Subagent?

### 方式 1: 通过对话直接请求

在对话中明确提到 subagent 名称:

```
用 Explore 帮我找到所有 API 端点
用 Plan 设计一个新功能
用 code-reviewer 审查我的代码
```

Blade 会自动调用相应的 subagent 执行任务。

### 方式 2: 通过 /agents 命令

使用 `/agents` 命令管理 subagents:

```bash
/agents list          # 查看所有可用 subagents
/agents create        # 创建新 subagent
/agents edit          # 编辑现有 subagent
/agents delete        # 删除 subagent
```

## 创建自定义 Subagent

### 使用 UI 向导创建

1. 输入 `/agents create`
2. 选择创建方式:
   - **手动配置** - 逐步填写配置
   - **AI 生成** - 描述需求,由 AI 自动生成配置

3. 填写或确认配置:
   - 名称 (kebab-case)
   - 描述 (包含"Use this when..."场景说明)
   - 工具列表
   - 颜色
   - 存储位置 (项目级或用户级)
   - 系统提示

### 手动创建配置文件

在以下位置创建 `.md` 文件:

- **项目级**: `.blade/agents/your-agent.md`
- **用户级**: `~/.blade/agents/your-agent.md`

**文件格式**:

```markdown
---
name: my-custom-agent
description: Fast agent specialized for specific task. Use this when you need to [具体场景].
tools:
  - Read
  - Grep
  - Glob
color: blue
---

# My Custom Agent

You are a specialized agent for [specific purpose].

## Responsibilities
- [职责 1]
- [职责 2]

## Workflow
1. [步骤 1]
2. [步骤 2]

## Output Format
[输出格式说明]
```

### 配置字段说明

| 字段 | 必需 | 说明 |
|-----|------|------|
| `name` | ✅ | kebab-case 格式,如 `code-reviewer` |
| `description` | ✅ | 简洁描述 + "Use this when..." 使用场景 |
| `tools` | ⚪ | 可用工具列表,为空则允许所有工具 |
| `color` | ⚪ | UI 显示颜色: red, blue, green, yellow, purple, orange, pink, cyan |

**Markdown 正文** 作为系统提示,详细说明:
- Agent 的职责
- 工作流程
- 输出格式
- 最佳实践

## 可用工具列表

Subagent 可以使用的工具:

| 工具 | 用途 |
|-----|------|
| Glob | 文件模式匹配 (如 `*.ts`) |
| Grep | 代码内容搜索 |
| Read | 读取文件内容 |
| Write | 写入/创建文件 |
| Edit | 编辑文件 (字符串替换) |
| Bash | 执行命令行命令 |

**建议**: 只授予 subagent 完成任务所需的最小工具集。

## 示例: 创建测试生成 Agent

创建文件 `.blade/agents/test-generator.md`:

```markdown
---
name: test-generator
description: Fast agent specialized for generating unit tests. Use this when you need to create test cases for existing code.
tools:
  - Read
  - Write
  - Grep
color: cyan
---

# Test Generator Agent

You are a specialized test generation agent. Your goal is to create comprehensive unit tests for existing code.

## Responsibilities
- Analyze source code structure and dependencies
- Generate test cases covering edge cases
- Use appropriate testing framework (Jest, Vitest, etc.)
- Include setup, assertions, and cleanup

## Workflow
1. Use Read to examine the source file
2. Use Grep to find related files and dependencies
3. Identify functions, classes, and methods to test
4. Generate test file with proper imports
5. Use Write to create the test file

## Output Format
Return the generated test file path and a summary of test cases created.
```

**使用方法**:
```
用 test-generator 为 UserService.ts 生成测试
```

## 最佳实践

### 1. 描述要包含使用场景

❌ 不好:
```yaml
description: Code review agent
```

✅ 好:
```yaml
description: Fast agent specialized for code review. Use this when you need to analyze code quality, find bugs, or check security issues.
```

### 2. 最小化工具集

只授予必要的工具:

```yaml
# 只读任务 (探索、分析)
tools:
  - Read
  - Grep
  - Glob

# 写入任务 (生成代码)
tools:
  - Read
  - Write

# 修改任务 (重构)
tools:
  - Read
  - Edit
```

### 3. 系统提示要详细明确

包含:
- 明确的职责说明
- 具体的工作流程
- 期望的输出格式
- 相关的最佳实践

### 4. 使用合适的颜色

选择能反映 agent 用途的颜色:

- 🔴 Red - 探索、搜索
- 🔵 Blue - 规划、设计
- 🟢 Green - 审查、验证
- 🟡 Yellow - 警告、检查
- 🟣 Purple - 生成、创建
- 🟠 Orange - 优化、改进
- 🩷 Pink - 文档、说明
- 🩵 Cyan - 测试、调试

## 常见问题

### Subagent 看不到对话历史吗?

是的。Subagent 是**无状态**的,每次调用都是独立的。你需要在请求中包含所有必要信息。

### Subagent 可以调用其他 Subagent 吗?

不可以。Subagent 是扁平的,不支持嵌套调用。

### 如何调试 Subagent?

1. 使用 `--debug` 标志运行 Blade
2. 检查 `~/.blade/projects/.../context.jsonl` 中的执行记录
3. 查看 subagent 的返回结果

### Subagent 配置可以热重载吗?

可以。使用 `/agents` 命令创建/编辑/删除后会自动重新加载,无需重启 Blade。

## 技术细节

- **配置格式**: YAML frontmatter + Markdown 正文
- **存储位置**: `.blade/agents/` (项目级) 或 `~/.blade/agents/` (用户级)
- **加载时机**: 应用启动时和 `/agents` 命令完成后
- **执行方式**: 通过 Task 工具调用,传递 `subagent_type` 参数
- **隔离性**: 每个 subagent 有独立的工具集和系统提示

## 相关文档

- [Plan 模式](guides/plan-mode.md) - 规划优先的工作流
- [工具列表](reference/tool-list.md) - 所有可用工具
- [CLI 命令](reference/cli-commands.md) - 命令行参考
