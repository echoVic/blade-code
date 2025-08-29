# @blade-ai/types

Blade AI 共享类型定义包

## 📦 包概述

`@blade-ai/types` 是 Blade AI 的共享类型定义包，包含：
- 配置类型定义
- LLM接口类型
- 工具系统类型
- 上下文管理类型
- Agent接口类型

## 🚀 使用

```bash
npm install @blade-ai/types
```

```typescript
import type { BladeConfig, LLMMessage } from '@blade-ai/types';

const config: BladeConfig = {
  apiKey: 'your-api-key',
  baseUrl: 'https://api.example.com',
  modelName: 'qwen-plus'
};
```

## 📚 导出类型

### 配置类型
- `BladeConfig` - 主配置接口
- `AgentConfig` - Agent配置接口
- `LLMConfig` - LLM配置接口

### LLM类型
- `LLMMessage` - LLM消息格式
- `LLMRequest` - LLM请求格式
- `LLMResponse` - LLM响应格式

### 工具类型
- `ToolConfig` - 工具配置接口
- `ToolResult` - 工具执行结果

### 上下文类型
- `ContextConfig` - 上下文配置接口

## 📄 许可证

MIT