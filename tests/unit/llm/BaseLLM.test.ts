/**
 * BaseLLM 单元测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { BaseLLM } from '../../../src/services/ChatServiceInterface';

// 模拟子类实现
class MockLLM extends BaseLLM {
  name = 'mock-llm';
  provider = 'mock';

  async _chat(messages: any[], options?: any): Promise<any> {
    return {
      content: 'Mock response',
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  }

  async _complete(prompt: string, options?: any): Promise<any> {
    return {
      text: 'Mock completion',
      usage: { promptTokens: 5, completionTokens: 10 },
    };
  }

  async _embed(texts: string[], options?: any): Promise<any> {
    return {
      embeddings: texts.map(() => [0.1, 0.2, 0.3]),
      usage: { promptTokens: texts.length * 5 },
    };
  }

  _validateConfig(config: any): boolean {
    return !!config.apiKey;
  }
}

describe('BaseLLM', () => {
  let mockLLM: MockLLM;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 创建新的 MockLLM 实例
    mockLLM = new MockLLM({
      provider: 'mock',
      apiKey: 'test-key',
    });
  });

  afterEach(() => {
    // 销毁 LLM 实例
    if (mockLLM) {
      mockLLM.destroy();
    }
  });

  describe('初始化', () => {
    test('应该成功创建 LLM 实例', () => {
      expect(mockLLM).toBeInstanceOf(BaseLLM);
      expect(mockLLM).toBeInstanceOf(MockLLM);
    });

    test('应该正确设置配置', () => {
      const config = mockLLM.getConfig();
      expect(config.provider).toBe('mock');
      expect(config.apiKey).toBe('test-key');
    });

    test('应该正确设置元数据', () => {
      const metadata = mockLLM.getMetadata();
      expect(metadata.name).toBe('mock-llm');
      expect(metadata.provider).toBe('mock');
      expect(metadata.version).toBe('1.0.0');
    });
  });

  describe('聊天功能', () => {
    test('应该能够发送消息并接收响应', async () => {
      const response = await mockLLM.chat('Hello, world!');

      expect(response).toBeDefined();
      expect(response.content).toBe('Mock response');
      expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    });

    test('应该处理消息数组', async () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const response = await mockLLM.chat(messages);

      expect(response).toBeDefined();
      expect(response.content).toBe('Mock response');
    });

    test('应该传递聊天选项', async () => {
      const options = {
        temperature: 0.8,
        maxTokens: 100,
        stop: ['\n'],
      };

      // 监控私有方法调用
      const chatSpy = vi.spyOn(mockLLM as any, '_chat');

      await mockLLM.chat('Hello, world!', options);

      expect(chatSpy).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Hello, world!' }],
        options
      );
    });

    test('应该在聊天错误时正确处理', async () => {
      vi.spyOn(mockLLM as any, '_chat').mockRejectedValueOnce(new Error('Chat Error'));

      await expect(mockLLM.chat('Hello')).rejects.toThrow('Chat Error');
    });
  });

  describe('文本补全', () => {
    test('应该能够执行文本补全', async () => {
      const response = await mockLLM.complete('Hello, ');

      expect(response).toBeDefined();
      expect(response.text).toBe('Mock completion');
      expect(response.usage).toEqual({ promptTokens: 5, completionTokens: 10 });
    });

    test('应该传递补全选项', async () => {
      const options = {
        maxTokens: 50,
        temperature: 0.7,
        stop: ['.'],
      };

      // 监控私有方法调用
      const completeSpy = vi.spyOn(mockLLM as any, '_complete');

      await mockLLM.complete('Hello, ', options);

      expect(completeSpy).toHaveBeenCalledWith('Hello, ', options);
    });

    test('应该在补全错误时正确处理', async () => {
      vi.spyOn(mockLLM as any, '_complete').mockRejectedValueOnce(
        new Error('Complete Error')
      );

      await expect(mockLLM.complete('Hello')).rejects.toThrow('Complete Error');
    });
  });

  describe('嵌入生成', () => {
    test('应该能够生成嵌入', async () => {
      const response = await mockLLM.embed(['Hello, world!']);

      expect(response).toBeDefined();
      expect(response.embeddings).toEqual([[0.1, 0.2, 0.3]]);
      expect(response.usage).toEqual({ promptTokens: 5 });
    });

    test('应该处理多个文本', async () => {
      const texts = ['Hello', 'World', 'Test'];
      const response = await mockLLM.embed(texts);

      expect(response.embeddings).toHaveLength(3);
      expect(response.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(response.embeddings[1]).toEqual([0.1, 0.2, 0.3]);
      expect(response.embeddings[2]).toEqual([0.1, 0.2, 0.3]);
    });

    test('应该在嵌入错误时正确处理', async () => {
      vi.spyOn(mockLLM as any, '_embed').mockRejectedValueOnce(
        new Error('Embed Error')
      );

      await expect(mockLLM.embed(['Hello'])).rejects.toThrow('Embed Error');
    });
  });

  describe('配置验证', () => {
    test('应该能够验证配置', () => {
      const isValid = mockLLM.validateConfig();

      expect(isValid).toBe(true);
    });

    test('应该检测无效配置', () => {
      const invalidLLM = new MockLLM({
        provider: 'mock',
        // 缺少 apiKey
      });

      const isValid = invalidLLM.validateConfig();

      expect(isValid).toBe(false);
    });

    test('应该处理验证错误', () => {
      vi.spyOn(mockLLM as any, '_validateConfig').mockImplementationOnce(() => {
        throw new Error('Validation Error');
      });

      const isValid = mockLLM.validateConfig();

      expect(isValid).toBe(false);
    });
  });

  describe('统计信息', () => {
    test('应该能够跟踪使用统计', async () => {
      // 执行一些操作
      await mockLLM.chat('Hello');
      await mockLLM.complete('World');
      await mockLLM.embed(['Test']);

      const stats = mockLLM.getStats();

      expect(stats.requests).toBe(3);
      expect(stats.errors).toBe(0);
      expect(stats.totalTokens).toBeGreaterThan(0);
    });

    test('应该跟踪错误统计', async () => {
      vi.spyOn(mockLLM as any, '_chat').mockRejectedValueOnce(new Error('Test Error'));

      try {
        await mockLLM.chat('Hello');
      } catch (error) {
        // 预期的错误
      }

      const stats = mockLLM.getStats();

      expect(stats.requests).toBe(1);
      expect(stats.errors).toBe(1);
    });

    test('应该能够重置统计', async () => {
      await mockLLM.chat('Hello');

      mockLLM.resetStats();

      const stats = mockLLM.getStats();
      expect(stats.requests).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe('销毁', () => {
    test('应该正确销毁 LLM', () => {
      const destroySpy = vi.spyOn(mockLLM, 'destroy');

      mockLLM.destroy();

      expect(destroySpy).toHaveBeenCalled();
    });

    test('应该能够多次安全调用销毁', () => {
      mockLLM.destroy();
      mockLLM.destroy(); // 第二次调用

      // 应该不会出错
      expect(mockLLM.isDestroyed()).toBe(true);
    });
  });

  describe('错误处理', () => {
    test('应该在销毁后拒绝调用方法', async () => {
      mockLLM.destroy();

      await expect(mockLLM.chat('Hello')).rejects.toThrow('LLM instance is destroyed');
      await expect(mockLLM.complete('Hello')).rejects.toThrow(
        'LLM instance is destroyed'
      );
      await expect(mockLLM.embed(['Hello'])).rejects.toThrow(
        'LLM instance is destroyed'
      );
    });

    test('应该处理空输入', async () => {
      await expect(mockLLM.chat('')).rejects.toThrow();
      await expect(mockLLM.complete('')).rejects.toThrow();
      await expect(mockLLM.embed([])).rejects.toThrow();
    });
  });

  describe('工具方法', () => {
    test('应该能够格式化消息', () => {
      const formatted = (mockLLM as any).formatMessages('Hello, world!');

      expect(formatted).toEqual([{ role: 'user', content: 'Hello, world!' }]);
    });

    test('应该能够计算令牌数', () => {
      const tokenCount = (mockLLM as any).countTokens('Hello, world!');

      expect(typeof tokenCount).toBe('number');
      expect(tokenCount).toBeGreaterThan(0);
    });

    test('应该能够处理响应', async () => {
      const rawResponse = {
        content: 'Test response',
        usage: { promptTokens: 5, completionTokens: 10 },
      };

      const processed = (mockLLM as any).processResponse(rawResponse);

      expect(processed).toEqual({
        content: 'Test response',
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
      });
    });
  });
});
