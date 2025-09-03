/**
 * Agent 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { BaseComponent } from '../../agent/BaseComponent.js';
import { LLMManager } from '../../agent/LLMManager.js';
import { ToolComponent } from '../../agent/ToolComponent.js';
import { ContextComponent } from '../../agent/ContextComponent.js';
import { LoggerComponent } from '../../agent/LoggerComponent.js';
import { MCPComponent } from '../../agent/MCPComponent.js';

// Mock 组件
const mockLLMManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  chat: vi.fn().mockResolvedValue({ content: 'Mock response' }),
  destroy: vi.fn().mockResolvedValue(undefined)
};

const mockToolComponent = {
  initialize: vi.fn().mockResolvedValue(undefined),
  registerTool: vi.fn().mockReturnValue(true),
  executeTool: vi.fn().mockResolvedValue({ success: true, result: 'Tool executed' }),
  destroy: vi.fn().mockResolvedValue(undefined)
};

const mockContextComponent = {
  initialize: vi.fn().mockResolvedValue(undefined),
  addContext: vi.fn().mockReturnValue(undefined),
  getContext: vi.fn().mockReturnValue({}),
  destroy: vi.fn().mockResolvedValue(undefined)
};

const mockLoggerComponent = {
  initialize: vi.fn().mockResolvedValue(undefined),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  destroy: vi.fn().mockResolvedValue(undefined)
};

const mockMCPComponent = {
  initialize: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue({ success: true }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined)
};

// Mock 组件管理器
vi.mock('../../agent/LLMManager.js', () => {
  return {
    LLMManager: vi.fn().mockImplementation(() => mockLLMManager)
  };
});

vi.mock('../../agent/ToolComponent.js', () => {
  return {
    ToolComponent: vi.fn().mockImplementation(() => mockToolComponent)
  };
});

vi.mock('../../agent/ContextComponent.js', () => {
  return {
    ContextComponent: vi.fn().mockImplementation(() => mockContextComponent)
  };
});

vi.mock('../../agent/LoggerComponent.js', () => {
  return {
    LoggerComponent: vi.fn().mockImplementation(() => mockLoggerComponent)
  };
});

vi.mock('../../agent/MCPComponent.js', () => {
  return {
    MCPComponent: vi.fn().mockImplementation(() => mockMCPComponent)
  };
});

describe('Agent', () => {
  let agent: Agent;
  
  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();
    
    // 创建新的 Agent 实例
    agent = new Agent({
      llm: {
        provider: 'test',
        apiKey: 'test-key'
      }
    });
  });
  
  afterEach(() => {
    // 销毁 agent 实例
    if (agent) {
      agent.destroy();
    }
  });
  
  describe('初始化', () => {
    it('应该成功创建 Agent 实例', () => {
      expect(agent).toBeInstanceOf(Agent);
    });
    
    it('应该正确初始化配置', () => {
      const config = agent.getConfig();
      expect(config).toBeDefined();
      expect(config.llm).toBeDefined();
      expect(config.llm.provider).toBe('test');
      expect(config.llm.apiKey).toBe('test-key');
    });
    
    it('应该能够正确初始化所有组件', async () => {
      await agent.init();
      
      expect(LLMManager).toHaveBeenCalled();
      expect(ToolComponent).toHaveBeenCalled();
      expect(ContextComponent).toHaveBeenCalled();
      expect(LoggerComponent).toHaveBeenCalled();
      expect(MCPComponent).toHaveBeenCalled();
      
      expect(mockLLMManager.initialize).toHaveBeenCalled();
      expect(mockToolComponent.initialize).toHaveBeenCalled();
      expect(mockContextComponent.initialize).toHaveBeenCalled();
      expect(mockLoggerComponent.initialize).toHaveBeenCalled();
      expect(mockMCPComponent.initialize).toHaveBeenCalled();
    });
    
    it('应该正确设置状态', async () => {
      expect(agent.isInitialized()).toBe(false);
      
      await agent.init();
      expect(agent.isInitialized()).toBe(true);
    });
  });
  
  describe('聊天功能', () => {
    beforeEach(async () => {
      await agent.init();
    });
    
    it('应该能够发送消息并接收响应', async () => {
      const response = await agent.chat('Hello, world!');
      
      expect(response).toBeDefined();
      expect(response.content).toBe('Mock response');
      expect(mockLLMManager.chat).toHaveBeenCalledWith('Hello, world!');
    });
    
    it('应该能够处理对话上下文', async () => {
      await agent.chat('First message');
      await agent.chat('Second message');
      
      expect(mockLLMManager.chat).toHaveBeenCalledTimes(2);
      expect(mockContextComponent.addContext).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user-message',
          content: 'First message'
        })
      );
      expect(mockContextComponent.addContext).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'assistant-response',
          content: 'Mock response'
        })
      );
    });
    
    it('应该在错误时正确处理', async () => {
      mockLLMManager.chat.mockRejectedValueOnce(new Error('LLM Error'));
      
      await expect(agent.chat('Hello')).rejects.toThrow('LLM Error');
      expect(mockLoggerComponent.error).toHaveBeenCalled();
    });
  });
  
  describe('工具执行', () => {
    beforeEach(async () => {
      await agent.init();
    });
    
    it('应该能够执行工具', async () => {
      const result = await agent.executeTool('test-tool', { param: 'value' });
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.result).toBe('Tool executed');
      expect(mockToolComponent.executeTool).toHaveBeenCalledWith('test-tool', { param: 'value' });
    });
    
    it('应该在工具执行错误时正确处理', async () => {
      mockToolComponent.executeTool.mockRejectedValueOnce(new Error('Tool Error'));
      
      await expect(agent.executeTool('test-tool', {})).rejects.toThrow('Tool Error');
      expect(mockLoggerComponent.error).toHaveBeenCalled();
    });
  });
  
  describe('上下文管理', () => {
    beforeEach(async () => {
      await agent.init();
    });
    
    it('应该能够添加上下文', () => {
      agent.addContext({ type: 'test', content: 'test content' });
      
      expect(mockContextComponent.addContext).toHaveBeenCalledWith({
        type: 'test',
        content: 'test content'
      });
    });
    
    it('应该能够获取上下文', () => {
      const context = agent.getContext();
      
      expect(context).toBeDefined();
      expect(mockContextComponent.getContext).toHaveBeenCalled();
    });
  });
  
  describe('MCP 功能', () => {
    beforeEach(async () => {
      await agent.init();
    });
    
    it('应该能够连接到 MCP 服务器', async () => {
      const result = await agent.connectMCP('ws://localhost:3000');
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(mockMCPComponent.connect).toHaveBeenCalledWith('ws://localhost:3000');
    });
    
    it('应该能够断开 MCP 连接', async () => {
      await agent.disconnectMCP();
      
      expect(mockMCPComponent.disconnect).toHaveBeenCalled();
    });
  });
  
  describe('组件管理', () => {
    it('应该能够注册自定义组件', async () => {
      class CustomComponent extends BaseComponent {
        name = 'custom';
        initialize = vi.fn().mockResolvedValue(undefined);
        destroy = vi.fn().mockResolvedValue(undefined);
      }
      
      const customComponent = new CustomComponent(agent as any);
      agent.registerComponent(customComponent);
      
      await agent.init();
      
      expect(customComponent.initialize).toHaveBeenCalled();
    });
    
    it('应该防止重复注册组件', async () => {
      class CustomComponent extends BaseComponent {
        name = 'custom';
        initialize = vi.fn().mockResolvedValue(undefined);
        destroy = vi.fn().mockResolvedValue(undefined);
      }
      
      const component = new CustomComponent(agent as any);
      agent.registerComponent(component);
      agent.registerComponent(component); // 重复注册
      
      await agent.init();
      
      // 应该只调用一次初始化
      expect(component.initialize).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('销毁', () => {
    beforeEach(async () => {
      await agent.init();
    });
    
    it('应该正确销毁所有组件', async () => {
      await agent.destroy();
      
      expect(mockLLMManager.destroy).toHaveBeenCalled();
      expect(mockToolComponent.destroy).toHaveBeenCalled();
      expect(mockContextComponent.destroy).toHaveBeenCalled();
      expect(mockLoggerComponent.destroy).toHaveBeenCalled();
      expect(mockMCPComponent.destroy).toHaveBeenCalled();
      
      expect(agent.isInitialized()).toBe(false);
    });
    
    it('应该能够多次安全调用销毁', async () => {
      await agent.destroy();
      await agent.destroy(); // 第二次调用
      
      // 应该不会出错
      expect(agent.isInitialized()).toBe(false);
    });
  });
  
  describe('错误处理', () => {
    it('应该在初始化失败时正确处理', async () => {
      mockLLMManager.initialize.mockRejectedValueOnce(new Error('Init Error'));
      
      await expect(agent.init()).rejects.toThrow('Init Error');
      expect(agent.isInitialized()).toBe(false);
    });
    
    it('应该在组件初始化失败时正确清理', async () => {
      mockToolComponent.initialize.mockRejectedValueOnce(new Error('Tool Init Error'));
      
      await expect(agent.init()).rejects.toThrow('Tool Init Error');
      
      // 应该销毁已初始化的组件
      expect(mockLLMManager.destroy).toHaveBeenCalled();
      expect(mockLoggerComponent.destroy).toHaveBeenCalled();
    });
  });
  
  describe('配置管理', () => {
    it('应该能够更新配置', () => {
      const newConfig = {
        llm: {
          provider: 'new-provider',
          apiKey: 'new-key'
        },
        ui: {
          theme: 'dark'
        }
      };
      
      agent.updateConfig(newConfig);
      
      const config = agent.getConfig();
      expect(config.llm.provider).toBe('new-provider');
      expect(config.llm.apiKey).toBe('new-key');
      expect(config.ui.theme).toBe('dark');
    });
    
    it('应该能够获取特定配置', () => {
      const llmConfig = agent.getConfig().llm;
      expect(llmConfig).toBeDefined();
      expect(llmConfig.provider).toBe('test');
      expect(llmConfig.apiKey).toBe('test-key');
    });
  });
});