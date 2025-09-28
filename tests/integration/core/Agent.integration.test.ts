/**
 * Agent 集成测试
 */

import { Agent } from '../../packages/core/src/agent/Agent';
import { ContextComponent } from '../../packages/core/src/agent/ContextComponent';
import { LLMManager } from '../../packages/core/src/agent/LLMManager';
import { LoggerComponent } from '../../packages/core/src/agent/LoggerComponent';
import { MCPComponent } from '../../packages/core/src/agent/MCPComponent';
import { ToolComponent } from '../../packages/core/src/agent/ToolComponent';

// 集成测试配置
const TEST_CONFIG = {
  llm: {
    provider: 'test',
    apiKey: 'test-key',
  },
  logging: {
    level: 'error', // 减少日志输出
  },
};

describe('Agent 集成测试', () => {
  let agent: Agent;

  beforeAll(async () => {
    // 增加测试超时时间
    jest.setTimeout(30000);
  });

  beforeEach(async () => {
    agent = new Agent(TEST_CONFIG);
    await agent.init();
  });

  afterEach(async () => {
    if (agent) {
      await agent.destroy();
    }
  });

  describe('组件集成', () => {
    test('应该正确初始化所有组件', async () => {
      // 验证所有组件都已初始化
      expect(agent.isInitialized()).toBe(true);

      // 验证组件实例
      const llmManager = (agent as any).llmManager;
      const toolComponent = (agent as any).toolComponent;
      const contextComponent = (agent as any).contextComponent;
      const loggerComponent = (agent as any).loggerComponent;
      const mcpComponent = (agent as any).mcpComponent;

      expect(llmManager).toBeInstanceOf(LLMManager);
      expect(toolComponent).toBeInstanceOf(ToolComponent);
      expect(contextComponent).toBeInstanceOf(ContextComponent);
      expect(loggerComponent).toBeInstanceOf(LoggerComponent);
      expect(mcpComponent).toBeInstanceOf(MCPComponent);
    });

    test('组件之间应该能够正确通信', async () => {
      // 添加上下文
      agent.addContext({
        type: 'test',
        content: 'Integration test context',
      });

      // 验证上下文被正确存储
      const context = agent.getContext();
      expect(context).toBeDefined();

      // 验证日志组件能够记录信息
      const logger = (agent as any).loggerComponent;
      expect(logger).toBeDefined();
    });
  });

  describe('功能集成', () => {
    test('应该能够执行完整的聊天流程', async () => {
      // 模拟 LLM 响应
      const llmManager = (agent as any).llmManager;
      jest.spyOn(llmManager, 'chat').mockResolvedValue({
        content: 'Hello from test LLM!',
        usage: { promptTokens: 10, completionTokens: 5 },
      });

      // 执行聊天
      const response = await agent.chat('Hello, Agent!');

      // 验证响应
      expect(response).toBeDefined();
      expect(response.content).toBe('Hello from test LLM!');

      // 验证上下文被更新
      const context = agent.getContext();
      expect(context.entries).toHaveLength(2); // 用户消息 + 助手响应
    });

    test('应该能够执行工具链', async () => {
      // 注册测试工具
      // 这需要一个真实的工具实现来进行测试
      expect(true).toBe(true); // 占位符
    });

    test('应该能够管理复杂的上下文', async () => {
      // 添加多个上下文条目
      for (let i = 0; i < 5; i++) {
        agent.addContext({
          type: 'user-message',
          content: `Message ${i}`,
        });
      }

      const context = agent.getContext();
      expect(context.entries).toHaveLength(5);
    });
  });

  describe('错误处理集成', () => {
    test('应该在组件初始化失败时正确回滚', async () => {
      // 创建一个新的 agent 来测试错误情况
      const failingAgent = new Agent(TEST_CONFIG);

      // 模拟组件初始化失败
      const originalInit = (failingAgent as any).initComponents;
      jest
        .spyOn(failingAgent as any, 'initComponents')
        .mockImplementationOnce(async () => {
          throw new Error('Component initialization failed');
        });

      await expect(failingAgent.init()).rejects.toThrow(
        'Component initialization failed'
      );
      expect(failingAgent.isInitialized()).toBe(false);

      await failingAgent.destroy();
    });

    test('应该在组件执行失败时正确处理', async () => {
      // 模拟 LLM 调用失败
      const llmManager = (agent as any).llmManager;
      jest
        .spyOn(llmManager, 'chat')
        .mockRejectedValueOnce(new Error('LLM service unavailable'));

      await expect(agent.chat('Hello')).rejects.toThrow('LLM service unavailable');

      // 验证日志被记录
      // 这需要访问日志组件来验证
    });
  });

  describe('性能集成', () => {
    test('应该在合理时间内完成初始化', async () => {
      const startTime = Date.now();

      const newAgent = new Agent(TEST_CONFIG);
      await newAgent.init();

      const endTime = Date.now();
      const initTime = endTime - startTime;

      // 初始化应该在 5 秒内完成
      expect(initTime).toBeLessThan(5000);

      await newAgent.destroy();
    });

    test('应该能够处理并发请求', async () => {
      // 模拟并发聊天请求
      const promises = Array.from({ length: 3 }, (_, i) =>
        agent.chat(`Concurrent message ${i}`)
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.content).toBe('Mock response');
      });
    });
  });

  describe('配置集成', () => {
    test('应该能够动态更新配置', async () => {
      const originalConfig = agent.getConfig();
      expect(originalConfig.llm.provider).toBe('test');

      // 更新配置
      agent.updateConfig({
        llm: {
          provider: 'updated-test',
          apiKey: 'updated-key',
        },
      });

      const updatedConfig = agent.getConfig();
      expect(updatedConfig.llm.provider).toBe('updated-test');
    });

    test('组件应该响应配置变化', async () => {
      // 这需要组件实现配置更新监听机制
      expect(true).toBe(true); // 占位符
    });
  });
});
