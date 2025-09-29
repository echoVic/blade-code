/**
 * 工具系统集成测试
 */

import { BaseTool } from '../../packages/core/src/tools/base/ConfirmableToolBase';
import { ToolManager } from '../../packages/core/src/tools/ToolManager';

// 测试工具实现
class TestTool extends BaseTool {
  name = 'test-tool';
  description = 'A test tool for integration testing';
  category = 'test';

  execute = jest.fn().mockResolvedValue({
    success: true,
    result: 'Test tool executed successfully',
  });

  validate = jest.fn().mockReturnValue({
    valid: true,
    errors: [],
  });

  getSchema = jest.fn().mockReturnValue({
    type: 'object',
    properties: {
      input: { type: 'string' },
    },
  });
}

class AnotherTestTool extends BaseTool {
  name = 'another-test-tool';
  description = 'Another test tool for integration testing';
  category = 'test';

  execute = jest.fn().mockResolvedValue({
    success: true,
    result: 'Another test tool executed successfully',
  });

  validate = jest.fn().mockReturnValue({
    valid: true,
    errors: [],
  });

  getSchema = jest.fn().mockReturnValue({
    type: 'object',
    properties: {
      value: { type: 'number' },
    },
  });
}

describe('工具系统集成测试', () => {
  let toolManager: ToolManager;
  let testTool: TestTool;
  let anotherTestTool: AnotherTestTool;

  beforeAll(async () => {
    jest.setTimeout(30000);
  });

  beforeEach(() => {
    toolManager = new ToolManager();
    testTool = new TestTool();
    anotherTestTool = new AnotherTestTool();

    // 注册测试工具
    toolManager.registerTool(testTool);
    toolManager.registerTool(anotherTestTool);
  });

  afterEach(() => {
    if (toolManager) {
      toolManager.destroy();
    }
  });

  describe('工具注册集成', () => {
    test('应该能够注册和管理多个工具', () => {
      const tools = toolManager.listTools();
      expect(tools).toHaveLength(2);
      expect(tools).toContain('test-tool');
      expect(tools).toContain('another-test-tool');
    });

    test('应该能够按分类管理工具', () => {
      const testTools = toolManager.listToolsByCategory('test');
      expect(testTools).toHaveLength(2);
      expect(testTools.map((t) => t.name)).toEqual(['test-tool', 'another-test-tool']);
    });

    test('应该防止重复注册工具', () => {
      const result = toolManager.registerTool(testTool); // 重复注册
      expect(result).toBe(false);

      const tools = toolManager.listTools();
      expect(tools).toHaveLength(2); // 数量应该不变
    });
  });

  describe('工具执行集成', () => {
    test('应该能够执行单个工具', async () => {
      const result = await toolManager.executeTool('test-tool', { input: 'test' });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.result).toBe('Test tool executed successfully');
      expect(testTool.execute).toHaveBeenCalledWith({ input: 'test' });
    });

    test('应该能够批量执行工具', async () => {
      const results = await toolManager.executeTools([
        { name: 'test-tool', params: { input: 'first' } },
        { name: 'another-test-tool', params: { value: 42 } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(testTool.execute).toHaveBeenCalledWith({ input: 'first' });
      expect(anotherTestTool.execute).toHaveBeenCalledWith({ value: 42 });
    });

    test('应该正确处理工具执行失败', async () => {
      // 模拟工具执行失败
      testTool.execute.mockResolvedValueOnce({
        success: false,
        error: 'Tool execution failed',
      });

      const result = await toolManager.executeTool('test-tool', { input: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tool execution failed');
    });

    test('应该正确处理工具执行异常', async () => {
      // 模拟工具执行抛出异常
      testTool.execute.mockRejectedValueOnce(new Error('Tool crashed'));

      await expect(
        toolManager.executeTool('test-tool', { input: 'test' })
      ).rejects.toThrow('Tool crashed');
    });
  });

  describe('工具验证集成', () => {
    test('应该能够验证工具配置', () => {
      const result = toolManager.validateTool('test-tool');

      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(testTool.validate).toHaveBeenCalled();
    });

    test('应该正确处理无效工具', () => {
      testTool.validate.mockReturnValueOnce({
        valid: false,
        errors: ['Invalid configuration'],
      });

      const result = toolManager.validateTool('test-tool');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid configuration');
    });
  });

  describe('工具配置集成', () => {
    test('应该能够获取和更新工具配置', () => {
      // 获取默认配置
      const defaultConfig = toolManager.getToolConfig('test-tool');
      expect(defaultConfig).toBeDefined();
      expect(defaultConfig.timeout).toBe(30000); // 默认值

      // 更新配置
      toolManager.updateToolConfig('test-tool', {
        timeout: 60000,
        maxRetries: 5,
      });

      // 验证配置更新
      const updatedConfig = toolManager.getToolConfig('test-tool');
      expect(updatedConfig.timeout).toBe(60000);
      expect(updatedConfig.maxRetries).toBe(5);
    });

    test('应该能够为不同工具设置不同配置', () => {
      toolManager.updateToolConfig('test-tool', {
        timeout: 30000,
      });

      toolManager.updateToolConfig('another-test-tool', {
        timeout: 60000,
      });

      const testToolConfig = toolManager.getToolConfig('test-tool');
      const anotherToolConfig = toolManager.getToolConfig('another-test-tool');

      expect(testToolConfig.timeout).toBe(30000);
      expect(anotherToolConfig.timeout).toBe(60000);
    });
  });

  describe('性能集成', () => {
    test('应该在合理时间内注册大量工具', () => {
      const startTime = Date.now();

      // 注册大量工具
      const tools = Array.from({ length: 50 }, (_, i) => {
        class DynamicTool extends BaseTool {
          name = `dynamic-tool-${i}`;
          description = `Dynamic tool ${i}`;
          category = 'dynamic';

          execute = jest
            .fn()
            .mockResolvedValue({ success: true, result: `Result ${i}` });
          validate = jest.fn().mockReturnValue({ valid: true, errors: [] });
          getSchema = jest.fn().mockReturnValue({ type: 'object' });
        }

        return new DynamicTool();
      });

      tools.forEach((tool) => toolManager.registerTool(tool));

      const endTime = Date.now();
      const registerTime = endTime - startTime;

      // 注册50个工具应该在1秒内完成
      expect(registerTime).toBeLessThan(1000);

      const allTools = toolManager.listTools();
      expect(allTools).toHaveLength(52); // 原来的2个 + 新增的50个
    });

    test('应该能够并发执行多个工具', async () => {
      // 创建并发执行的工具调用
      const promises = Array.from({ length: 10 }, (_, i) =>
        toolManager.executeTool('test-tool', { input: `concurrent-${i}` })
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.success).toBe(true);
      });
    });
  });

  describe('错误处理集成', () => {
    test('应该在工具注册失败时正确处理', () => {
      // 创建一个无效的工具（没有名称）
      class InvalidTool extends BaseTool {
        name = '';
        description = 'Invalid tool';
        category = 'invalid';

        execute = jest.fn();
        validate = jest.fn();
        getSchema = jest.fn();
      }

      const invalidTool = new InvalidTool();

      expect(() => toolManager.registerTool(invalidTool)).toThrow(
        'Tool must have a name'
      );
    });

    test('应该在执行不存在的工具时正确处理', async () => {
      await expect(toolManager.executeTool('non-existent-tool', {})).rejects.toThrow(
        'Tool not found: non-existent-tool'
      );
    });

    test('应该在批量执行中正确处理部分失败', async () => {
      // 模拟一个工具执行失败
      testTool.execute.mockResolvedValueOnce({
        success: false,
        error: 'Partial failure',
      });

      const results = await toolManager.executeTools([
        { name: 'test-tool', params: { input: 'should-fail' } },
        { name: 'another-test-tool', params: { value: 42 } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });
  });
});
