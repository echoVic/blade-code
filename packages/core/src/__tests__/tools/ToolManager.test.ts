/**
 * ToolManager 单元测试
 */

import { ToolManager } from '../ToolManager.js';
import { BaseTool } from '../base/ConfirmableToolBase.js';

// 模拟工具实现
class MockTool extends BaseTool {
  name = 'mock-tool';
  description = 'A mock tool for testing';
  category = 'test';
  
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
  
  confirm = jest.fn().mockResolvedValue(true);
}

class AnotherMockTool extends BaseTool {
  name = 'another-mock-tool';
  description = 'Another mock tool for testing';
  category = 'test';
  
  execute = jest.fn().mockResolvedValue({
    success: true,
    result: 'Another mock tool executed successfully'
  });
  
  validate = jest.fn().mockReturnValue({
    valid: true,
    errors: []
  });
  
  getSchema = jest.fn().mockReturnValue({
    type: 'object',
    properties: {
      value: { type: 'number' }
    }
  });
  
  confirm = jest.fn().mockResolvedValue(true);
}

describe('ToolManager', () => {
  let toolManager: ToolManager;
  let mockTool: MockTool;
  let anotherMockTool: AnotherMockTool;
  
  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();
    
    // 创建新的 ToolManager 实例
    toolManager = new ToolManager();
    
    // 创建 mock tool 实例
    mockTool = new MockTool();
    anotherMockTool = new AnotherMockTool();
  });
  
  afterEach(() => {
    // 清理 toolManager
    if (toolManager) {
      toolManager.destroy();
    }
  });
  
  describe('初始化', () => {
    test('应该成功创建 ToolManager 实例', () => {
      expect(toolManager).toBeInstanceOf(ToolManager);
    });
    
    test('应该初始化空的工具集合', () => {
      const tools = toolManager.listTools();
      expect(tools).toEqual([]);
    });
  });
  
  describe('工具注册', () => {
    test('应该能够注册工具', () => {
      const result = toolManager.registerTool(mockTool);
      
      expect(result).toBe(true);
      const tools = toolManager.listTools();
      expect(tools).toContain('mock-tool');
    });
    
    test('应该防止重复注册工具', () => {
      toolManager.registerTool(mockTool);
      const result = toolManager.registerTool(mockTool); // 重复注册
      
      expect(result).toBe(false); // 应该返回 false 表示注册失败
      const tools = toolManager.listTools();
      expect(tools).toHaveLength(1); // 应该只注册一次
    });
    
    test('应该验证工具必须有名称', () => {
      const invalidTool = new MockTool();
      (invalidTool as any).name = ''; // 清空名称
      
      expect(() => toolManager.registerTool(invalidTool))
        .toThrow('Tool must have a name');
    });
    
    test('应该验证工具名称必须唯一', () => {
      const tool1 = new MockTool();
      const tool2 = new MockTool(); // 相同名称
      
      toolManager.registerTool(tool1);
      expect(() => toolManager.registerTool(tool2))
        .toThrow('Tool with name "mock-tool" already registered');
    });
  });
  
  describe('工具获取', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
      toolManager.registerTool(anotherMockTool);
    });
    
    test('应该能够通过名称获取工具', () => {
      const tool = toolManager.getTool('mock-tool');
      
      expect(tool).toBeInstanceOf(MockTool);
      expect(tool?.name).toBe('mock-tool');
    });
    
    test('应该返回 null 对于不存在的工具', () => {
      const tool = toolManager.getTool('non-existent-tool');
      
      expect(tool).toBeNull();
    });
    
    test('应该能够列出所有工具', () => {
      const tools = toolManager.listTools();
      
      expect(tools).toHaveLength(2);
      expect(tools).toContain('mock-tool');
      expect(tools).toContain('another-mock-tool');
    });
    
    test('应该能够按分类列出工具', () => {
      const tools = toolManager.listToolsByCategory('test');
      
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name)).toEqual(['mock-tool', 'another-mock-tool']);
    });
    
    test('应该返回空数组对于不存在的分类', () => {
      const tools = toolManager.listToolsByCategory('non-existent');
      
      expect(tools).toHaveLength(0);
    });
  });
  
  describe('工具执行', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
    });
    
    test('应该能够执行工具', async () => {
      const result = await toolManager.executeTool('mock-tool', { input: 'test' });
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.result).toBe('Mock tool executed successfully');
      expect(mockTool.execute).toHaveBeenCalledWith({ input: 'test' });
    });
    
    test('应该传递执行选项', async () => {
      const options = {
        timeout: 5000,
        confirm: true,
        retries: 3
      };
      
      await toolManager.executeTool('mock-tool', { input: 'test' }, options);
      
      expect(mockTool.execute).toHaveBeenCalledWith({ input: 'test' });
    });
    
    test('应该在执行不存在的工具时抛出错误', async () => {
      await expect(toolManager.executeTool('non-existent-tool', {}))
        .rejects.toThrow('Tool not found: non-existent-tool');
    });
    
    test('应该处理工具执行错误', async () => {
      mockTool.execute.mockRejectedValueOnce(new Error('Tool Execution Error'));
      
      await expect(toolManager.executeTool('mock-tool', { input: 'test' }))
        .rejects.toThrow('Tool Execution Error');
    });
    
    test('应该处理工具执行失败', async () => {
      mockTool.execute.mockResolvedValueOnce({
        success: false,
        error: 'Tool execution failed'
      });
      
      const result = await toolManager.executeTool('mock-tool', { input: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Tool execution failed');
    });
  });
  
  describe('工具验证', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
    });
    
    test('应该能够验证工具', () => {
      const result = toolManager.validateTool('mock-tool');
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(mockTool.validate).toHaveBeenCalled();
    });
    
    test('应该处理不存在工具的验证', () => {
      expect(() => toolManager.validateTool('non-existent-tool'))
        .toThrow('Tool not found: non-existent-tool');
    });
    
    test('应该处理工具验证错误', () => {
      mockTool.validate.mockImplementationOnce(() => {
        throw new Error('Validation Error');
      });
      
      const result = toolManager.validateTool('mock-tool');
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Validation Error');
    });
  });
  
  describe('工具移除', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
    });
    
    test('应该能够移除工具', () => {
      const result = toolManager.unregisterTool('mock-tool');
      
      expect(result).toBe(true);
      const tools = toolManager.listTools();
      expect(tools).toHaveLength(0);
    });
    
    test('应该处理移除不存在的工具', () => {
      const result = toolManager.unregisterTool('non-existent-tool');
      
      expect(result).toBe(false);
    });
  });
  
  describe('工具配置', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
    });
    
    test('应该能够获取工具配置', () => {
      const config = toolManager.getToolConfig('mock-tool');
      
      expect(config).toBeDefined();
      expect(config.timeout).toBe(30000); // 默认值
      expect(config.maxRetries).toBe(3); // 默认值
    });
    
    test('应该能够更新工具配置', () => {
      toolManager.updateToolConfig('mock-tool', {
        timeout: 60000,
        maxRetries: 5
      });
      
      const config = toolManager.getToolConfig('mock-tool');
      expect(config.timeout).toBe(60000);
      expect(config.maxRetries).toBe(5);
    });
    
    test('应该处理更新不存在工具的配置', () => {
      expect(() => toolManager.updateToolConfig('non-existent-tool', {}))
        .toThrow('Tool not found: non-existent-tool');
    });
  });
  
  describe('销毁', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
    });
    
    test('应该正确销毁 ToolManager', () => {
      toolManager.destroy();
      
      const tools = toolManager.listTools();
      expect(tools).toHaveLength(0);
    });
    
    test('应该能够多次安全调用销毁', () => {
      toolManager.destroy();
      toolManager.destroy(); // 第二次调用
      
      // 应该不会出错
      const tools = toolManager.listTools();
      expect(tools).toHaveLength(0);
    });
  });
  
  describe('错误处理', () => {
    test('应该处理空工具名称', async () => {
      await expect(toolManager.executeTool('', {}))
        .rejects.toThrow('Tool name is required');
      
      expect(() => toolManager.getTool(''))
        .toThrow('Tool name is required');
    });
    
    test('应该处理无效的工具参数', async () => {
      toolManager.registerTool(mockTool);
      
      await expect(toolManager.executeTool('mock-tool', null as any))
        .rejects.toThrow('Invalid tool parameters');
    });
  });
  
  describe('批量操作', () => {
    beforeEach(() => {
      toolManager.registerTool(mockTool);
      toolManager.registerTool(anotherMockTool);
    });
    
    test('应该能够批量执行工具', async () => {
      const results = await toolManager.executeTools([
        { name: 'mock-tool', params: { input: 'test1' } },
        { name: 'another-mock-tool', params: { value: 42 } }
      ]);
      
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockTool.execute).toHaveBeenCalledWith({ input: 'test1' });
      expect(anotherMockTool.execute).toHaveBeenCalledWith({ value: 42 });
    });
    
    test('应该处理批量执行中的错误', async () => {
      mockTool.execute.mockRejectedValueOnce(new Error('First tool error'));
      
      const results = await toolManager.executeTools([
        { name: 'mock-tool', params: { input: 'test1' } },
        { name: 'another-mock-tool', params: { value: 42 } }
      ]);
      
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });
  });
});