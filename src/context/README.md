# 上下文管理模块

一个强大而灵活的上下文管理系统，为 AI Agent CLI 提供智能的上下文处理能力。

## 核心特性

- **分层上下文管理**：系统、会话、对话、工具、工作空间五层结构
- **智能压缩**：自动压缩历史对话，节省 token 使用
- **多级存储**：内存、缓存、持久化三级存储架构
- **灵活过滤**：基于时间、优先级、内容的智能过滤
- **会话持久化**：跨会话的数据持久化和恢复
- **性能优化**：LRU 缓存、异步操作、内存管理

## 快速开始

### 基本使用

```typescript
import { createContextManager } from './context/index.js';

// 创建上下文管理器
const contextManager = createContextManager({
  storage: {
    maxMemorySize: 1000,
    persistentPath: './my-context',
    cacheSize: 100
  },
  defaultFilter: {
    maxTokens: 4000,
    maxMessages: 50
  }
});

// 初始化
await contextManager.initialize();

// 创建新会话
const sessionId = await contextManager.createSession('user123', {
  language: 'zh-CN',
  theme: 'dark'
});

// 添加消息
await contextManager.addMessage('user', '你好，我需要帮助开发一个 TypeScript 项目');
await contextManager.addMessage('assistant', '我很乐意帮助您！请告诉我您的项目需求。');

// 获取格式化的上下文
const { context, compressed, tokenCount } = await contextManager.getFormattedContext({
  maxTokens: 2000,
  includeTools: true
});

console.log(`当前上下文使用了 ${tokenCount} 个 tokens`);
```

### 工具调用集成

```typescript
// 记录工具调用
await contextManager.addToolCall({
  id: 'tool_001',
  name: 'file_read',
  input: { path: './src/index.ts' },
  output: { content: '...' },
  timestamp: Date.now(),
  status: 'success'
});

// 检查缓存的工具结果
const cachedResult = contextManager.getCachedToolResult('file_read', { path: './src/index.ts' });
if (cachedResult) {
  console.log('使用缓存结果');
}
```

### 会话管理

```typescript
// 搜索历史会话
const sessions = await contextManager.searchSessions('TypeScript 项目', 5);
console.log(`找到 ${sessions.length} 个相关会话`);

// 加载历史会话
const loaded = await contextManager.loadSession('session_12345');
if (loaded) {
  console.log('会话加载成功');
}

// 获取统计信息
const stats = await contextManager.getStats();
console.log('管理器状态:', stats);
```

## 核心组件

### ContextManager

主要的上下文管理器，提供统一的 API 接口。

```typescript
const manager = new ContextManager({
  storage: {
    maxMemorySize: 1000,        // 内存最大条目数
    persistentPath: './context', // 持久化存储路径
    cacheSize: 100,             // 缓存大小
    compressionEnabled: true    // 启用压缩
  },
  defaultFilter: {
    maxTokens: 4000,           // 最大 token 数
    maxMessages: 50,           // 最大消息数
    timeWindow: 24 * 60 * 60 * 1000, // 时间窗口（毫秒）
    includeTools: true,        // 包含工具调用
    includeWorkspace: true     // 包含工作空间信息
  },
  compressionThreshold: 6000,  // 压缩阈值
  enableVectorSearch: false    // 启用向量搜索（未来功能）
});
```

### 存储层

#### MemoryStore
内存存储，用于当前会话的快速访问：

```typescript
const memory = new MemoryStore(1000); // 最大1000条消息
memory.addMessage(message);
const recent = memory.getRecentMessages(10);
```

#### PersistentStore
持久化存储，用于跨会话数据保存：

```typescript
const persistent = new PersistentStore('./context-data', 100);
await persistent.initialize();
await persistent.saveSession(sessionId, sessionContext);
```

#### CacheStore
LRU 缓存，用于热点数据快速访问：

```typescript
const cache = new CacheStore(100, 5 * 60 * 1000); // 100项，5分钟TTL
cache.cacheToolResult('file_read', input, result);
const cached = cache.getToolResult('file_read', input);
```

### 处理器

#### ContextCompressor
智能压缩长对话：

```typescript
const compressor = new ContextCompressor(500, 10, 20);
const compressed = await compressor.compress(contextData);
console.log(`压缩后使用 ${compressed.tokenCount} tokens`);
```

#### ContextFilter
灵活的上下文过滤：

```typescript
const filter = new ContextFilter({
  maxTokens: 2000,
  maxMessages: 20,
  priority: 2 // 只包含高优先级消息
});

const filtered = filter.filter(contextData, {
  includeTools: false,
  timeWindow: 6 * 60 * 60 * 1000 // 只要最近6小时
});
```

## 配置选项

### 过滤器预设

```typescript
import { ContextFilter } from './context/index.js';

const presets = ContextFilter.createPresets();

// 轻量级：快速响应
const lightweight = presets.lightweight;

// 标准：平衡性能和功能
const standard = presets.standard;

// 完整：包含所有上下文
const comprehensive = presets.comprehensive;

// 调试：专注于错误和工具调用
const debug = presets.debug;
```

### 自定义配置

```typescript
import { createDefaultConfig } from './context/index.js';

const config = createDefaultConfig();
config.storage.maxMemorySize = 2000;
config.compressionThreshold = 8000;

const manager = new ContextManager(config);
```

## 工具函数

### 格式化上下文

```typescript
import { formatContextForPrompt } from './context/index.js';

const promptText = formatContextForPrompt(context, compressed, {
  includeSystemInfo: true,
  includeToolHistory: true,
  includeWorkspaceInfo: false,
  maxRecentMessages: 15
});
```

### 数据验证

```typescript
import { validateContextData, estimateContextSize } from './context/index.js';

if (validateContextData(data)) {
  const size = estimateContextSize(data);
  console.log(`数据包含 ${size.messageCount} 条消息，预计 ${size.totalTokens} tokens`);
}
```

## 最佳实践

### 1. 会话生命周期管理

```typescript
// 应用启动时
await contextManager.initialize();

// 用户开始对话
const sessionId = await contextManager.createSession();

// 对话过程中
await contextManager.addMessage('user', userInput);
await contextManager.addMessage('assistant', response);

// 应用关闭时
await contextManager.cleanup();
```

### 2. 性能优化

```typescript
// 使用合适的过滤器
const { context } = await contextManager.getFormattedContext({
  maxTokens: 3000,  // 根据模型限制调整
  includeTools: false, // 如果不需要工具历史
  timeWindow: 12 * 60 * 60 * 1000 // 只要最近12小时
});

// 批量操作
const toolCalls = [call1, call2, call3];
for (const call of toolCalls) {
  await contextManager.addToolCall(call);
}
```

### 3. 错误处理

```typescript
try {
  await contextManager.loadSession(sessionId);
} catch (error) {
  console.error('加载会话失败:', error);
  // 创建新会话作为备选
  await contextManager.createSession();
}
```

### 4. 内存管理

```typescript
// 定期检查内存使用
const stats = await contextManager.getStats();
if (stats.memory.messageCount > 1000) {
  // 触发压缩或清理
  await contextManager.compressCurrentContext();
}

// 长时间运行的应用需要定期清理
setInterval(async () => {
  await contextManager.cleanup();
}, 24 * 60 * 60 * 1000); // 每24小时清理一次
```

## 故障排除

### 常见问题

1. **持久化存储失败**
   ```typescript
   const health = await persistent.checkStorageHealth();
   if (!health.isAvailable) {
     console.warn('持久化存储不可用，检查文件权限');
   }
   ```

2. **内存使用过高**
   ```typescript
   const memoryInfo = memory.getMemoryInfo();
   if (memoryInfo.messageCount > maxSize) {
     // 减少内存大小或增加压缩频率
   }
   ```

3. **Token 超限**
   ```typescript
   const { tokenCount } = await contextManager.getFormattedContext();
   if (tokenCount > modelLimit) {
     // 使用更严格的过滤器或启用压缩
   }
   ```

## 扩展开发

### 自定义存储后端

```typescript
interface CustomStore {
  save(key: string, data: any): Promise<void>;
  load(key: string): Promise<any>;
  delete(key: string): Promise<void>;
}

// 实现自定义存储逻辑
class RedisStore implements CustomStore {
  // 实现方法...
}
```

### 自定义压缩算法

```typescript
class CustomCompressor extends ContextCompressor {
  async compress(contextData: ContextData): Promise<CompressedContext> {
    // 实现自定义压缩逻辑
    return super.compress(contextData);
  }
}
```

这个上下文管理模块为 AI Agent CLI 提供了强大而灵活的上下文处理能力，能够有效管理对话历史、工具调用记录和工作空间状态，同时保持高性能和低内存使用。 