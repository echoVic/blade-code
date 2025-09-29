# 新Agent架构 - 基于Claude Code设计

## 概述

新的Agent架构参考了Claude Code的设计理念，实现了以下核心特性：

1. **多Agent协作**: 主Agent协调多个专业化子Agent
2. **实时Steering**: 根据任务特征动态调整执行策略  
3. **智能上下文管理**: 自动压缩和优化对话历史
4. **递归代理模式**: 支持Agent调用Agent的复杂任务处理

## 架构组件

### 主要组件

- `MainAgent`: 主Agent，负责任务规划和协调
- `SubAgentRegistry`: 子Agent注册器，管理所有专业化Agent
- `TaskPlanner`: 任务规划器，智能分解复杂任务
- `SteeringController`: 实时控制器，动态调整执行策略
- `LLMContextManager`: 上下文管理器，优化对话历史
- `AgentTool`: Agent工具，实现递归代理调用

### 专业化子Agent

- `CodeAgent`: 代码专家，处理编程相关任务
- `AnalysisAgent`: 分析专家，处理分析和研究任务
- 更多专业Agent可按需扩展...

## 使用示例

### 基础用法

```typescript
import { createMainAgent } from '@blade/core/agent';

// 创建主Agent
const agent = await createMainAgent({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.example.com/v1',
  modelName: 'gpt-4'
});

// 简单聊天
const response = await agent.chat('帮我实现一个TypeScript工具函数');

// 复杂任务执行
const task = {
  id: 'task-1',
  type: 'complex',
  prompt: '分析这个项目的架构并提供优化建议',
  context: { projectPath: './src' }
};

const result = await agent.executeTask(task);
console.log(result.content);
console.log('使用的子Agent:', result.subAgentResults);
```

### Agent工具使用

```typescript
// 在工具系统中使用AgentTool
import { AgentTool } from '@blade/core/agent';

const agentTool = new AgentTool(mainAgent);

// 调用代码专家Agent
const codeResult = await agentTool.execute({
  agentName: 'code-agent',
  taskType: 'code',
  prompt: '实现一个排序算法',
  options: { temperature: 0.1 }
});

// 调用分析专家Agent  
const analysisResult = await agentTool.execute({
  agentName: 'analysis-agent',
  taskType: 'analysis',
  prompt: '分析这段代码的时间复杂度'
});
```

## 迁移指南

### 从旧架构迁移

1. **替换Agent类**:
```typescript
// 旧方式
import { Agent } from '@blade/core/agent';
const agent = new Agent(config);

// 新方式  
import { createMainAgent } from '@blade/core/agent';
const agent = await createMainAgent(config);
```

2. **使用专业化Agent**:
```typescript
// 旧方式 - 所有任务都用主Agent
const codeResponse = await agent.chat('写一个函数');
const analysisResponse = await agent.chat('分析这个数据');

// 新方式 - 使用专业化Agent
const codeResponse = await agentTool.execute({
  agentName: 'code-agent', 
  taskType: 'code',
  prompt: '写一个函数'
});

const analysisResponse = await agentTool.execute({
  agentName: 'analysis-agent',
  taskType: 'analysis', 
  prompt: '分析这个数据'
});
```

3. **上下文管理**:
```typescript
// 新方式支持智能上下文管理
const contextManager = agent.getContextManager();
const sessionId = contextManager.createSession();
const response = await contextManager.processConversation(messages, sessionId);
```

## 核心优势

### 1. 专业化处理
- 不同类型的任务由专门的Agent处理
- 每个Agent都有特定的专业知识和处理策略
- 提高任务处理的质量和效率

### 2. 智能调度
- 实时分析任务特征，选择最适合的处理方式
- 动态调整模型参数和执行策略
- 支持负载均衡和资源优化

### 3. 上下文优化
- 智能压缩对话历史，保留重要信息
- 支持长期对话和大型项目的上下文管理
- 自动优化token使用，降低成本

### 4. 可扩展性
- 插件化的子Agent系统，易于扩展新功能
- 标准化的Agent接口，支持自定义Agent
- 模块化设计，便于维护和升级

## 配置选项

```typescript
const config = {
  // 基础LLM配置
  apiKey: 'your-api-key',
  baseUrl: 'https://api.example.com/v1', 
  modelName: 'gpt-4',
  
  // Agent系统配置
  agentConfig: {
    maxConcurrentTasks: 5,
    taskTimeout: 30000,
    enableSteering: true,
    enableSubAgents: true
  },
  
  // 上下文管理配置
  contextConfig: {
    maxMessages: 50,
    maxTokens: 8000,
    compressionThreshold: 6000,
    enableCompression: true
  }
};
```

## 最佳实践

1. **任务分类**: 根据任务类型选择合适的Agent
2. **上下文管理**: 合理使用会话管理，避免上下文污染
3. **错误处理**: 利用Agent的重试和降级机制
4. **性能监控**: 关注Agent的执行统计和性能指标
5. **资源优化**: 合理配置并发数和超时时间

## 注意事项

- 新架构向后兼容，现有代码可以继续使用
- 建议逐步迁移到新架构以获得更好的性能
- 某些高级功能需要额外的配置和初始化
- 生产环境使用前请充分测试
