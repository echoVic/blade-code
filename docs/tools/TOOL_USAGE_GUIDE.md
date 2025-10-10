# Blade 工具使用指南

> 本文档介绍如何使用 Blade 的新工具系统

## 快速开始

### 创建一个简单的工具

```typescript
import { createTool } from '@blade/tools/core';
import { ToolKind } from '@blade/tools/types';
import { z } from 'zod';

export const helloTool = createTool({
  // 基本信息
  name: 'hello',
  displayName: 'Hello World',
  kind: ToolKind.Other,

  // 参数验证（使用 Zod）
  schema: z.object({
    name: z.string().describe('要打招呼的名字'),
    greeting: z.string().optional().describe('自定义问候语'),
  }),

  // 工具描述
  description: {
    short: '打招呼的示例工具',
    important: [
      '这是一个演示工具',
      '展示如何创建简单的工具'
    ]
  },

  // 分类和标签
  category: '示例工具',
  tags: ['demo', 'hello'],

  // 执行函数
  async execute(params, context) {
    const greeting = params.greeting || 'Hello';
    const message = `${greeting}, ${params.name}!`;

    return {
      success: true,
      llmContent: message,
      displayContent: `✅ ${message}`,
    };
  }
});
```

### 注册和使用工具

```typescript
import { ToolRegistry } from '@blade/tools/registry';
import { helloTool } from './hello-tool';

// 1. 创建注册表
const registry = new ToolRegistry();

// 2. 注册工具
registry.register(helloTool);

// 3. 获取工具
const tool = registry.get('hello');

// 4. 执行工具
const result = await tool.execute(
  { name: 'World' },
  { signal: new AbortController().signal }
);

console.log(result.displayContent); // ✅ Hello, World!
```

## 核心概念

### 1. Tool 接口

所有工具都实现统一的 `Tool` 接口：

```typescript
interface Tool {
  // 基本属性
  name: string;              // 工具唯一标识
  displayName: string;       // 显示名称
  description: ToolDescription; // 工具描述
  kind: ToolKind;           // 工具类型
  category?: string;        // 分类
  tags: string[];          // 标签

  // Schema 和验证
  schema: z.ZodSchema;      // Zod Schema
  validateParams(params: any): ValidationResult;

  // 执行
  execute(params: any, context: ExecutionContext): Promise<ToolResult>;

  // LLM 集成
  getFunctionDeclaration(): FunctionDeclaration;
}
```

### 2. 工具类型 (ToolKind)

```typescript
enum ToolKind {
  Read = 'read',        // 读取操作
  Edit = 'edit',        // 编辑操作
  Delete = 'delete',    // 删除操作
  Move = 'move',        // 移动操作
  Search = 'search',    // 搜索操作
  Execute = 'execute',  // 执行操作
  Network = 'network',  // 网络操作
  Think = 'think',      // 思考操作
  External = 'external',// 外部工具
  Other = 'other',      // 其他
}
```

### 3. 工具结果 (ToolResult)

```typescript
interface ToolResult {
  success: boolean;                // 是否成功
  llmContent: string | object;     // 传递给 LLM 的内容
  displayContent: string;          // 显示给用户的内容
  error?: ToolError;              // 错误信息
  metadata?: Record<string, any>; // 元数据
}
```

### 4. 执行上下文 (ExecutionContext)

```typescript
interface ExecutionContext {
  signal: AbortSignal;              // 中断信号
  updateOutput?: (output: string) => void; // 进度回调
  workspaceRoot?: string;           // 工作目录
  userId?: string;                  // 用户 ID
  sessionId?: string;               // 会话 ID
}
```

## 高级用法

### 复杂参数验证

```typescript
import { z } from 'zod';

const complexTool = createTool({
  name: 'complex',
  schema: z.object({
    // 字符串验证
    name: z.string()
      .min(3, '名称至少3个字符')
      .max(50, '名称最多50个字符'),

    // 数字验证
    age: z.number()
      .int('年龄必须是整数')
      .min(0, '年龄不能为负')
      .max(120, '年龄不能超过120'),

    // 枚举
    role: z.enum(['admin', 'user', 'guest']),

    // 可选字段
    email: z.string().email().optional(),

    // 数组
    tags: z.array(z.string()).min(1, '至少一个标签'),

    // 嵌套对象
    address: z.object({
      street: z.string(),
      city: z.string(),
      zip: z.string().regex(/^\d{6}$/, '邮编格式错误'),
    }),

    // 联合类型
    status: z.union([
      z.literal('active'),
      z.literal('inactive'),
      z.number(),
    ]),
  }),

  async execute(params, context) {
    // params 已经完全验证
    // TypeScript 自动推断类型
    return {
      success: true,
      llmContent: JSON.stringify(params),
      displayContent: '验证成功',
    };
  }
});
```

### 带进度反馈的长时间任务

```typescript
const longRunningTool = createTool({
  name: 'process-files',
  schema: z.object({
    files: z.array(z.string()),
  }),

  async execute(params, context) {
    const total = params.files.length;
    const results = [];

    for (let i = 0; i < total; i++) {
      const file = params.files[i];

      // 更新进度
      context.updateOutput?.(`处理中 ${i + 1}/${total}: ${file}`);

      // 检查是否中断
      if (context.signal.aborted) {
        return {
          success: false,
          llmContent: '任务已中断',
          displayContent: '❌ 任务已中断',
        };
      }

      // 处理文件
      const result = await processFile(file);
      results.push(result);
    }

    return {
      success: true,
      llmContent: results,
      displayContent: `✅ 成功处理 ${total} 个文件`,
    };
  }
});
```

### 需要确认的危险操作

```typescript
const deleteTool = createTool({
  name: 'delete-files',
  kind: ToolKind.Delete,

  // 需要用户确认
  requiresConfirmation: true,

  schema: z.object({
    paths: z.array(z.string()),
  }),

  description: {
    short: '删除文件',
    important: [
      '⚠️ 此操作不可逆',
      '请确认要删除的文件'
    ]
  },

  async execute(params, context) {
    // 用户已确认，执行删除
    for (const path of params.paths) {
      await fs.unlink(path);
    }

    return {
      success: true,
      llmContent: `已删除 ${params.paths.length} 个文件`,
      displayContent: `✅ 已删除 ${params.paths.length} 个文件`,
    };
  }
});
```

### 错误处理

```typescript
const safeTool = createTool({
  name: 'safe-operation',
  schema: z.object({
    path: z.string(),
  }),

  async execute(params, context) {
    try {
      const result = await riskyOperation(params.path);

      return {
        success: true,
        llmContent: result,
        displayContent: `✅ 操作成功`,
      };
    } catch (error) {
      return {
        success: false,
        llmContent: `操作失败: ${error.message}`,
        displayContent: `❌ ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: {
            stack: error.stack,
          }
        }
      };
    }
  }
});
```

## 内置工具

### 文件操作

- **read**: 读取文件内容
- **write**: 写入文件
- **edit**: 编辑文件（精确替换）
- **multi-edit**: 批量编辑

### 搜索工具

- **glob**: 文件模式匹配
- **grep**: 内容搜索（基于 ripgrep）
- **find**: 高级文件查找

### Shell 工具

- **bash**: Bash 命令执行
- **shell**: Shell 命令执行
- **script**: 脚本执行

### 网络工具

- **web-fetch**: 获取网页内容
- **api-call**: API 调用

### 任务管理

- **task**: Agent 任务调度

## MCP 工具集成

MCP (Model Context Protocol) 工具会自动转换为标准 Tool：

```typescript
import { McpRegistry } from '@blade/mcp';

// 1. 创建 MCP 注册表
const mcpRegistry = McpRegistry.getInstance();

// 2. 注册 MCP 服务器
await mcpRegistry.registerServer({
  name: 'github',
  command: 'npx',
  args: ['@modelcontextprotocol/server-github'],
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN
  }
});

// 3. 获取 MCP 工具（已自动转换为 Tool[]）
const mcpTools = await mcpRegistry.getAvailableTools();

// 4. 注册到工具注册表
for (const tool of mcpTools) {
  registry.registerMcpTool(tool);
}

// 5. 像使用普通工具一样使用
const githubTool = registry.get('mcp__github__create_issue');
const result = await githubTool.execute({
  owner: 'myorg',
  repo: 'myrepo',
  title: 'Bug Report',
  body: 'Description...'
}, context);
```

## 最佳实践

### 1. 清晰的命名

```typescript
// ✅ 好的命名
name: 'read-file'
displayName: '读取文件'

// ❌ 不好的命名
name: 'rf'
displayName: 'File'
```

### 2. 详细的描述

```typescript
description: {
  short: '读取文件内容',
  important: [
    '支持文本文件、图片、PDF等多种格式',
    '可以指定读取范围（offset 和 limit）',
    '大文件会自动分页'
  ]
}
```

### 3. 完善的验证

```typescript
schema: z.object({
  path: z.string()
    .describe('文件路径（绝对路径）')
    .refine(path => path.startsWith('/'), {
      message: '必须是绝对路径'
    }),

  limit: z.number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe('最多读取行数'),
})
```

### 4. 合适的分类

```typescript
// 使用有意义的分类和标签
category: '文件操作',
tags: ['file', 'read', 'io', 'filesystem'],
```

### 5. 一致的返回格式

```typescript
// ✅ 成功
return {
  success: true,
  llmContent: actualData,
  displayContent: '✅ 用户友好的消息',
  metadata: { /* 额外信息 */ }
};

// ❌ 失败
return {
  success: false,
  llmContent: '错误描述',
  displayContent: '❌ 错误消息',
  error: {
    type: ToolErrorType.EXECUTION_ERROR,
    message: '详细错误信息'
  }
};
```

## 调试技巧

### 1. 参数验证测试

```typescript
const tool = registry.get('my-tool');

// 测试参数验证
const validationResult = tool.validateParams({
  name: 'test',
  age: -1 // 无效
});

if (!validationResult.valid) {
  console.error('验证失败:', validationResult.errors);
}
```

### 2. 查看工具声明

```typescript
const tool = registry.get('my-tool');
const declaration = tool.getFunctionDeclaration();

console.log('Tool Declaration:', JSON.stringify(declaration, null, 2));
```

### 3. 搜索工具

```typescript
// 按名称搜索
const tools = registry.search('file');

// 按分类获取
const fileTools = registry.getByCategory('文件操作');

// 按标签获取
const readTools = registry.getByTag('read');
```

## 常见问题

### Q: 如何处理可选参数？

```typescript
schema: z.object({
  required: z.string(),
  optional: z.string().optional(),
  withDefault: z.string().default('default value'),
})
```

### Q: 如何支持多种输入格式？

```typescript
schema: z.object({
  input: z.union([
    z.string(),
    z.number(),
    z.object({ value: z.string() })
  ])
})
```

### Q: 如何中断长时间运行的工具？

```typescript
async execute(params, context) {
  const operation = longOperation();

  context.signal.addEventListener('abort', () => {
    operation.cancel();
  });

  return await operation.run();
}
```

### Q: 如何添加进度反馈？

```typescript
async execute(params, context) {
  for (let i = 0; i < 100; i++) {
    context.updateOutput?.(`进度: ${i + 1}/100`);
    await processStep(i);
  }
}
```

## 总结

Blade 的新工具系统提供了：

- ✅ 统一的 API
- ✅ 类型安全的参数验证
- ✅ 简洁的工具创建方式
- ✅ 完整的 MCP 支持
- ✅ 灵活的扩展机制

立即开始创建你的第一个工具吧！🚀
