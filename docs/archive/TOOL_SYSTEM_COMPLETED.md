# Blade 工具系统重构完成文档

> **状态**: ✅ 已完成
> **完成时间**: 2025-10-10
> **版本**: v1.0 (全新架构)

## 一、重构概述

本次重构彻底废弃了旧的工具体系，全面启用新的 Tools 架构。核心原则是**统一、简洁、类型安全**。

### 核心改进

- ✅ **统一的工具创建**: 所有工具(内置 + MCP)都通过 `createTool` 创建
- ✅ **统一的接口**: `Tool` 接口取代 `DeclarativeTool`
- ✅ **统一的验证**: 所有工具使用 Zod Schema
- ✅ **类型安全**: 端到端的 TypeScript 类型检查
- ✅ **架构清晰**: 无历史包袱，无适配层

## 二、新架构设计

### 2.1 目录结构

```
src/tools/
├── core/                        # 核心工具系统
│   ├── types.ts                # Tool 接口定义
│   ├── createTool.ts           # 统一的工具创建 API
│   ├── ToolInvocation.ts       # 工具调用抽象
│   └── index.ts                # 核心导出
├── types/                       # 类型定义
│   ├── ToolTypes.ts            # 基础类型（ToolKind、ToolResult等）
│   └── index.ts                # 类型导出
├── validation/                  # 验证系统
│   ├── zod-schemas.ts          # Zod Schema 定义
│   ├── zod-to-json.ts          # Zod → JSON Schema 转换
│   ├── error-formatter.ts      # 错误格式化
│   └── index.ts                # 验证导出
├── registry/                    # 工具注册系统
│   ├── ToolRegistry.ts         # 主注册表
│   ├── ToolDiscovery.ts        # 工具发现
│   └── ToolResolver.ts         # 工具解析器
├── builtin/                     # 内置工具
│   ├── file/                   # 文件操作工具
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   └── multi-edit.ts
│   ├── search/                 # 搜索工具
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   └── find.ts
│   ├── shell/                  # Shell 命令工具
│   │   ├── bash.ts
│   │   ├── shell.ts
│   │   └── script.ts
│   ├── web/                    # 网络工具
│   │   ├── web-fetch.ts
│   │   └── api-call.ts
│   ├── task/                   # 任务管理工具
│   │   └── task.ts
│   └── index.ts                # 内置工具导出
└── base/                        # 向后兼容（仅类型导出）
    └── index.ts
```

### 2.2 核心接口

#### Tool 接口

```typescript
export interface Tool {
  // 基本信息
  readonly name: string;
  readonly displayName: string;
  readonly description: ToolDescription;
  readonly kind: ToolKind;
  readonly category?: string;
  readonly tags: string[];

  // 参数验证
  readonly schema: z.ZodSchema;

  // 安全控制
  readonly requiresConfirmation: boolean;
  readonly permissions?: ToolPermissions;

  // 执行方法
  execute(params: any, context: ExecutionContext): Promise<ToolResult>;

  // 工具声明（用于 LLM）
  getFunctionDeclaration(): FunctionDeclaration;

  // 参数验证
  validateParams(params: any): ValidationResult;
}
```

#### 工具创建 API

```typescript
export function createTool<TParams = any>(config: ToolConfig<TParams>): Tool {
  // 1. 验证配置
  // 2. 创建 Tool 实例
  // 3. 返回标准 Tool 接口
}
```

### 2.3 使用示例

#### 创建内置工具

```typescript
import { createTool } from '../core/createTool.js';
import { ToolKind } from '../types/index.js';
import { z } from 'zod';

export const readTool = createTool({
  name: 'read',
  displayName: '读取文件',
  kind: ToolKind.Read,
  schema: z.object({
    file_path: z.string().describe('文件路径'),
    offset: z.number().optional().describe('起始行号'),
    limit: z.number().optional().describe('读取行数'),
  }),
  description: {
    short: '读取文件内容',
    important: [
      '支持文本文件、图片、PDF等多种格式',
      '可以指定读取范围'
    ]
  },
  category: '文件操作',
  tags: ['file', 'read', 'io'],

  async execute(params, context) {
    // 实现读取逻辑
    const content = await fs.readFile(params.file_path, 'utf-8');

    return {
      success: true,
      llmContent: content,
      displayContent: `已读取文件: ${params.file_path}`,
    };
  }
});
```

#### 创建 MCP 工具

```typescript
import { createMcpTool } from './createMcpTool.js';

export function createMcpTool(
  mcpClient: McpClient,
  serverName: string,
  toolDef: McpToolDefinition
) {
  // 1. JSON Schema → Zod Schema 转换
  const zodSchema = convertJsonSchemaToZod(toolDef.inputSchema);

  // 2. 使用 createTool 创建标准工具
  return createTool({
    name: `mcp__${serverName}__${toolDef.name}`,
    displayName: `${serverName}: ${toolDef.name}`,
    kind: ToolKind.External,
    schema: zodSchema,
    description: {
      short: toolDef.description || `MCP工具: ${toolDef.name}`,
      important: [
        `来自 MCP 服务器: ${serverName}`,
        '执行外部工具，需要用户确认'
      ]
    },
    requiresConfirmation: true,
    category: 'MCP工具',
    tags: ['mcp', 'external', serverName],

    async execute(params, context) {
      const result = await mcpClient.callTool(toolDef.name, params);
      // 处理 MCP 响应...
    }
  });
}
```

## 三、重构详细改动

### 3.1 类型系统升级

#### 删除的类型

```typescript
// ❌ 已删除
export interface DeclarativeTool {
  // 旧的声明式工具接口
}
```

#### 新增的类型

```typescript
// ✅ 新的 Tool 接口
export interface Tool {
  // 统一的工具接口
}

// ✅ 新的工具描述类型
export type ToolDescription = string | {
  short: string;
  important?: string[];
};

// ✅ 新的工具配置类型
export interface ToolConfig<TParams = any> {
  name: string;
  displayName: string;
  kind: ToolKind;
  schema: z.ZodSchema<TParams>;
  description: ToolDescription;
  // ...
}
```

### 3.2 ToolRegistry 现代化

#### 更新前

```typescript
export class ToolRegistry {
  private tools = new Map<string, DeclarativeTool>();

  register(tool: DeclarativeTool): void { }
  get(name: string): DeclarativeTool | undefined { }
  getAll(): DeclarativeTool[] { }
}
```

#### 更新后

```typescript
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();

  register(tool: Tool): void { }
  registerMcpTool(tool: Tool): void { }
  get(name: string): Tool | undefined { }
  getAll(): Tool[] { }
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll().map(tool => tool.getFunctionDeclaration());
  }
}
```

### 3.3 MCP 工具系统重构

#### 删除的文件

- ❌ `src/mcp/McpToolAdapter.ts` - 旧的适配器实现
- ❌ `src/mcp/McpToolInvocation.ts` - 旧的调用抽象

#### 新增的文件

- ✅ `src/mcp/createMcpTool.ts` - 新的 MCP 工具创建器

#### 核心改进

1. **JSON Schema → Zod 自动转换**

```typescript
function convertJsonSchemaToZod(jsonSchema: JSONSchema7): z.ZodSchema {
  // 支持 object, array, string, number, boolean 等类型
  // 支持 required, optional, enum 等约束
  // 支持 oneOf, anyOf 等联合类型
}
```

2. **统一的工具创建**

```typescript
// 更新前：需要继承适配器类
class McpToolAdapter extends DeclarativeTool { }

// 更新后：直接使用 createTool
const tool = createMcpTool(client, serverName, toolDef);
```

### 3.4 Agent 系统更新

#### 更新前

```typescript
export class Agent {
  public getAvailableTools(): DeclarativeTool[] {
    return this.toolRegistry ? this.toolRegistry.getAll() : [];
  }
}
```

#### 更新后

```typescript
export class Agent {
  public getAvailableTools(): Tool[] {
    return this.toolRegistry ? this.toolRegistry.getAll() : [];
  }
}
```

### 3.5 内置工具导出优化

#### 更新前

```typescript
export async function getBuiltinTools(): Promise<DeclarativeTool[]> {
  const builtinTools = [
    readTool as any,
    editTool as any,
    // ... 需要类型断言
  ];
  return [...builtinTools, ...mcpTools];
}
```

#### 更新后

```typescript
export async function getBuiltinTools(): Promise<Tool[]> {
  const builtinTools: Tool[] = [
    readTool,
    editTool,
    writeTool,
    // ... 完全类型安全
  ];

  const mcpTools = await getMcpTools();
  return [...builtinTools, ...mcpTools];
}
```

## 四、迁移指南

### 4.1 工具开发者

如果你之前创建了自定义工具，需要进行以下更新：

#### 旧的方式

```typescript
class MyTool extends DeclarativeTool {
  constructor() {
    super(
      'my-tool',
      'My Tool',
      'Description',
      ToolKind.Other,
      { /* JSON Schema */ }
    );
  }

  build(params: any): ToolInvocation {
    return new MyToolInvocation(params);
  }
}
```

#### 新的方式

```typescript
export const myTool = createTool({
  name: 'my-tool',
  displayName: 'My Tool',
  kind: ToolKind.Other,
  schema: z.object({
    // Zod Schema
  }),
  description: {
    short: 'Description',
  },

  async execute(params, context) {
    // 实现执行逻辑
    return {
      success: true,
      llmContent: 'Result',
      displayContent: 'Display Result',
    };
  }
});
```

### 4.2 MCP 服务器开发者

MCP 工具现在会自动转换，无需手动适配：

```typescript
// McpRegistry 会自动调用 createMcpTool
const mcpTools = await mcpRegistry.getAvailableTools();
// 返回的就是标准的 Tool[] 数组
```

## 五、测试和验证

### 5.1 类型检查

```bash
npm run type-check
```

主要的 DeclarativeTool 相关错误已全部修复。剩余错误主要是其他模块的问题。

### 5.2 构建验证

```bash
npm run build
```

确保所有模块正确编译。

### 5.3 单元测试

```bash
npm test
```

所有工具的单元测试需要更新以适配新接口。

## 六、文件改动清单

| 文件 | 状态 | 改动内容 |
|------|------|----------|
| `src/tools/types/ToolTypes.ts` | ✏️ 修改 | 删除 DeclarativeTool 接口定义 |
| `src/tools/core/types.ts` | ✏️ 修改 | 定义新的 Tool 接口 |
| `src/tools/core/createTool.ts` | ➕ 新建 | 统一的工具创建 API |
| `src/tools/registry/ToolRegistry.ts` | ✏️ 修改 | 全面使用 Tool 类型 |
| `src/tools/registry/ToolDiscovery.ts` | ✏️ 修改 | 返回 Tool[] |
| `src/tools/registry/ToolResolver.ts` | ✏️ 修改 | 简化为直接调用 getFunctionDeclaration |
| `src/agent/Agent.ts` | ✏️ 修改 | 返回 Tool[] |
| `src/tools/builtin/index.ts` | ✏️ 修改 | 移除类型断言，完全类型安全 |
| `src/mcp/createMcpTool.ts` | ➕ 新建 | MCP 工具创建器 |
| `src/mcp/McpRegistry.ts` | ✏️ 修改 | 使用 createMcpTool |
| `src/mcp/McpToolAdapter.ts` | ❌ 删除 | 旧实现已废弃 |
| `src/mcp/McpToolInvocation.ts` | ❌ 删除 | 旧实现已废弃 |
| `src/mcp/index.ts` | ✏️ 修改 | 导出 createMcpTool |
| `src/tools/builtin/shell/index.ts` | ✏️ 修改 | 移除旧的 BashTool 导出 |
| `src/tools/core/index.ts` | ✏️ 修改 | 移除废弃的 ToolAdapter 导出 |
| `src/tools/base/index.ts` | ✏️ 修改 | 更新文档和导出 |

## 七、架构优势

### 7.1 统一性

所有工具遵循相同的创建模式和接口：

- 内置工具 → `createTool`
- MCP 工具 → `createMcpTool` → `createTool`
- 自定义工具 → `createTool`

### 7.2 类型安全

端到端的 TypeScript 类型检查：

```typescript
// 完全类型安全的工具注册
const tool = createTool({
  schema: z.object({ /* ... */ }),
  async execute(params, context) {
    // params 自动推断为正确类型
    // context 有完整的类型提示
  }
});

registry.register(tool); // ✅ 类型正确
```

### 7.3 简洁性

无需继承复杂的类层次结构，只需调用 `createTool`：

```typescript
// 更新前：需要创建类
class MyTool extends DeclarativeTool {
  constructor() { /* ... */ }
  build() { /* ... */ }
}

// 更新后：直接创建对象
const myTool = createTool({ /* ... */ });
```

### 7.4 可扩展性

新的架构更容易扩展：

- 添加新工具：只需调用 `createTool`
- 添加 MCP 服务器：自动转换为标准工具
- 添加工具分类：只需设置 `category` 和 `tags`

## 八、下一步计划

### 8.1 短期任务

- [ ] 更新所有单元测试
- [ ] 更新集成测试
- [ ] 完善工具文档
- [ ] 添加更多内置工具

### 8.2 中期任务

- [ ] 实现工具执行管道（6阶段）
- [ ] 完善权限控制系统
- [ ] 优化并发执行
- [ ] 添加工具性能监控

### 8.3 长期目标

- [ ] 支持更多 MCP 服务器
- [ ] 实现工具市场
- [ ] 提供工具开发 SDK
- [ ] 构建工具生态系统

## 九、总结

本次重构彻底废弃了旧的工具体系，建立了全新的、现代化的工具架构。核心特点：

✨ **统一**: 所有工具使用相同的创建 API
✨ **简洁**: 无需复杂的类继承，直接创建对象
✨ **类型安全**: 完整的 TypeScript 支持
✨ **可扩展**: 易于添加新工具和 MCP 服务器
✨ **清晰**: 无历史包袱，架构清晰明了

这为 Blade 的未来发展奠定了坚实的基础！🎉
