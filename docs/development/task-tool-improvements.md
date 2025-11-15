# Task 工具改进：工具隔离 + 自动委托

> 实现日期：2025-11-14
> 基于竞品分析的优先级改进

## 📋 改进概述

根据对 **Claude Code**、**OpenCode** 和 **Cursor 2.0** 的竞品分析，我们实现了两个优先级最高的改进：

1. **工具隔离（安全性）** - 限制子 Agent 可用的工具列表
2. **自动委托提示（便利性）** - 引导 LLM 主动使用 Task 工具

---

## 🔒 改进 1：工具隔离（安全性）

### 问题

**之前**：子 Agent 继承所有工具，可能执行危险操作（如删除文件、执行系统命令）

```typescript
// 旧实现：子 Agent 继承所有工具
const subAgent = await agentFactory(dynamicSystemPrompt);
// 可以使用：Read, Write, Edit, Bash, WebSearch, WebFetch 等所有工具
```

### 解决方案

**现在**：添加可选的 `tools` 参数，限制子 Agent 可用的工具列表

```typescript
// 新实现：可以限制工具访问
Task({
  description: '查找测试文件',
  prompt: '查找所有 .test.ts 文件',
  tools: ['Read', 'Grep', 'Glob']  // 只允许只读工具
})
```

### 实现细节

#### 1. Schema 扩展

```typescript
// src/tools/builtin/task/task.ts:47-61
schema: z.object({
  description: z.string().min(3).max(100),
  prompt: z.string().min(10),
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
  tools: z.array(z.string()).optional()  // 🆕 工具白名单
    .describe('允许使用的工具列表（可选，默认允许所有工具）')
}),
```

#### 2. Agent Factory 签名更新

```typescript
// src/tools/builtin/task/task.ts:18-31
let agentFactory:
  | ((systemPrompt?: string, allowedTools?: string[]) => Promise<Agent>)
  | undefined;

export function setTaskToolAgentFactory(
  factory: (systemPrompt?: string, allowedTools?: string[]) => Promise<Agent>
): void {
  agentFactory = factory;
}
```

#### 3. 工具过滤实现

```typescript
// src/ui/hooks/useCommandHandler.ts:148-160
if (allowedTools && allowedTools.length > 0) {
  const toolRegistry = agent.getToolRegistry();
  const allTools = toolRegistry.getAll();

  // 禁用不在允许列表中的工具
  for (const tool of allTools) {
    if (!allowedTools.includes(tool.name)) {
      toolRegistry.unregister(tool.name);
    }
  }
}
```

#### 4. Agent API 扩展

```typescript
// src/agent/Agent.ts:1086-1091
/**
 * 获取工具注册表（用于子 Agent 工具隔离）
 */
public getToolRegistry(): ToolRegistry {
  return this.executionPipeline.getRegistry();
}
```

#### 5. 动态系统提示词生成

```typescript
// src/tools/builtin/task/task.ts:278-361
function buildDynamicSystemPrompt(
  taskPrompt: string,
  model: string,
  allowedTools?: string[]
): string {
  // 工具限制说明
  if (allowedTools && allowedTools.length > 0) {
    basePrompt += `⚠️ **工具访问限制**：你只能使用以下工具：${allowedTools.join(', ')}`;

    // 只列出允许的工具
    for (const tool of allowedTools) {
      basePrompt += `- **${tool}**: ${allTools[tool]}\n`;
    }

    // 添加严格遵守提示
    basePrompt += `5. **严格遵守工具限制**: 不要尝试使用未授权的工具\n`;
  }

  return basePrompt;
}
```

### 使用示例

#### 示例 1：只读权限（安全搜索）

```typescript
Task({
  description: '查找测试文件',
  prompt: '查找项目中所有的测试文件（.test.ts, .spec.ts）',
  tools: ['Read', 'Grep', 'Glob']  // 只允许只读工具
})
```

#### 示例 2：读写权限（文档生成）

```typescript
Task({
  description: '生成 API 文档',
  prompt: '分析 src/api/ 目录下的所有 API 路由，生成完整的 API 文档',
  tools: ['Read', 'Grep', 'Glob', 'Write']  // 允许读取和写入，但不允许执行命令
})
```

#### 示例 3：完全权限（依赖分析）

```typescript
Task({
  description: '分析项目依赖',
  prompt: '分析项目中的所有依赖包，检查过时的包和安全漏洞',
  // 不指定 tools，允许所有工具
})
```

### 安全最佳实践

| 任务类型 | 推荐工具 | 原因 |
|---------|---------|------|
| 文件搜索 | `Read, Grep, Glob` | 只读操作，安全 |
| 代码分析 | `Read, Grep, Glob` | 只读操作，安全 |
| 文档生成 | `Read, Grep, Glob, Write` | 允许写入，但不执行命令 |
| 依赖检查 | `Read, Bash` | 需要执行 npm 命令 |
| 完整任务 | 不指定（默认所有） | 信任模型决策 |

---

## 🔥 改进 2：自动委托提示（便利性）

### 问题

**之前**：LLM 需要主动决定使用 Task 工具，可能错过适用场景

```typescript
// 旧描述：简单说明功能
description: {
  short: '启动独立的 AI 助手执行任务',
  long: '启动独立的 AI 助手来处理复杂任务...'
}
```

### 解决方案

**现在**：在工具描述中添加明确的触发场景和 "Use PROACTIVELY" 提示

```typescript
// 新描述：明确触发场景 + 强烈建议主动使用
**🔥 自动委托提示（Use PROACTIVELY）：**
当遇到以下场景时，**强烈建议**主动使用此工具：
- 需要**深入分析代码结构**或架构设计
- 需要**搜索大量文件**或执行复杂的代码搜索
- 需要**生成文档、报告或总结**
- 需要**多步骤推理**或执行复杂的工作流
- 任务可以**独立完成**，不需要与用户频繁交互
```

### 实现细节

#### 1. 工具描述增强

```typescript
// src/tools/builtin/task/task.ts:63-95
description: {
  short: '启动独立的 AI 助手自主执行复杂的多步骤任务',
  long: `
启动独立的 AI 助手来处理复杂任务。助手会自动选择合适的工具和策略来完成任务。

**🔥 自动委托提示（Use PROACTIVELY）：**
当遇到以下场景时，**强烈建议**主动使用此工具：
- 需要**深入分析代码结构**或架构设计
- 需要**搜索大量文件**或执行复杂的代码搜索
- 需要**生成文档、报告或总结**
- 需要**多步骤推理**或执行复杂的工作流
- 任务可以**独立完成**，不需要与用户频繁交互

**适用场景：**
- 代码分析：分析项目依赖、检查代码质量、查找潜在问题
- 文件搜索：查找测试文件、配置文件、特定模式的代码
- 文档生成：生成 API 文档、README、技术报告
- 重构建议：分析代码并提供重构方案
- 问题诊断：调查 bug、分析日志、查找错误原因

**助手的能力：**
- 自动选择和使用工具（Read、Write、Grep、Glob、Bash、WebSearch 等）
- 自主决定执行策略和步骤
- 独立的执行上下文（不共享父 Agent 的对话历史）
- 可限制工具访问（通过 tools 参数提升安全性）

**⚠️ 重要：**
- 这不是 TODO 清单管理工具（使用 TodoWrite 管理任务清单）
- prompt 应该包含完整的上下文和详细的期望输出
- 助手会消耗独立的 API token
- 对于敏感操作，可通过 tools 参数限制工具使用（如只允许只读工具）
  `.trim(),
}
```

#### 2. 使用说明更新

```typescript
// src/tools/builtin/task/task.ts:96-103
usageNotes: [
  'description 应简短（3-10个词），如"分析项目依赖"',
  'prompt 应详细完整，包含任务目标、期望输出格式',
  '助手无法访问父 Agent 的对话历史，需在 prompt 中提供完整上下文',
  '助手会自动选择合适的工具，无需指定（除非使用 tools 参数限制）',
  'model 参数可选：haiku（快速）、sonnet（平衡）、opus（高质量）',
  'tools 参数可选：限制可用工具列表，提升安全性（如：["Read", "Grep", "Glob"]）',
]
```

#### 3. 重要提示增强

```typescript
// src/tools/builtin/task/task.ts:133-140
important: [
  '⚠️ 这不是 TODO 清单工具！管理任务清单请使用 TodoWrite',
  '🔥 当需要深入分析、大量搜索、生成文档时，主动使用此工具（PROACTIVELY）',
  '助手会消耗独立的 API token',
  '助手无法访问父 Agent 的对话历史',
  'prompt 应该详细完整，包含所有必要的上下文',
  '🔒 对于敏感操作，使用 tools 参数限制工具访问（安全最佳实践）',
]
```

#### 4. 示例更新

```typescript
// src/tools/builtin/task/task.ts:104-132
examples: [
  {
    description: '分析项目依赖（完全权限）',
    params: {
      description: '分析项目依赖',
      prompt: '分析项目中的所有依赖包...',
    },
  },
  {
    description: '查找测试文件（只读权限）',
    params: {
      description: '查找测试文件',
      prompt: '查找项目中所有的测试文件...',
      tools: ['Read', 'Grep', 'Glob'], // 只允许只读工具
    },
  },
  {
    description: '生成 API 文档（高质量模型）',
    params: {
      description: '生成 API 文档',
      prompt: '分析 src/api/ 目录下的所有 API 路由...',
      model: 'opus',
      tools: ['Read', 'Grep', 'Glob', 'Write'], // 允许读写，但不允许执行命令
    },
  },
]
```

### 触发场景

LLM 应该在以下情况下**主动使用** Task 工具：

| 场景 | 示例用户请求 | 为什么适合 Task |
|-----|-------------|----------------|
| 代码分析 | "分析项目依赖" | 需要读取多个文件，检查版本 |
| 文件搜索 | "查找所有测试文件" | 需要 Glob/Grep 多次搜索 |
| 文档生成 | "生成 API 文档" | 需要读取代码、分析、写入文档 |
| 架构分析 | "这个项目的架构是什么" | 需要探索多个目录和文件 |
| 问题诊断 | "为什么构建失败" | 需要查看日志、配置、代码 |

---

## 📊 改进对比

### 参数对比

| 参数 | 旧版本 | 新版本 | 说明 |
|-----|-------|-------|------|
| `description` | ✅ | ✅ | 任务简短描述 |
| `prompt` | ✅ | ✅ | 详细任务指令 |
| `model` | ✅ | ✅ | 模型选择 |
| `tools` | ❌ | ✅ | 🆕 工具白名单（安全） |

### 功能对比

| 功能 | 旧版本 | 新版本 | 改进 |
|-----|-------|-------|------|
| 工具隔离 | ❌ | ✅ | 提升安全性 |
| 自动委托提示 | ❌ | ✅ | 提升便利性 |
| 动态提示词 | ✅ | ✅ | 保持 |
| 模型选择 | ✅ | ✅ | 保持 |

### 与竞品对比

| 特性 | Claude Code | OpenCode | Blade (新版) |
|-----|------------|----------|-------------|
| 工具隔离 | ✅ tools 字段 | ✅ tools 布尔映射 | ✅ tools 数组 |
| 自动委托 | ✅ PROACTIVELY | ✅ mode 系统 | ✅ 场景提示 |
| 配置方式 | Markdown 文件 | Markdown 文件 | 代码参数 ✅ |
| 动态提示词 | ❌ 硬编码 | ❌ 固定 | ✅ 动态生成 |

---

## 🎯 使用指南

### 场景 1：安全的文件搜索

```typescript
// 任务：查找所有配置文件
// 风险：低（只读操作）
// 推荐：限制工具为只读

Task({
  description: '查找配置文件',
  prompt: '查找项目中所有的配置文件（.json, .yaml, .toml），列出路径和用途',
  tools: ['Read', 'Grep', 'Glob']  // 只读工具
})
```

### 场景 2：文档生成

```typescript
// 任务：生成完整的 API 文档
// 风险：中（需要写入文件）
// 推荐：允许读写，但不允许执行命令

Task({
  description: '生成 API 文档',
  prompt: `
分析 src/api/ 目录下的所有 API 路由，生成完整的 API 文档。

要求：
1. 分析所有路由文件
2. 提取路由、请求参数、响应格式
3. 生成 Markdown 格式的文档
4. 保存到 docs/api.md
  `,
  model: 'opus',  // 使用高质量模型
  tools: ['Read', 'Grep', 'Glob', 'Write']  // 允许读写
})
```

### 场景 3：完整的依赖分析

```typescript
// 任务：分析项目依赖并检查更新
// 风险：中（需要执行 npm 命令）
// 推荐：允许所有工具（信任模型）

Task({
  description: '分析项目依赖',
  prompt: `
分析项目依赖并生成报告：

1. 读取 package.json
2. 使用 npm outdated 检查过时的包
3. 使用 npm audit 检查安全漏洞
4. 生成 Markdown 报告，包含：
   - 过时的包及最新版本
   - 安全漏洞及修复建议
   - 升级优先级排序
  `,
  model: 'sonnet'
  // 不指定 tools，允许使用所有工具
})
```

---

## 🔍 技术细节

### 工具过滤实现

```typescript
// 1. 创建 Agent
const agent = await Agent.create({
  systemPrompt: dynamicSystemPrompt,
  appendSystemPrompt: appendSystemPrompt,
  maxTurns: maxTurns,
});

// 2. 如果指定了工具限制，则过滤
if (allowedTools && allowedTools.length > 0) {
  const toolRegistry = agent.getToolRegistry();
  const allTools = toolRegistry.getAll();

  // 3. 禁用不在白名单中的工具
  for (const tool of allTools) {
    if (!allowedTools.includes(tool.name)) {
      toolRegistry.unregister(tool.name);
    }
  }
}

return agent;
```

### 系统提示词生成

```typescript
// 根据工具限制生成不同的提示词
if (allowedTools && allowedTools.length > 0) {
  basePrompt += `⚠️ **工具访问限制**：你只能使用以下工具：${allowedTools.join(', ')}`;

  // 只列出允许的工具
  for (const tool of allowedTools) {
    if (allTools[tool]) {
      basePrompt += `- **${tool}**: ${allTools[tool]}\n`;
    }
  }

  // 添加严格遵守提示
  basePrompt += `5. **严格遵守工具限制**: 不要尝试使用未授权的工具\n`;
}
```

---

## ✅ 验证清单

### 功能验证

- [x] `tools` 参数可选，默认允许所有工具
- [x] 指定 `tools` 后，子 Agent 只能使用指定工具
- [x] 系统提示词正确反映工具限制
- [x] 工具描述包含 "Use PROACTIVELY" 提示
- [x] 示例展示不同的工具限制场景

### 安全验证

- [x] 只读工具：`Read, Grep, Glob`
- [x] 读写工具：`Read, Grep, Glob, Write, Edit`
- [x] 执行工具：`Bash`
- [x] 网络工具：`WebSearch, WebFetch`

### 构建验证

```bash
npm run build
# ✅ Bundled 1450 modules in 213ms
# ✅ blade.js  6.92 MB
```

---

## 📚 相关文档

- [竞品分析](./task-tool-competitive-analysis.md) - 详细的竞品对比
- [V2 重构文档](./task-tool-refactor-v2.md) - 简洁设计哲学
- [Agent 无状态设计](./agent-stateless-design.md) - Agent 架构

---

## 🎉 总结

通过这两个改进，Blade 的 Task 工具现在具备：

1. **✅ 安全性**：通过工具隔离防止子 Agent 执行危险操作
2. **✅ 便利性**：通过明确的触发场景引导 LLM 主动使用
3. **✅ 灵活性**：保持简洁的 API，工具限制为可选参数
4. **✅ 竞争力**：在安全性和便利性上达到竞品水平

同时保持了 Blade 的核心优势：

- **极简 API**：只有 2 个必需参数
- **动态提示词**：运行时生成，无需配置文件
- **模型决策**：信任模型的能力，最小化限制

这些改进使 Blade 在保持简洁设计的同时，提升了安全性和可用性！
