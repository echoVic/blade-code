/**
 * LLMManager 单元测试
 */

import { LLMManager } from '../LLMManager.js';
import { BaseLLM } from '../../llm/BaseLLM.js';

// Mock LLM 实现
class MockLLM extends BaseLLM {
  name = 'mock-llm';
  provider = 'mock';
  
  initialize = jest.fn().mockResolvedValue(undefined);
  chat = jest.fn().mockResolvedValue({
    content: 'Mock response',
    usage: { promptTokens: 10, completionTokens: 5 }
  });
  complete = jest.fn().mockResolvedValue({
    text: 'Mock completion',
    usage: { promptTokens: 5, completionTokens: 10 }
  });
  embed = jest.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
    usage: { promptTokens: 15 }
  });
  destroy = jest.fn().mockResolvedValue(undefined);
  validateConfig = jest.fn().mockReturnValue(true);
}

// Mock LLM 构造函数
jest.mock('../../llm/BaseLLM.js', () => {
  return {
    BaseLLM: class extends require('../../llm/BaseLLM.js').BaseLLM {
      constructor(config: any) {
        super(config);
        Object.assign(this, new MockLLM(config));
      }
    }
  };
});

describe('LLMManager', () => {
  let llmManager: LLMManager;
  let mockLLM: MockLLM;
  
  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();
    
    // 创建新的 LLMManager 实例
    llmManager = new LLMManager({
      provider: 'mock',
      apiKey: 'test-key'
    });
    
    // 创建 mock LLM 实例
    mockLLM = new MockLLM({
      provider: 'mock',
      apiKey: 'test-key'
    });
  });
  
  afterEach(() => {
    // 销毁 llmManager 实例
    if (llmManager) {
      llmManager.destroy();
    }
  });
  
  describe('初始化', () => {
    test('应该成功创建 LLMManager 实例', () => {
      expect(llmManager).toBeInstanceOf(LLMManager);
    });
    
    test('应该能够正确初始化 LLM', async () => {
      // 模拟 LLM 实例
      (llmManager as any).llm = mockLLM;
      
      await llmManager.initialize();
      
      expect(mockLLM.initialize).toHaveBeenCalled();
    });
    
    test('应该正确设置状态', async () => {
      expect(llmManager.isInitialized()).toBe(false);
      
      (llmManager as any).llm = mockLLM;
      await llmManager.initialize();
      
      expect(llmManager.isInitialized()).toBe(true);
    });
    
    test('应该在初始化失败时正确处理', async () => {
      mockLLM.initialize.mockRejectedValueOnce(new Error('Init Error'));
      (llmManager as any).llm = mockLLM;
      
      await expect(llmManager.initialize()).rejects.toThrow('Init Error');
      expect(llmManager.isInitialized()).toBe(false);
    });
  });
  
  describe('聊天功能', () => {
    beforeEach(async () => {
      (llmManager as any).llm = mockLLM;
      await llmManager.initialize();
    });
    
    test('应该能够发送消息并接收响应', async () => {
      const response = await llmManager.chat('Hello, world!');
      
      expect(response).toBeDefined();
      expect(response.content).toBe('Mock response');
      expect(mockLLM.chat).toHaveBeenCalledWith('Hello, world!');
    });
    
    test('应该传递聊天选项', async () => {
      const options = {
        temperature: 0.8,
        maxTokens: 100
      };
      
      await llmManager.chat('Hello, world!', options);
      
      expect(mockLLM.chat).toHaveBeenCalledWith('Hello, world!', options);
    });
    
    test('应该在聊天错误时正确处理', async () => {
      mockLLM.chat.mockRejectedValueOnce(new Error('Chat Error'));
      
      await expect(llmManager.chat('Hello')).rejects.toThrow('Chat Error');
    });
  });
  
  describe('文本补全', () => {
    beforeEach(async () => {
      (llmManager as any).llm = mockLLM;
      await llmManager.initialize();
    });
    
    test('应该能够执行文本补全', async () => {
      const response = await llmManager.complete('Hello, ');
      
      expect(response).toBeDefined();
      expect(response.text).toBe('Mock completion');
      expect(mockLLM.complete).toHaveBeenCalledWith('Hello, ');
    });
    
    test('应该传递补全选项', async () => {
      const options = {
        maxTokens: 50,
        stop: ['\n']
      };
      
      await llmManager.complete('Hello, ', options);
      
      expect(mockLLM.complete).toHaveBeenCalledWith('Hello, ', options);
    });
    
    test('应该在补全错误时正确处理', async () => {
      mockLLM.complete.mockRejectedValueOnce(new Error('Complete Error'));
      
      await expect(llmManager.complete('Hello')).rejects.toThrow('Complete Error');
    });
  });
  
  describe('嵌入生成', () => {
    beforeEach(async () => {
      (llmManager as any).llm = mockLLM;
      await llmManager.initialize();
    });
    
    test('应该能够生成嵌入', async () => {
      const response = await llmManager.embed(['Hello, world!']);
      
      expect(response).toBeDefined();
      expect(response.embeddings).toEqual([[0.1, 0.2, 0.3]]);
      expect(mockLLM.embed).toHaveBeenCalledWith(['Hello, world!']);
    });
    
    test('应该在嵌入错误时正确处理', async () => {
      mockLLM.embed.mockRejectedValueOnce(new Error('Embed Error'));
      
      await expect(llmManager.embed(['Hello'])).rejects.toThrow('Embed Error');
    });
  });
  
  describe('配置验证', () => {
    test('应该能够验证配置', () => {
      const isValid = llmManager.validateConfig();
      
      expect(isValid).toBe(true);
      expect(mockLLM.validateConfig).toHaveBeenCalled();
    });
    
    test('应该在验证失败时返回 false', () => {
      mockLLM.validateConfig.mockReturnValueOnce(false);
      (llmManager as any).llm = mockLLM;
      
      const isValid = llmManager.validateConfig();
      
      expect(isValid).toBe(false);
    });
  });
  
  describe('销毁', () => {
    beforeEach(async () => {
      (llmManager as any).llm = mockLLM;
      await llmManager.initialize();
    });
    
    test('应该正确销毁 LLM', async () => {
      await llmManager.destroy();
      
      expect(mockLLM.destroy).toHaveBeenCalled();
      expect(llmManager.isInitialized()).toBe(false);
    });
    
    test('应该能够多次安全调用销毁', async () => {
      await llmManager.destroy();
      await llmManager.destroy(); // 第二次调用
      
      // 应该不会出错
      expect(llmManager.isInitialized()).toBe(false);
    });
  });
  
  describe('提供商支持', () => {
    test('应该支持多种提供商', () => {
      // 这些测试需要实际的 LLM 实现在测试环境中，所以我们只测试实例创建
      expect(() => {
        new LLMManager({
          provider: 'openai',
          apiKey: 'test-key'
        });
      }).not.toThrow();
      
      expect(() => {
        new LLMManager({
          provider: 'anthropic',
          apiKey: 'test-key'
        });
      }).not.toThrow();
    });
    
    test('应该在不支持的提供商时抛出错误', () => {
      expect(() => {
        new LLMManager({
          provider: 'unsupported' as any,
          apiKey: 'test-key'
        });
      }).toThrow();
    });
  });
  
  describe('错误处理', () => {
    test('应该在未初始化时拒绝调用方法', async () => {
      await expect(llmManager.chat('Hello')).rejects.toThrow('LLM not initialized');
      await expect(llmManager.complete('Hello')).rejects.toThrow('LLM not initialized');
      await expect(llmManager.embed(['Hello'])).rejects.toThrow('LLM not initialized');
    });
    
    test('应该处理空输入', async () => {
      (llmManager as any).llm = mockLLM;
      await llmManager.initialize();
      
      await expect(llmManager.chat('')).rejects.toThrow();
      await expect(llmManager.complete('')).rejects.toThrow();
      await expect(llmManager.embed([])).rejects.toThrow();
    });
  });
});