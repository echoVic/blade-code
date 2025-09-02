# Qwen 模型 Function Call 兼容指南

本文档详细介绍如何在项目中使用 Qwen 模型的 function call 功能，包括现代 tools 格式和传统 functions 格式的兼容性。

## 概述

Qwen 模型支持多种 function call 格式：

1. **现代 Tools 格式** - OpenAI 标准的 tools 接口（推荐）
2. **传统 Functions 格式** - 旧版 OpenAI functions 接口（向后兼容）
3. **智能格式选择** - 自动选择最佳兼容格式

## 主要特性

### 🔄 多格式兼容
- ✅ 支持 OpenAI Tools 格式 (`tools` 参数)
- ✅ 支持 OpenAI Functions 格式 (`functions` 参数)
- ✅ 自动格式检测和转换
- ✅ 向后兼容性保证

### 🛠️ 智能工具调用
- 🤖 智能格式选择，优先使用 tools 格式
- 🔧 自动工具执行和结果处理
- 📝 完整的调用工作流支持
- 🎯 为 Qwen 模型优化的描述

### 🔧 工具格式转换
- 📄 内置格式转换器
- 🔀 支持多种格式互转
- ✨ Qwen 模型专用优化
- 📋 自动生成调用示例

## 快速开始

### 1. 基础设置

```typescript
import { QwenLLM } from '../src/llm/QwenLLM.js';
import { createToolManager, ToolFormatConverter } from '../src/tools/index.js';

// 初始化 Qwen LLM
const qwenLLM = new QwenLLM({
  apiKey: 'your-qwen-api-key',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', // 可选
});

await qwenLLM.init();

// 创建工具管理器
const toolManager = await createToolManager();
```

### 2. 使用现代 Tools 格式

```typescript
// 获取可用工具
const availableTools = toolManager.getAllTools();

// 转换为 OpenAI Tools 格式
const tools = ToolFormatConverter.toOpenAITools(availableTools);

// 准备消息
const messages = [
  {
    role: 'user',
    content: '请查看当前时间并生成一个UUID',
  },
];

// 调用 LLM
const response = await qwenLLM.toolsCall(messages, tools);

// 解析结果
const result = qwenLLM.parseToolCallResult(response);

if (result.hasToolCalls) {
  console.log('LLM 想要调用的工具:', result.toolCalls);
  // 执行实际的工具调用...
}
```

### 3. 使用传统 Functions 格式

```typescript
// 转换为 OpenAI Functions 格式
const functions = ToolFormatConverter.toOpenAIFunctions(availableTools);

const messages = [
  {
    role: 'user',
    content: '帮我处理这个文本',
  },
];

// 使用传统 functions 格式
const response = await qwenLLM.functionCall(messages, functions);
const result = qwenLLM.parseToolCallResult(response);
```

### 4. 智能格式选择（推荐）

```typescript
// 自动选择最佳格式
const response = await qwenLLM.smartFunctionCall(messages, availableTools);
const result = qwenLLM.parseToolCallResult(response);

// 智能选择会：
// 1. 优先尝试 tools 格式
// 2. 如果失败，自动回退到 functions 格式
// 3. 输出警告信息以便调试
```

### 5. 完整工具调用工作流

```typescript
// 工具执行器
const toolExecutor = async (toolName: string, args: any) => {
  const response = await toolManager.callTool({
    toolName,
    parameters: args,
  });
  return response.result.data;
};

// 执行完整工作流
const workflowResult = await qwenLLM.executeToolWorkflow(
  messages,
  availableTools,
  toolExecutor
);

console.log('最终回复:', workflowResult.finalResponse);
console.log('工具执行记录:', workflowResult.toolExecutions);
```

## API 参考

### QwenLLM 新增方法

#### `toolsCall(messages, tools, options?)`
使用现代 OpenAI Tools 格式调用 LLM。

**参数:**
- `messages`: 对话消息数组
- `tools`: OpenAI Tools 格式的工具数组
- `options`: 可选的 LLM 请求参数

**返回:** OpenAI API 响应对象

#### `smartFunctionCall(messages, toolsOrFunctions, options?)`
智能选择最佳的 function call 格式。

**参数:**
- `messages`: 对话消息数组
- `toolsOrFunctions`: 任意格式的工具数组
- `options`: 可选的 LLM 请求参数

**返回:** OpenAI API 响应对象

#### `parseToolCallResult(completion)`
解析 LLM 响应中的工具调用信息。

**参数:**
- `completion`: OpenAI API 响应对象

**返回:**
```typescript
{
  hasToolCalls: boolean;
  toolCalls: Array<{
    id?: string;
    type?: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  content?: string;
}
```

#### `executeToolWorkflow(messages, availableTools, toolExecutor, options?)`
执行完整的工具调用工作流。

**参数:**
- `messages`: 对话消息数组
- `availableTools`: 可用工具数组
- `toolExecutor`: 工具执行函数
- `options`: 可选的 LLM 请求参数

**返回:**
```typescript
{
  finalResponse: string;
  toolExecutions: Array<{
    toolName: string;
    arguments: any;
    result: any;
    success: boolean;
    error?: string;
  }>;
}
```

### ToolFormatConverter 工具

#### 格式转换方法

```typescript
// 转换为 OpenAI Tools 格式
ToolFormatConverter.toOpenAITools(toolDefinitions)

// 转换为 OpenAI Functions 格式
ToolFormatConverter.toOpenAIFunctions(toolDefinitions)

// 自动检测并转换格式
ToolFormatConverter.autoConvertToTools(input)
ToolFormatConverter.autoConvertToFunctions(input)

// 格式验证
ToolFormatConverter.validateToolsFormat(tools)
ToolFormatConverter.validateFunctionsFormat(functions)
```

#### Qwen 优化方法

```typescript
// 为 Qwen 模型优化工具描述
const optimizedTools = ToolFormatConverter.optimizeForQwen(tools);

// 生成工具调用示例
const example = ToolFormatConverter.generateExample(tool);
```

## 使用建议

### 1. 格式选择建议

- **推荐使用 `smartFunctionCall`**：自动选择最佳格式，确保兼容性
- **新项目使用 `toolsCall`**：使用现代标准，更好的扩展性
- **兼容旧代码使用 `functionCall`**：保持向后兼容

### 2. 错误处理

```typescript
try {
  const response = await qwenLLM.smartFunctionCall(messages, tools);
  // 处理成功响应
} catch (error) {
  if (error.message.includes('tools')) {
    console.warn('Tools 格式不支持，尝试 Functions 格式');
    // 手动回退逻辑
  } else {
    console.error('其他错误:', error);
  }
}
```

### 3. 性能优化

- 使用工具缓存减少重复转换
- 预先验证工具格式避免运行时错误
- 合理限制同时调用的工具数量

```typescript
// 缓存转换结果
const toolsCache = new Map();
const getCachedTools = (toolDefs: any[]) => {
  const key = JSON.stringify(toolDefs.map(t => t.name));
  if (!toolsCache.has(key)) {
    toolsCache.set(key, ToolFormatConverter.toOpenAITools(toolDefs));
  }
  return toolsCache.get(key);
};
```

### 4. 调试技巧

```typescript
// 启用详细日志
console.log('使用的工具格式:', tools);
console.log('LLM 响应:', response);

// 验证工具格式
if (!ToolFormatConverter.validateToolsFormat(tools)) {
  console.warn('工具格式可能有问题');
}

// 生成调用示例用于测试
tools.forEach(tool => {
  console.log(`${tool.function.name} 示例:`, 
    ToolFormatConverter.generateExample(tool));
});
```

## 常见问题

### Q: 为什么需要两种格式？

A: OpenAI 从 functions 格式升级到 tools 格式，tools 格式更标准化且支持更多功能。为了向后兼容，我们同时支持两种格式。

### Q: 如何知道 Qwen 支持哪种格式？

A: 使用 `smartFunctionCall` 方法，它会自动检测并选择最佳格式。如果 tools 格式失败，会自动回退到 functions 格式。

### Q: 工具调用失败怎么办？

A: 检查以下几点：
1. API 密钥是否正确
2. 工具参数格式是否符合规范
3. 网络连接是否正常
4. 查看错误日志定位具体问题

### Q: 如何优化工具调用的准确性？

A: 
1. 使用清晰的工具描述，特别是中文描述
2. 提供详细的参数说明和示例
3. 使用 `ToolFormatConverter.optimizeForQwen()` 优化描述
4. 限制单次提供的工具数量（建议不超过10个）

## 示例项目

完整的示例代码请参考：`examples/qwen-function-call-example.ts`

运行示例：
```bash
# 设置环境变量
export QWEN_API_KEY="your-api-key"

# 运行示例
npm run dev examples/qwen-function-call-example.ts
```

## 版本兼容性

- **Qwen3 系列模型**：完全支持 tools 和 functions 格式
- **Qwen2 系列模型**：主要支持 functions 格式
- **Qwen1 系列模型**：基础支持 functions 格式

建议使用最新的 Qwen3 系列模型以获得最佳体验。 