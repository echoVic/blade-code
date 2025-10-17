# Blade 工具系统架构文档

> **版本**: v2.0
> **更新时间**: 2025-10-10
> **状态**: ✅ 已完成并优化

## 一、架构概览

Blade 工具系统基于**统一、简洁、类型安全**的设计原则，提供强大而灵活的工具扩展能力。

### 核心特性

- ✅ **统一接口**: 所有工具（内置/MCP/自定义）使用相同的 `Tool` 接口
- ✅ **类型安全**: 端到端 TypeScript 类型推断，基于 Zod Schema
- ✅ **简洁 API**: 通过 `createTool` 函数创建工具，无需复杂继承
- ✅ **MCP 集成**: 自动转换 MCP 工具为标准 Tool
- ✅ **模块化**: 清晰的目录结构，职责分明

## 二、目录结构

```
src/tools/
├── core/                        # 核心工具系统
│   ├── createTool.ts           # 统一的工具创建 API ⭐
│   ├── ToolInvocation.ts       # 工具调用抽象
│   └── index.ts                # 核心导出
│
├── types/                       # 类型定义（统一位置） ⭐
│   ├── ToolTypes.ts            # 工具类型（Tool、ToolConfig、ToolDescription）
│   ├── ExecutionTypes.ts       # 执行上下文类型
│   ├── SecurityTypes.ts        # 安全相关类型（ValidationError等）
│   └── index.ts                # 类型统一导出
│
├── validation/                  # 验证系统
│   ├── zod-schemas.ts          # Zod Schema 工具函数
│   ├── zod-to-json.ts          # Zod → JSON Schema 转换
│   ├── error-formatter.ts      # 错误格式化
│   └── index.ts                # 验证导出
│
├── registry/                    # 工具注册系统
│   ├── ToolRegistry.ts         # 主注册表
│   ├── ToolResolver.ts         # 工具解析器
│   └── index.ts                # 注册系统导出
│
├── builtin/                     # 内置工具（13个）
│   ├── file/                   # 文件操作（4个）
│   │   ├── read.ts             # 读取文件
│   │   ├── write.ts            # 写入文件
│   │   ├── edit.ts             # 编辑文件
│   │   └── multi-edit.ts       # 批量编辑
│   ├── search/                 # 搜索工具（3个）
│   │   ├── glob.ts             # 文件模式匹配
│   │   ├── grep.ts             # 内容搜索
│   │   └── find.ts             # 文件查找
│   ├── shell/                  # Shell 命令（3个）
│   │   ├── bash.ts             # Bash 命令
│   │   ├── shell.ts            # 通用 Shell
│   │   └── script.ts           # 脚本执行
│   ├── web/                    # 网络工具（2个）
│   │   ├── web-fetch.ts        # 网页抓取
│   │   └── api-call.ts         # API 调用
│   ├── task/                   # 任务管理（1个）
│   │   └── task.ts             # 任务代理
│   └── index.ts                # 内置工具导出
│
└── index.ts                     # 工具系统统一导出
```

### 架构优化成果

**类型系统优化** ✅
- 所有类型定义统一在 `types/` 文件夹
- **迁移到标准 `@types/json-schema`**: 使用社区标准类型定义
- 删除重复定义：`core/types.ts`（110行）、`McpTypes.ts`（70行）
- 删除自定义 `JSONSchema7` 接口（22行），使用标准定义
- 解决了 `ValidationError`/`ValidationResult` 重复定义问题
- 修复了 `output`/`displayMessage` 字段名称问题

**代码精简** ✅
- 删除未使用代码：`ToolDiscovery.ts`（201行）
- 删除冗余类型定义：`convertZodToJsonSchema` 函数（61行）
- 净删除：442行重复/未使用代码
- 新增：74行辅助函数 + 30行类型守卫
- **总净减少：338行代码**

**依赖优化** ✅
- 新增：`@types/json-schema@7.0.15` (devDependency, ~3KB)
- **零运行时影响**: 类型定义编译后完全消失
- 与生态对齐：兼容 Ajv、json-schema-to-typescript 等库

## 三、核心接口

### Tool 接口

```typescript
export interface Tool<TParams = unknown> {
  // 基本信息
  readonly name: string;
  readonly displayName: string;
  readonly kind: ToolKind;
  readonly description: ToolDescription;
  readonly version: string;
  readonly category?: string;
  readonly tags: string[];

  // 方法
  getFunctionDeclaration(): FunctionDeclaration;
  getMetadata(): Record<string, unknown>;
  build(params: TParams): ToolInvocation<TParams>;
  execute(params: TParams, signal?: AbortSignal): Promise<ToolResult>;
}
```

### ToolConfig 接口

```typescript
export interface ToolConfig<TSchema = unknown, TParams = unknown> {
  name: string;
  displayName: string;
  kind: ToolKind;
  schema: TSchema;  // Zod Schema
  description: ToolDescription;
  requiresConfirmation?: boolean | ConfirmationCallback<TParams>;
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
  version?: string;
  category?: string;
  tags?: string[];
}
```

### ToolResult 接口

```typescript
export interface ToolResult {
  success: boolean;
  llmContent: string | object;    // 传递给 LLM 的内容
  displayContent: string;         // 显示给用户的内容
  error?: ToolError;
  metadata?: Record<string, unknown>;
}
```

## 四、使用示例

### 创建简单工具

```typescript
import { createTool } from '@/tools/core';
import { ToolKind } from '@/tools/types';
import { z } from 'zod';

export const helloTool = createTool({
  name: 'hello',
  displayName: 'Hello World',
  kind: ToolKind.Other,

  schema: z.object({
    name: z.string().describe('要打招呼的名字'),
  }),

  description: {
    short: '打招呼的示例工具',
    important: ['这是一个演示工具']
  },

  async execute(params, context) {
    return {
      success: true,
      llmContent: `Hello, ${params.name}!`,
      displayContent: `✅ Hello, ${params.name}!`,
    };
  }
});
```

### MCP 工具集成

```typescript
import { createMcpTool } from '@/mcp/createMcpTool';

// MCP 工具自动转换为标准 Tool
export function createMcpTool(
  mcpClient: McpClient,
  serverName: string,
  toolDef: McpToolDefinition
) {
  // 1. JSON Schema → Zod Schema 自动转换
  const zodSchema = convertJsonSchemaToZod(toolDef.inputSchema);

  // 2. 使用 createTool 创建标准工具
  return createTool({
    name: `mcp__${serverName}__${toolDef.name}`,
    displayName: `${serverName}: ${toolDef.name}`,
    kind: ToolKind.External,
    schema: zodSchema,
    description: {
      short: toolDef.description || `MCP 工具: ${toolDef.name}`,
      important: [`来自 MCP 服务器: ${serverName}`]
    },
    requiresConfirmation: true,

    async execute(params, context) {
      const result = await mcpClient.callTool(toolDef.name, params);
      return convertMcpResult(result);
    }
  });
}
```

## 五、工具注册

```typescript
import { ToolRegistry } from '@/tools/registry';
import { getBuiltinTools } from '@/tools/builtin';

// 创建注册表
const registry = new ToolRegistry();

// 注册内置工具
const builtinTools = await getBuiltinTools();
builtinTools.forEach(tool => registry.register(tool));

// 注册 MCP 工具
const mcpTools = await mcpRegistry.getAvailableTools();
mcpTools.forEach(tool => registry.registerMcpTool(tool));

// 获取所有工具
const allTools = registry.getAll();  // Tool[]

// 获取 LLM 函数声明
const declarations = registry.getFunctionDeclarations();
```

## 六、类型系统

### 类型文件说明

| 文件 | 说明 | 主要类型 |
|------|------|----------|
| `ToolTypes.ts` | 核心工具类型 | `Tool`, `ToolConfig`, `ToolDescription`, `ToolKind`, `ToolResult`, `FunctionDeclaration` |
| `ExecutionTypes.ts` | 执行上下文类型 | `ExecutionContext` |
| `SecurityTypes.ts` | 安全相关类型 | `ValidationError`, `ValidationResult`, `PermissionResult` |
| **`@types/json-schema`** | **JSON Schema 标准类型** | **`JSONSchema7`**, **`JSONSchema7Definition`** |

### 类型导入示例

```typescript
// 从统一入口导入工具类型
import type {
  Tool,
  ToolConfig,
  ToolResult,
  ExecutionContext,
} from '@/tools/types';

// JSON Schema 类型需要直接从标准包导入
import type { JSONSchema7 } from 'json-schema';
```

### JSONSchema7 类型使用

**为什么使用标准类型?**
- ✅ 社区标准，广泛兼容
- ✅ 完整的 JSON Schema Draft-07 支持
- ✅ 官方维护，自动跟进规范更新
- ✅ 零运行时开销（编译后消失）

**两种类型:**
```typescript
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';

// JSONSchema7 - 完整的 schema 对象
const schema: JSONSchema7 = {
  type: 'object',
  properties: {
    name: { type: 'string' }
  }
};

// JSONSchema7Definition - 可以是 boolean (JSON Schema 规范允许)
const def1: JSONSchema7Definition = schema;  // 对象
const def2: JSONSchema7Definition = true;    // true = 接受任何值
const def3: JSONSchema7Definition = false;   // false = 拒绝任何值
```

**类型守卫示例:**
```typescript
// 处理 properties 可能是 boolean 的情况
if (schema.properties) {
  for (const [key, value] of Object.entries(schema.properties)) {
    if (typeof value === 'object' && value !== null) {
      // 安全地使用 value as JSONSchema7
      processSchema(value as JSONSchema7);
    }
  }
}
```

## 七、最佳实践

### 1. 工具命名

- 使用小写字母和下划线：`read_file`、`multi_edit`
- MCP 工具使用前缀：`mcp__server__tool`

### 2. 描述格式

```typescript
description: {
  short: '简短描述（1行）',
  long: '详细说明（可选）',
  usageNotes: [
    '使用说明1',
    '使用说明2'
  ],
  important: [
    '重要提示1',
    '重要提示2'
  ]
}
```

### 3. 返回值格式

```typescript
return {
  success: true,
  llmContent: data,           // 给 LLM 的结构化数据
  displayContent: message,    // 给用户的友好消息
  metadata: {                 // 元数据（可选）
    timestamp: Date.now(),
    // ...
  }
};
```

### 4. 辅助函数

每个工具应包含 `formatDisplayMessage` 辅助函数：

```typescript
function formatDisplayMessage(
  path: string,
  metadata: Record<string, unknown>
): string {
  // 构建用户友好的消息
  return `✅ 操作成功: ${path}`;
}
```

## 八、下一步计划

### 短期任务
- [ ] 完善工具单元测试
- [ ] 添加工具性能监控
- [ ] 实现工具执行管道

### 中期任务
- [ ] 支持更多 MCP 服务器
- [ ] 实现工具权限系统
- [ ] 添加工具缓存机制

### 长期目标
- [ ] 构建工具市场
- [ ] 提供工具开发 SDK
- [ ] 建立工具生态系统

## 九、参考资料

- [工具使用指南](./tools/TOOL_USAGE_GUIDE.md)
- [MCP 协议文档](./protocols/mcp-support.md)
- [源码目录](../src/tools/)
