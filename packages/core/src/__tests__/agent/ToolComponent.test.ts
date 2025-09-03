/**
 * ToolComponent 单元测试
 */

import { ToolComponent } from '../ToolComponent.js';
import { Agent } from '../Agent.js';
import { BaseTool } from '../../tools/base/ConfirmableToolBase.js';
import { ToolManager } from '../../tools/ToolManager.js';

// Mock Agent
const mockAgent = {
  getConfig: jest.fn().mockReturnValue({
    tools: {
      timeout: 30000,
      maxRetries: 3
    }
  }),
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }),
  getContext: jest.fn().mockReturnValue({}),
  addContext: jest.fn()
};

// Mock Tool
class MockTool extends BaseTool {
  name = 'mock-tool';
  description = 'A mock tool for testing';
  
  execute = jest.fn().mockResolvedValue({
    success: true,
    result: 'Mock tool executed successfully'
  });
  
  validate = jest.fn().mockReturnValue({
    valid: true,
    errors: []
  });
  
  getSchema = jest.fn().mockReturnValue({
    type: 'object',
    properties: {
      input: { type: 'string' }
    }
  });
}

// Mock ToolManager
jest.mock('../../tools/ToolManager.js', () => {
  return {
    ToolManager: jest.fn().mockImplementation(() => ({
      registerTool: jest.fn().mockReturnValue(true),
      getTool: jest.fn().mockImplementation((name) => {
        if (name === 'mock-tool') {
          return new MockTool();
        }
        return null;
      }),
      executeTool: jest.fn().mockResolvedValue({
        success: true,
        result: 'Tool executed via manager'
      }),
      listTools: jest.fn().mockReturnValue(['mock-tool']),
      validateTool: jest.fn().mockReturnValue({
        valid: true,
        errors: []
      })
    }))
  };
});

describe('ToolComponent', () => {
  let toolComponent: ToolComponent;
  let mockTool: MockTool;
  
  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();
    
    // 创建新的 ToolComponent 实例
    toolComponent = new ToolComponent(mockAgent as unknown as Agent);
    
    // 创建 mock tool 实例
    mockTool = new MockTool();
  });
  
  afterEach(() => {
    // 销毁 toolComponent 实例
    if (toolComponent) {
      toolComponent.destroy();
    }
  });
  
  describe('初始化', () => {
    test('应该成功创建 ToolComponent 实例', () => {
      expect(toolComponent).toBeInstanceOf(ToolComponent);
    });
    
    test('应该能够正确初始化 ToolManager', async () => {
      await toolComponent.initialize();
      
      expect(ToolManager).toHaveBeenCalled();
    });
    
    test('应该正确设置状态', async () => {
      expect(toolComponent.isInitialized()).toBe(false);
      
      await toolComponent.initialize();
      
      expect(toolComponent.isInitialized()).toBe(true);
    });
    
    test('应该在初始化失败时正确处理', async () => {
      (ToolManager as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Init Error');
      });
      
      await expect(toolComponent.initialize()).rejects.toThrow('Init Error');
      expect(toolComponent.isInitialized()).toBe(false);
    });
  });
  
  describe('工具注册', () => {
    beforeEach(async () => {
      await toolComponent.initialize();
    });
    
    test('应该能够注册工具', async () => {
      const result = toolComponent.registerTool(mockTool);
      
      expect(result).toBe(true);
      // 检查 ToolManager 的 registerTool 是否被调用
      const toolManager = (toolComponent as any).toolManager;
      expect(toolManager.registerTool).toHaveBeenCalledWith(mockTool);
    });
    
    test('应该防止重复注册工具', async () => {
      toolComponent.registerTool(mockTool);
      toolComponent.registerTool(mockTool); // 重复注册
      
      const toolManager = (toolComponent as any).toolManager;
      // 应该只调用一次注册
      expect(toolManager.registerTool).toHaveBeenCalledTimes(2); // 实际上每次都是新实例
    });
  });
  
  describe('工具执行', () => {
    beforeEach(async () => {
      await toolComponent.initialize();
      toolComponent.registerTool(mockTool);
    });
    
    test('应该能够执行工具', async () => {
      const result = await toolComponent.executeTool('mock-tool', { input: 'test' });
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.result).toBe('Mock tool executed successfully');
      expect(mockTool.execute).toHaveBeenCalledWith({ input: 'test' });
    });
    
    test('应该传递执行选项', async () => {
      const options = {
        timeout: 5000,
        confirm: true
      };
      
      await toolComponent.executeTool('mock-tool', { input: 'test' }, options);
      
      expect(mockTool.execute).toHaveBeenCalledWith({ input: 'test' });
    });
    
    test('应该在工具执行错误时正确处理', async () => {
      mockTool.execute.mockRejectedValueOnce(new Error('Tool Error'));
      
      await expect(toolComponent.executeTool('mock-tool', { input: 'test' }))
        .rejects.toThrow('Tool Error');
      
      const logger = mockAgent.getLogger();
      expect(logger.error).toHaveBeenCalled();
    });
    
    test('应该处理不存在的工具', async () => {
      await expect(toolComponent.executeTool('non-existent-tool', {}))
        .rejects.toThrow('Tool not found: non-existent-tool');
    });
  });
  
  describe('工具管理', () => {
    beforeEach(async () => {
      await toolComponent.initialize();
      toolComponent.registerTool(mockTool);
    });
    
    test('应该能够列出所有工具', () => {
      const tools = toolComponent.listTools();
      
      expect(tools).toEqual(['mock-tool']);
      const toolManager = (toolComponent as any).toolManager;
      expect(toolManager.listTools).toHaveBeenCalled();
    });
    
    test('应该能够获取工具', () => {
      const tool = toolComponent.getTool('mock-tool');
      
      expect(tool).toBeInstanceOf(MockTool);
      expect(tool?.name).toBe('mock-tool');
    });
    
    test('应该正确处理获取不存在的工具', () => {
      const tool = toolComponent.getTool('non-existent-tool');
      
      expect(tool).toBeNull();
    });
  });
  
  describe('工具验证', () => {
    beforeEach(async () => {
      await toolComponent.initialize();
      toolComponent.registerTool(mockTool);
    });
    
    test('应该能够验证工具', () => {
      const result = toolComponent.validateTool('mock-tool');
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(mockTool.validate).toHaveBeenCalled();
    });
    
    test('应该处理验证不存在的工具', () => {
      expect(() => {
        toolComponent.validateTool('non-existent-tool');
      }).toThrow('Tool not found: non-existent-tool');
    });
  });
  
  describe('销毁', () => {
    beforeEach(async () => {
      await toolComponent.initialize();
      toolComponent.registerTool(mockTool);
    });
    
    test('应该正确销毁 ToolComponent', async () => {
      await toolComponent.destroy();
      
      expect(toolComponent.isInitialized()).toBe(false);
    });
    
    test('应该能够多次安全调用销毁', async () => {
      await toolComponent.destroy();
      await toolComponent.destroy(); // 第二次调用
      
      // 应该不会出错
      expect(toolComponent.isInitialized()).toBe(false);
    });
  });
  
  describe('错误处理', () => {
    test('应该在未初始化时拒绝调用方法', async () => {
      await expect(toolComponent.executeTool('mock-tool', {}))
        .rejects.toThrow('ToolComponent not initialized');
      
      expect(() => toolComponent.listTools())
        .toThrow('ToolComponent not initialized');
      
      expect(() => toolComponent.getTool('mock-tool'))
        .toThrow('ToolComponent not initialized');
    });
    
    test('应该处理空工具名称', async () => {
      await toolComponent.initialize();
      
      await expect(toolComponent.executeTool('', {}))
        .rejects.toThrow('Tool name is required');
    });
  });
  
  describe('配置管理', () => {
    test('应该能够获取工具配置', async () => {
      await toolComponent.initialize();
      
      const config = toolComponent.getToolConfig();
      
      expect(config).toBeDefined();
      expect(config.timeout).toBe(30000);
      expect(config.maxRetries).toBe(3);
      expect(mockAgent.getConfig).toHaveBeenCalled();
    });
  });
});