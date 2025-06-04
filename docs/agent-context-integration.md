# Agent 上下文管理集成指南

本文档介绍如何在 blade-ai 中使用集成了上下文管理功能的 AI Agent。

## 概述

blade-ai Agent 现在支持完整的上下文管理功能，包括：

- **对话记忆**: 自动记录和管理多轮对话历史
- **工具调用追踪**: 记录所有工具调用的历史和结果
- **会话持久化**: 跨会话保存和恢复对话状态
- **智能压缩**: 自动压缩长对话以节省 token 使用
- **上下文搜索**: 在历史会话中搜索相关内容

## 快速开始

### 基本配置

```typescript
import { Agent } from 'blade-ai';

const agent = new Agent({
  debug: true,
  llm: {
    provider: 'qwen',
    apiKey: process.env.QWEN_API_KEY,
    model: 'qwen-turbo'
  },
  tools: {
    enabled: true,
    includeBuiltinTools: true
  },
  context: {
    enabled: true,              // 启用上下文管理
    debug: true,               // 启用调试日志
    storage: {
      maxMemorySize: 1000,     // 内存中最大消息数
      persistentPath: './my-context', // 持久化存储路径
      cacheSize: 100,          // 缓存大小
      compressionEnabled: true  // 启用压缩
    },
    defaultFilter: {
      maxTokens: 4000,         // 最大 token 数
      maxMessages: 50,         // 最大消息数
      timeWindow: 24 * 60 * 60 * 1000, // 24小时时间窗口
      includeTools: true,      // 包含工具调用历史
      includeWorkspace: true   // 包含工作空间信息
    },
    compressionThreshold: 6000 // 压缩阈值
  }
});

await agent.init();
```

### 创建会话

```typescript
// 创建新会话
const sessionId = await agent.createContextSession('user123', {
  language: 'zh-CN',
  expertise: 'JavaScript开发',
  project: 'React应用'
});

console.log(`会话创建成功: ${sessionId}`);
```

### 带上下文的对话

```typescript
// 第一轮对话
const response1 = await agent.chatWithContext(
  '我正在开发一个React应用，需要实现状态管理。',
  '你是一个专业的前端开发专家。'
);

console.log('助手:', response1);

// 第二轮对话（会自动包含之前的上下文）
const response2 = await agent.chatWithContext(
  '你觉得我应该使用Redux还是Zustand？'
);

console.log('助手:', response2);

// 第三轮对话（助手会记得之前讨论的React应用和状态管理话题）
const response3 = await agent.chatWithContext(
  '如果用户数据比较复杂，你推荐哪种方案？'
);

console.log('助手:', response3);
```

### 智能工具调用（带上下文）

```typescript
// 智能工具调用会自动记录到上下文中
const response = await agent.smartChatWithContext(
  '帮我分析一下当前项目的文件结构，看看是否需要重构。'
);

console.log('回答:', response.content);

if (response.toolCalls) {
  console.log('使用的工具:');
  response.toolCalls.forEach(tool => {
    console.log(`- ${tool.toolName}: ${tool.success ? '成功' : '失败'}`);
  });
}
```

## 高级功能

### 会话管理

```typescript
// 搜索历史会话
const sessions = await agent.searchContextSessions('React状态管理', 5);
console.log(`找到 ${sessions.length} 个相关会话`);

sessions.forEach(session => {
  console.log(`${session.sessionId}: ${session.summary}`);
});

// 加载历史会话
const loadSuccess = await agent.loadContextSession('session_12345');
if (loadSuccess) {
  console.log('会话加载成功，可以继续之前的对话');
}

// 获取当前会话ID
const currentSession = agent.getCurrentSessionId();
console.log(`当前会话: ${currentSession}`);
```

### 上下文统计

```typescript
const stats = await agent.getContextStats();
if (stats) {
  console.log('上下文统计:');
  console.log(`- 当前会话: ${stats.currentSession}`);
  console.log(`- 内存消息数: ${stats.memory.messageCount}`);
  console.log(`- 缓存大小: ${stats.cache.size}`);
  console.log(`- 总会话数: ${stats.storage.totalSessions}`);
}
```

### 自定义过滤器

```typescript
// 使用自定义过滤器控制上下文
const response = await agent.chatWithContext(
  '帮我总结一下最近的讨论内容。',
  undefined, // 不使用系统提示词
  {
    maxTokens: 2000,      // 限制最大 token 数
    maxMessages: 10,      // 只包含最近10条消息
    timeWindow: 6 * 60 * 60 * 1000, // 只要最近6小时的内容
    includeTools: false,  // 不包含工具调用历史
    includeWorkspace: true // 包含工作空间信息
  }
);
```

## 最佳实践

### 1. 会话生命周期管理

```typescript
class ChatBot {
  private agent: Agent;
  private currentSessionId?: string;

  async startNewConversation(userId: string) {
    // 为新用户创建会话
    this.currentSessionId = await this.agent.createContextSession(userId, {
      startTime: Date.now(),
      userType: 'developer'
    });
  }

  async continueConversation(message: string) {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }
    
    return await this.agent.chatWithContext(message);
  }

  async endConversation() {
    // Agent会自动保存上下文，无需手动操作
    this.currentSessionId = undefined;
  }
}
```

### 2. 错误处理和降级

```typescript
async function robustChat(agent: Agent, message: string) {
  try {
    // 尝试使用带上下文的智能聊天
    return await agent.smartChatWithContext(message);
  } catch (error) {
    console.warn('上下文聊天失败，降级到普通聊天:', error);
    
    // 降级到普通智能聊天
    try {
      return await agent.smartChat(message);
    } catch (fallbackError) {
      console.warn('智能聊天失败，降级到基础聊天:', fallbackError);
      
      // 最后降级到基础聊天
      const content = await agent.chat(message);
      return { content, toolCalls: [], reasoning: '使用基础聊天模式' };
    }
  }
}
```

### 3. 性能优化

```typescript
// 针对不同场景使用不同的过滤策略
const lightweightFilter = {
  maxTokens: 1000,
  maxMessages: 5,
  includeTools: false,
  includeWorkspace: false
};

const comprehensiveFilter = {
  maxTokens: 8000,
  maxMessages: 100,
  includeTools: true,
  includeWorkspace: true
};

// 快速响应场景
const quickResponse = await agent.chatWithContext(
  '简单问题',
  undefined,
  lightweightFilter
);

// 复杂分析场景
const detailedResponse = await agent.chatWithContext(
  '复杂的技术问题，需要详细分析',
  undefined,
  comprehensiveFilter
);
```

### 4. 监控和调试

```typescript
// 定期监控上下文状态
setInterval(async () => {
  const stats = await agent.getContextStats();
  
  if (stats && stats.memory.messageCount > 800) {
    console.warn('内存使用接近上限，考虑压缩上下文');
  }
  
  if (stats && stats.cache.size > 80) {
    console.info('缓存使用较高，性能良好');
  }
}, 60000); // 每分钟检查一次
```

## 配置选项详解

### 存储配置

```typescript
{
  storage: {
    maxMemorySize: 1000,        // 内存中最大消息数
    persistentPath: './context', // 持久化存储路径
    cacheSize: 100,             // LRU缓存大小
    compressionEnabled: true    // 是否启用自动压缩
  }
}
```

### 过滤器配置

```typescript
{
  defaultFilter: {
    maxTokens: 4000,           // 最大 token 数限制
    maxMessages: 50,           // 最大消息数限制
    timeWindow: 86400000,      // 时间窗口（毫秒）
    priority: 1,               // 最低优先级
    includeTools: true,        // 是否包含工具调用
    includeWorkspace: true     // 是否包含工作空间信息
  }
}
```

### 压缩配置

```typescript
{
  compressionThreshold: 6000,  // 超过此token数时触发压缩
  enableVectorSearch: false    // 是否启用向量搜索（未来功能）
}
```

## 故障排除

### 常见问题

1. **上下文组件未启用**
   ```
   错误: 上下文组件未启用
   解决: 确保配置中 context.enabled = true
   ```

2. **会话未创建**
   ```
   错误: 没有活动会话，请先创建或加载会话
   解决: 调用 agent.createContextSession() 创建会话
   ```

3. **持久化存储失败**
   ```
   警告: 持久化存储不可用，将仅使用内存存储
   解决: 检查存储路径权限，确保目录可写
   ```

4. **Token超限**
   ```
   解决: 调整过滤器参数，降低 maxTokens 或 maxMessages
   ```

### 调试技巧

```typescript
// 启用详细日志
const agent = new Agent({
  debug: true,
  context: {
    debug: true
  }
});

// 检查组件状态
const contextComponent = agent.getContextComponent();
console.log('上下文组件状态:', contextComponent?.isContextReady());

// 监控上下文变化
const stats = await agent.getContextStats();
console.log('上下文统计:', JSON.stringify(stats, null, 2));
```

## 总结

通过集成上下文管理功能，blade-ai Agent 现在具备了：

1. **长期记忆能力** - 记住整个对话历史
2. **智能压缩** - 自动优化长对话的token使用
3. **工具调用追踪** - 完整记录工具使用历史
4. **会话管理** - 支持多会话切换和历史回溯
5. **性能优化** - 缓存和过滤机制保证高效运行

这使得Agent能够进行更智能、更连贯的长期对话，为用户提供更好的交互体验。 