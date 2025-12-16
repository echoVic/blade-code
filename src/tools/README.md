# Blade 工具系统

> Blade 工具系统的源码实现

## 快速开始

### 创建一个工具

```typescript
import { createTool } from './core/createTool.js';
import { ToolKind } from './types/index.js';
import { z } from 'zod';

export const myTool = createTool({
  name: 'my_tool',
  displayName: '我的工具',
  kind: ToolKind.ReadOnly,

  schema: z.object({
    input: z.string().describe('输入参数'),
  }),

  description: {
    short: '工具简短描述',
  },

  async execute(params, context) {
    return {
      success: true,
      llmContent: `处理结果: ${params.input}`,
      displayContent: `✅ 操作成功`,
    };
  }
});
```

### 注册工具

```typescript
import { ToolRegistry } from './registry/ToolRegistry.js';

const registry = new ToolRegistry();
registry.register(myTool);
```

## 目录结构

```
src/tools/
├── core/              # 核心工具系统
│   ├── createTool.ts  # 工具创建 API ⭐
│   └── ToolInvocation.ts
│
├── types/             # 类型定义（统一位置）⭐
│   ├── ToolTypes.ts   # Tool、ToolConfig 等
│   ├── ExecutionTypes.ts
│   └── index.ts       # 类型统一导出（已移除 SecurityTypes）
│
├── validation/        # Zod Schema 验证
│   ├── zodToJson.ts
│   └── errorFormatter.ts
│
├── registry/          # 工具注册系统
│   ├── ToolRegistry.ts
│   └── ToolResolver.ts
│
└── builtin/           # 内置工具实现
    ├── file/          # 文件操作
    ├── search/        # 搜索工具
    ├── shell/         # Shell 命令
    ├── web/           # 网络工具
    └── task/          # 任务管理
```

## 核心概念

### Tool 接口

所有工具都实现 `Tool` 接口，提供统一的 API：

- `execute()` - 执行工具逻辑
- `getFunctionDeclaration()` - 获取 LLM 函数声明
- `build()` - 构建工具调用
- `getMetadata()` - 获取元数据

### ToolResult

工具执行结果包含三部分：

```typescript
{
  success: boolean,
  llmContent: string | object,  // 给 LLM 的内容
  displayContent: string,       // 给用户的内容
  metadata?: object             // 元数据
}
```

### Zod Schema

所有参数验证使用 Zod Schema：

```typescript
schema: z.object({
  file_path: z.string().describe('文件路径'),
  content: z.string().describe('文件内容'),
  encoding: z.enum(['utf8', 'base64']).optional()
})
```

### JSONSchema7 类型

工具系统使用标准 `@types/json-schema` 包：

```typescript
import type { JSONSchema7 } from 'json-schema';

// Zod Schema 自动转换为 JSONSchema7
const zodSchema = z.object({ name: z.string() });
const jsonSchema: JSONSchema7 = zodToFunctionSchema(zodSchema);
```

**为什么使用标准类型?**

- ✅ TypeScript 社区标准约定
- ✅ 完整的 JSON Schema Draft-07 支持
- ✅ 与 Ajv、json-schema-to-typescript 等库兼容
- ✅ 零运行时开销（类型编译后消失）

## 最佳实践

### 1. 工具命名

- 使用小写字母和下划线
- 描述性命名：`read_file` 而不是 `rf`

### 2. 描述格式

```typescript
description: {
  short: '简短描述（必需）',
  long: '详细说明（可选）',
  usageNotes: ['使用说明1', '使用说明2'],
  important: ['重要提示1', '重要提示2']
}
```

### 3. 辅助函数

每个工具应包含 `formatDisplayMessage` 辅助函数：

```typescript
function formatDisplayMessage(
  path: string,
  metadata: Record<string, unknown>
): string {
  let message = `操作成功: ${path}`;
  // 添加更多详情...
  return message;
}
```

### 4. 错误处理

```typescript
async execute(params, context) {
  try {
    // 执行逻辑
    return {
      success: true,
      llmContent: result,
      displayContent: formatDisplayMessage(result)
    };
  } catch (error) {
    return {
      success: false,
      llmContent: '',
      displayContent: `❌ 操作失败: ${error.message}`,
      error: {
        message: error.message,
        type: ToolErrorType.EXECUTION_ERROR
      }
    };
  }
}
```

## 参考文档

- [工具系统架构](../../docs/TOOL_SYSTEM_ARCHITECTURE.md)
- [工具使用指南](../../docs/tools/TOOL_USAGE_GUIDE.md)
- [MCP 集成](../../docs/protocols/mcp-support.md)
