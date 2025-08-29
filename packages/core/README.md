# @blade-ai/core

Blade AI 核心包 - 提供智能AI代理的核心功能

## 📦 包概述

`@blade-ai/core` 是 Blade AI 的核心功能包，包含：
- 智能Agent实现
- LLM管理器
- 工具系统
- 上下文管理
- 配置管理

## 🚀 快速开始

```bash
npm install @blade-ai/core
```

```typescript
import { Agent } from '@blade-ai/core';

const agent = new Agent({
  llm: { 
    provider: 'qwen', 
    apiKey: 'your-api-key' 
  }
});

await agent.init();
const response = await agent.chat('你好');
await agent.destroy();
```

## 📚 API 文档

### Agent 类

核心AI代理类，提供统一的AI能力接口。

#### 构造函数
```typescript
new Agent(config: AgentConfig)
```

#### 主要方法
- `chat(message: string)` - 基础聊天
- `conversation(messages: LLMMessage[])` - 多轮对话
- `chatWithSystem(systemPrompt: string, userMessage: string)` - 系统提示词聊天
- `generateCode(description: string, language?: string)` - 代码生成
- `reviewCode(code: string, language: string)` - 代码审查
- `summarize(text: string)` - 文本摘要

### 配置管理

提供统一的配置管理功能。

### 工具系统

提供25+内置工具的管理接口。

## 🏗️ 开发

### 构建
```bash
npm run build
```

### 测试
```bash
npm run test
```

## 📄 许可证

MIT