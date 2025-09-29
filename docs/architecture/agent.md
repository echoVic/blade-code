# Agent 架构设计指南

## 🌟 概述

本项目采用全新的 Agent 架构设计，**Agent 类作为入口点，内置 LLM 功能**，而不是将 LLM 作为外部组件。这种设计更符合"智能代理"的概念，LLM 是 Agent 的核心能力，而不是可插拔的组件。

## 🏗️ 核心架构

### 设计理念

```
传统架构（旧）：
外部创建 LLM → 注册到 Agent → Agent 管理生命周期

新架构（新）：
Agent(配置) → 内部初始化 LLM → 直接使用 LLM 能力
```

### 架构图

```
┌─────────────────────────────────┐
│          Agent (入口)           │
├─────────────────────────────────┤
│  ✅ 内置 LLM 功能              │
│    ├─ QwenLLM                  │
│    └─ VolcEngineLLM            │
│                                 │
│  📦 组件管理                   │
│    ├─ LoggerComponent          │
│    ├─ CustomComponent          │
│    └─ ...                      │
└─────────────────────────────────┘
```

## 🚀 核心特性

### 1. Agent 作为智能代理入口

```typescript
// ✅ 新架构：Agent 内置 LLM
const agent = new Agent({
  debug: true,
  llm: {
    provider: 'qwen',
    apiKey: 'your-api-key',
    model: 'qwen3-235b-a22b'
  }
});

await agent.init();

// 直接使用 AI 能力
const response = await agent.chat('你好');
const code = await agent.generateCode('快速排序算法', 'python');
const summary = await agent.summarize(longText);
```

### 2. 继承扩展专用 Agent

```typescript
// 智能客服 Agent
class CustomerServiceAgent extends Agent {
  constructor(config: AgentConfig) {
    super({ ...config, debug: true });
    this.registerComponent(new LoggerComponent('customer-service'));
  }

  async handleInquiry(inquiry: string): Promise<string> {
    const systemPrompt = `你是专业的客服代表...`;
    return await this.chatWithSystem(systemPrompt, inquiry);
  }

  // 其他客服专用方法...
}
```

### 3. 统一的生命周期管理

```typescript
const agent = new Agent(config);

// 自动管理 LLM + 组件生命周期
await agent.init();     // 初始化 LLM 和所有组件
// ... 使用 agent
await agent.destroy();  // 销毁 LLM 和所有组件
```

## 💡 使用示例

### 基础用法

```typescript
import { Agent } from 'agent-cli';

// 1. 创建配置
const config = {
  debug: true,
  llm: {
    provider: 'qwen',
    apiKey: process.env.QWEN_API_KEY,
    model: 'qwen3-235b-a22b'
  }
};

// 2. 创建并初始化 Agent
const agent = new Agent(config);
await agent.init();

// 3. 使用 AI 能力
const answer = await agent.ask('什么是人工智能？');
console.log(answer);

// 4. 流式对话
await agent.streamChat([
  { role: 'user', content: '讲个故事' }
], chunk => process.stdout.write(chunk));

// 5. 销毁资源
await agent.destroy();
```

### 专业场景应用

#### 智能客服

```typescript
class CustomerServiceAgent extends Agent {
  async handleInquiry(inquiry: string): Promise<string> {
    return await this.chatWithSystem(
      '你是专业的客服代表，友好耐心地解答问题',
      inquiry
    );
  }

  async analyzeSentiment(text: string): Promise<string> {
    return await this.chat(`分析情绪：${text}`);
  }
}

// 使用
const customerService = new CustomerServiceAgent(config);
await customerService.init();

const response = await customerService.handleInquiry('我想退货');
const sentiment = await customerService.analyzeSentiment('产品太差了！');
```

#### 代码助手

```typescript
class CodeAssistantAgent extends Agent {
  async reviewCode(code: string, language: string): Promise<string> {
    const prompt = `审查以下 ${language} 代码：\n${code}`;
    return await this.chat(prompt);
  }

  async generateTests(code: string): Promise<string> {
    return await this.chat(`为以下代码生成测试用例：\n${code}`);
  }
}

// 使用
const codeAssistant = new CodeAssistantAgent(config);
await codeAssistant.init();

const review = await codeAssistant.reviewCode(jsCode, 'javascript');
const tests = await codeAssistant.generateTests(jsCode);
```

## 🎯 内置 LLM 功能

### 核心方法

| 方法 | 说明 | 示例 |
|------|------|------|
| `chat(message)` | 基础聊天 | `await agent.chat('你好')` |
| `conversation(messages)` | 多轮对话 | `await agent.conversation([...])` |
| `streamChat(messages, onChunk)` | 流式对话 | `await agent.streamChat([...], chunk => {})` |
| `chatWithSystem(system, user)` | 系统提示词对话 | `await agent.chatWithSystem('你是...', '问题')` |
| `ask(question)` | 智能问答 | `await agent.ask('什么是AI？')` |

### 高级功能

| 方法 | 说明 | 示例 |
|------|------|------|
| `generateCode(desc, lang)` | 代码生成 | `await agent.generateCode('排序算法', 'python')` |
| `reviewCode(code, lang)` | 代码审查 | `await agent.reviewCode(code, 'js')` |
| `summarize(text)` | 文本摘要 | `await agent.summarize(longText)` |
| `analyzeSentiment(text)` | 情绪分析 | `await agent.analyzeSentiment('很生气')` |

### 状态查询

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `hasLLM()` | 检查 LLM 是否可用 | `boolean` |
| `getLLMProvider()` | 获取提供商 | `'qwen' \| 'volcengine' \| null` |
| `getStatus()` | 获取完整状态 | `AgentStatus` |

## 🔧 配置管理

### AgentConfig 接口

```typescript
interface AgentConfig {
  debug?: boolean;           // 调试模式
  llm?: {
    provider: 'qwen' | 'volcengine';  // LLM 提供商
    apiKey?: string;                  // API 密钥
    model?: string;                   // 模型名称
    baseURL?: string;                 // 自定义 API 端点
  };
}
```

### 配置优先级

1. **直接传入** - 构造函数中的配置
2. **环境变量** - `QWEN_API_KEY`, `VOLCENGINE_API_KEY`
3. **默认配置** - 预设的测试密钥和模型

### 支持的模型

#### 千问 (Qwen)
- `qwen3-235b-a22b` ⭐ (默认)
- `qwen-plus-latest`
- `qwen-turbo-latest`
- 其他 Qwen3 系列...

#### 豆包 (VolcEngine)
- `ep-20250417144747-rgffm` ⭐ (默认)
- 其他自定义端点...

## 🛠️ 组件系统

### 组件注册

```typescript
const agent = new Agent(config);

// 注册自定义组件
agent.registerComponent(new LoggerComponent('my-logger'));
agent.registerComponent(new CustomComponent('my-component'));

// 获取组件
const logger = agent.getComponent<LoggerComponent>('my-logger');

// 移除组件
await agent.removeComponent('my-component');
```

### 自定义组件

```typescript
import { BaseComponent } from 'agent-cli';

class DatabaseComponent extends BaseComponent {
  constructor() {
    super('database');
  }

  async init(): Promise<void> {
    // 初始化数据库连接
    console.log('数据库连接已建立');
  }

  async destroy(): Promise<void> {
    // 关闭数据库连接
    console.log('数据库连接已关闭');
  }

  async query(sql: string): Promise<any[]> {
    // 执行查询
    return [];
  }
}
```

## 🎭 CLI 演示

### 使用命令行

```bash
# 基础助手演示
bin/agent.js agent-llm --scenario assistant

# 智能客服演示
bin/agent.js agent-llm --scenario customer

# 代码助手演示
bin/agent.js agent-llm --scenario code

# 指定提供商和模型
bin/agent.js agent-llm --provider volcengine --model custom-model
```

### 演示场景

1. **assistant** - 基础助手功能演示
   - 智能问答
   - 代码生成
   - 文本摘要
   - 流式输出

2. **customer** - 智能客服演示
   - 客户咨询处理
   - 情绪分析
   - 专业回复

3. **code** - 代码助手演示
   - 代码审查
   - 测试生成
   - 质量分析

## 📈 架构优势

### ✅ 优点

1. **简洁直观** - Agent 作为唯一入口，概念清晰
2. **内置 AI** - LLM 是 Agent 的核心能力，不是外部依赖
3. **易于扩展** - 继承 Agent 类即可创建专用代理
4. **统一管理** - 生命周期、配置、错误处理统一管理
5. **类型安全** - 完整的 TypeScript 类型支持

### 🔄 与传统架构对比

| 特性 | 传统架构 | 新架构 |
|------|----------|--------|
| **概念复杂度** | 高（需理解组件注册） | 低（Agent 即入口） |
| **使用便利性** | 中（需手动管理 LLM） | 高（内置 AI 功能） |
| **扩展性** | 好（组件化） | 更好（继承 + 组件） |
| **维护性** | 中（分散管理） | 高（统一管理） |

## 🚀 最佳实践

### 1. 配置管理

```typescript
// ✅ 推荐：使用环境变量
const agent = new Agent({
  llm: {
    provider: 'qwen',
    apiKey: process.env.QWEN_API_KEY,  // 从环境变量读取
    model: process.env.QWEN_MODEL || 'qwen3-235b-a22b'
  }
});
```

### 2. 错误处理

```typescript
class RobustAgent extends Agent {
  async safeChat(message: string): Promise<string> {
    try {
      return await this.chat(message);
    } catch (error) {
      console.error('聊天失败:', error);
      return '抱歉，当前无法回答您的问题。';
    }
  }
}
```

### 3. 资源管理

```typescript
async function useAgent() {
  const agent = new Agent(config);
  
  try {
    await agent.init();
    const result = await agent.ask('问题');
    return result;
  } finally {
    await agent.destroy();  // 确保资源释放
  }
}
```

### 4. 专用 Agent 设计

```typescript
// 单一职责：每个 Agent 专注特定领域
class TranslationAgent extends Agent {
  async translate(text: string, targetLang: string): Promise<string> {
    return await this.chatWithSystem(
      `你是专业翻译，将文本翻译成${targetLang}`,
      text
    );
  }
}

class SummaryAgent extends Agent {
  async summarizeArticle(article: string): Promise<string> {
    return await this.chatWithSystem(
      '你是专业编辑，总结文章要点',
      article
    );
  }
}
```

## 📚 示例项目

完整的示例代码可在以下位置找到：

- **基础使用**: `examples/agent-llm-integration.ts`
- **CLI 演示**: `src/commands/agent-llm.ts`
- **架构文档**: `docs/AGENT_LLM_INTEGRATION.md`

通过这种新架构，Agent 真正成为了"智能代理"，内置 AI 能力，简化了使用复杂度，提升了开发体验。🎉 