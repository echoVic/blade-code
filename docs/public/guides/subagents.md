# Subagents 系统

Subagent 是可定制的子代理，Task 工具会根据配置选择合适的子代理执行子任务。当前实现不内置任何样例配置，全部从本地文件加载。

## 加载位置与优先级

`SubagentRegistry` 会按顺序加载：

1. `~/.blade/agents/*.md`（用户级）
2. `<project>/.blade/agents/*.md`（项目级，优先级更高）

每个文件需包含 YAML frontmatter 与正文，frontmatter 描述元数据，正文作为系统提示词。

```markdown
---
name: code-reviewer
description: Review code for bugs and risks. Use this when you need critical feedback.
tools:
  - Read
  - Grep
  - Glob
color: blue   # 可选：red/blue/green/yellow/purple/orange/pink/cyan
---

# 这里是系统提示词
你是一名代码审查专家...
```

字段说明：
- `name`：唯一标识（kebab-case）。
- `description`：简要用途，建议包含 “Use this when …” 场景。
- `tools`：允许的工具列表，留空则不做限制。
- `color`：UI 标记颜色（可选）。

## 使用方式

- **调用**：在对话中提出需求并指名 subagent，或让 LLM 自行选择；Task 工具会在 Plan/默认循环中按权限模式执行。
- **管理**：输入 `/agents` 打开管理器；`/agents list` 文本列出所有 subagents；`/agents create` 打开创建向导；`/agents help` 查看格式说明。
- **查看可用类型**：在系统提示中会列出已加载的 subagents 及其工具集（见 `getDescriptionsForPrompt`）。

## 注意事项

- Subagent 是无状态的，每次调用使用新的上下文。
- 工具权限仍受主会话的权限模式约束（Plan 模式下 Task 仍被视为只读）。
- 修改或新增配置后需重启 Blade 或再次进入 UI 以重新加载。
