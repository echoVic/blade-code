/**
 * ToolRegistry BDD 测试
 * 使用Given-When-Then模式组织测试用例
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclarativeTool } from '../../../../src/tools/base/DeclarativeTool.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import { ToolKind } from '../../../../src/tools/types/ToolTypes.js';

// 测试用的Mock工具
class MockReadTool extends DeclarativeTool {
  constructor() {
    super(
      'mock_read',
      '模拟读取工具',
      '用于测试的模拟读取工具',
      ToolKind.Read,
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
      false,
      '1.0.0',
      'file',
      ['test', 'mock']
    );
  }

  build(params: any) {
    return {
      toolName: this.name,
      params,
      getDescription: () => `读取文件: ${params.path}`,
      getAffectedPaths: () => [params.path],
      execute: async () => ({
        success: true,
        llmContent: `文件内容: ${params.path}`,
        displayContent: `已读取: ${params.path}`,
      }),
    };
  }
}

class MockEditTool extends DeclarativeTool {
  constructor() {
    super(
      'mock_edit',
      '模拟编辑工具',
      '用于测试的模拟编辑工具',
      ToolKind.Edit,
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      true,
      '1.0.0',
      'file',
      ['test', 'mock']
    );
  }

  build(params: any) {
    return {
      toolName: this.name,
      params,
      getDescription: () => `编辑文件: ${params.path}`,
      getAffectedPaths: () => [params.path],
      execute: async () => ({
        success: true,
        llmContent: `已编辑: ${params.path}`,
        displayContent: `文件已更新: ${params.path}`,
      }),
    };
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  let mockReadTool: MockReadTool;
  let mockEditTool: MockEditTool;

  beforeEach(() => {
    // Arrange: 每个测试开始前准备新的注册表实例
    registry = new ToolRegistry();
    mockReadTool = new MockReadTool();
    mockEditTool = new MockEditTool();
  });

  describe('工具注册功能', () => {
    describe('当注册一个新工具时', () => {
      it('应该成功注册并触发事件', () => {
        // Arrange: 准备事件监听器
        const eventSpy = vi.fn();
        registry.on('toolRegistered', eventSpy);

        // Act: 注册工具
        registry.register(mockReadTool);

        // Assert: 验证注册成功和事件触发
        expect(registry.has('mock_read')).toBe(true);
        expect(registry.get('mock_read')).toBe(mockReadTool);
        expect(eventSpy).toHaveBeenCalledWith({
          type: 'builtin',
          tool: mockReadTool,
          timestamp: expect.any(Number),
        });
      });

      it('应该正确更新分类和标签索引', () => {
        // Act: 注册工具
        registry.register(mockReadTool);

        // Assert: 验证索引更新
        expect(registry.getByCategory('file')).toContain(mockReadTool);
        expect(registry.getByTag('test')).toContain(mockReadTool);
        expect(registry.getByTag('mock')).toContain(mockReadTool);
      });
    });

    describe('当尝试注册重复工具时', () => {
      it('应该抛出错误', () => {
        // Arrange: 先注册一个工具
        registry.register(mockReadTool);

        // Act & Assert: 尝试重复注册应该抛出错误
        expect(() => {
          registry.register(mockReadTool);
        }).toThrow("工具 'mock_read' 已注册");
      });
    });

    describe('当批量注册工具时', () => {
      it('应该成功注册所有工具', () => {
        // Act: 批量注册
        registry.registerAll([mockReadTool, mockEditTool]);

        // Assert: 验证所有工具都已注册
        expect(registry.has('mock_read')).toBe(true);
        expect(registry.has('mock_edit')).toBe(true);
        expect(registry.getAll()).toHaveLength(2);
      });

      it('当部分工具注册失败时应该抛出详细错误', () => {
        // Arrange: 先注册一个工具造成冲突
        registry.register(mockReadTool);

        // Act & Assert: 批量注册包含重复工具应该失败
        expect(() => {
          registry.registerAll([mockReadTool, mockEditTool]);
        }).toThrow(/批量注册失败.*mock_read.*已注册/);
      });
    });
  });

  describe('工具查询功能', () => {
    beforeEach(() => {
      // Arrange: 注册测试工具
      registry.register(mockReadTool);
      registry.register(mockEditTool);
    });

    describe('当按名称查询工具时', () => {
      it('应该返回正确的工具', () => {
        // Act & Assert
        expect(registry.get('mock_read')).toBe(mockReadTool);
        expect(registry.get('mock_edit')).toBe(mockEditTool);
        expect(registry.get('nonexistent')).toBeUndefined();
      });
    });

    describe('当按分类查询工具时', () => {
      it('应该返回该分类下的所有工具', () => {
        // Act
        const fileTools = registry.getByCategory('file');

        // Assert
        expect(fileTools).toHaveLength(2);
        expect(fileTools).toContain(mockReadTool);
        expect(fileTools).toContain(mockEditTool);
      });

      it('当查询不存在的分类时应该返回空数组', () => {
        // Act & Assert
        expect(registry.getByCategory('nonexistent')).toEqual([]);
      });
    });

    describe('当按标签查询工具时', () => {
      it('应该返回包含该标签的所有工具', () => {
        // Act
        const testTools = registry.getByTag('test');

        // Assert
        expect(testTools).toHaveLength(2);
        expect(testTools).toContain(mockReadTool);
        expect(testTools).toContain(mockEditTool);
      });

      it('当查询不存在的标签时应该返回空数组', () => {
        // Act & Assert
        expect(registry.getByTag('nonexistent')).toEqual([]);
      });
    });

    describe('当搜索工具时', () => {
      it('应该按名称搜索返回匹配的工具', () => {
        // Act
        const results = registry.search('read');

        // Assert
        expect(results).toHaveLength(1);
        expect(results[0]).toBe(mockReadTool);
      });

      it('应该按描述搜索返回匹配的工具', () => {
        // Act
        const results = registry.search('编辑');

        // Assert
        expect(results).toHaveLength(1);
        expect(results[0]).toBe(mockEditTool);
      });

      it('应该按标签搜索返回匹配的工具', () => {
        // Act
        const results = registry.search('mock');

        // Assert
        expect(results).toHaveLength(2);
        expect(results).toContain(mockReadTool);
        expect(results).toContain(mockEditTool);
      });

      it('当搜索无匹配结果时应该返回空数组', () => {
        // Act & Assert
        expect(registry.search('xyz')).toEqual([]);
      });

      it('应该忽略大小写进行搜索', () => {
        // Act
        const results = registry.search('READ');

        // Assert
        expect(results).toHaveLength(1);
        expect(results[0]).toBe(mockReadTool);
      });
    });
  });

  describe('工具注销功能', () => {
    beforeEach(() => {
      // Arrange: 注册测试工具
      registry.register(mockReadTool);
      registry.register(mockEditTool);
    });

    describe('当注销已存在的工具时', () => {
      it('应该成功注销并触发事件', () => {
        // Arrange: 准备事件监听器
        const eventSpy = vi.fn();
        registry.on('toolUnregistered', eventSpy);

        // Act: 注销工具
        const result = registry.unregister('mock_read');

        // Assert: 验证注销成功
        expect(result).toBe(true);
        expect(registry.has('mock_read')).toBe(false);
        expect(registry.get('mock_read')).toBeUndefined();
        expect(eventSpy).toHaveBeenCalledWith({
          type: 'builtin',
          toolName: 'mock_read',
          timestamp: expect.any(Number),
        });
      });

      it('应该正确更新索引', () => {
        // Act: 注销工具
        registry.unregister('mock_read');

        // Assert: 验证索引更新
        expect(registry.getByCategory('file')).not.toContain(mockReadTool);
        expect(registry.getByCategory('file')).toContain(mockEditTool);
        expect(registry.getByTag('test')).not.toContain(mockReadTool);
        expect(registry.getByTag('test')).toContain(mockEditTool);
      });
    });

    describe('当注销不存在的工具时', () => {
      it('应该返回false', () => {
        // Act & Assert
        expect(registry.unregister('nonexistent')).toBe(false);
      });
    });
  });

  describe('函数声明生成', () => {
    beforeEach(() => {
      // Arrange: 注册测试工具
      registry.register(mockReadTool);
      registry.register(mockEditTool);
    });

    describe('当获取LLM函数声明时', () => {
      it('应该返回所有工具的函数声明', () => {
        // Act
        const declarations = registry.getFunctionDeclarations();

        // Assert
        expect(declarations).toHaveLength(2);

        const readDeclaration = declarations.find((d) => d.name === 'mock_read');
        expect(readDeclaration).toEqual({
          name: 'mock_read',
          description: '用于测试的模拟读取工具',
          parameters: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              path: expect.objectContaining({
                type: 'string',
                description: '文件路径',
              }),
            }),
            required: ['path'],
          }),
        });
      });
    });
  });

  describe('统计信息', () => {
    beforeEach(() => {
      // Arrange: 注册测试工具
      registry.register(mockReadTool);
      registry.register(mockEditTool);
    });

    describe('当获取注册表统计时', () => {
      it('应该返回正确的统计信息', () => {
        // Act
        const stats = registry.getStats();

        // Assert
        expect(stats).toEqual({
          totalTools: 2,
          builtinTools: 2,
          mcpTools: 0,
          categories: 1,
          tags: 2,
          toolsByCategory: {
            file: 2,
          },
        });
      });
    });

    describe('当获取分类列表时', () => {
      it('应该返回所有分类', () => {
        // Act & Assert
        expect(registry.getCategories()).toContain('file');
        expect(registry.getCategories()).toHaveLength(1);
      });
    });

    describe('当获取标签列表时', () => {
      it('应该返回所有标签', () => {
        // Act
        const tags = registry.getTags();

        // Assert
        expect(tags).toContain('test');
        expect(tags).toContain('mock');
        expect(tags).toHaveLength(2);
      });
    });
  });

  describe('边界情况和错误处理', () => {
    describe('当在空注册表上进行操作时', () => {
      it('查询操作应该返回合适的默认值', () => {
        // Act & Assert
        expect(registry.getAll()).toEqual([]);
        expect(registry.getCategories()).toEqual([]);
        expect(registry.getTags()).toEqual([]);
        expect(registry.getFunctionDeclarations()).toEqual([]);
        expect(registry.search('anything')).toEqual([]);
      });
    });

    describe('当工具没有分类或标签时', () => {
      it('应该正常处理', () => {
        // Arrange: 创建没有分类和标签的工具
        const noMetaTool = new (class extends DeclarativeTool {
          constructor() {
            super('no_meta', '无元数据工具', '测试工具', ToolKind.Other, {
              type: 'object',
            });
          }
          build() {
            return {} as any;
          }
        })();

        // Act: 注册工具
        registry.register(noMetaTool);

        // Assert: 验证处理正常
        expect(registry.has('no_meta')).toBe(true);
        expect(registry.getByCategory('')).toEqual([]);
        expect(registry.getTags()).toEqual([]);
      });
    });
  });
});
