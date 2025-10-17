/**
 * DeclarativeTool BDD 测试
 * 使用Given-When-Then模式组织测试用例
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DeclarativeTool } from '../../../../src/tools/base/DeclarativeTool.js';
import { ToolKind } from '../../../../src/tools/types/ToolTypes.js';

// 测试用的具体工具类
class TestTool extends DeclarativeTool {
  constructor() {
    super(
      'test_tool',
      '测试工具',
      '用于测试的声明式工具',
      ToolKind.Other,
      {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 50 },
          age: { type: 'number', minimum: 0, maximum: 150 },
          active: { type: 'boolean' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            minLength: 1,
            maxLength: 5,
          },
          config: {
            type: 'object',
            properties: {
              debug: { type: 'boolean' },
            },
          },
        },
        required: ['name', 'age'],
      },
      false,
      '1.0.0',
      'test',
      ['mock', 'validation']
    );
  }

  build(params: any) {
    // 使用内置验证方法
    const name = this.validateString(params.name, 'name', {
      required: true,
      minLength: 1,
      maxLength: 50,
    });
    const age = this.validateNumber(params.age, 'age', {
      required: true,
      min: 0,
      max: 150,
      integer: true,
    });
    const active = this.validateBoolean(params.active, 'active', false);
    const tags = this.validateArray(params.tags, 'tags', {
      minLength: 1,
      maxLength: 5,
      itemValidator: (item, index) => {
        if (typeof item !== 'string') {
          throw new Error(`标签[${index}]必须是字符串`);
        }
        return item;
      },
    });

    return {
      toolName: this.name,
      params: { name, age, active, tags },
      getDescription: () => `测试工具: ${name}`,
      getAffectedPaths: () => [],
      shouldConfirm: async () => null,
      execute: async () => ({
        success: true,
        llmContent: `执行成功: ${name}`,
        displayContent: `测试完成: ${name}`,
      }),
    };
  }
}

class PatternValidationTool extends DeclarativeTool {
  constructor() {
    super('pattern_tool', '模式验证工具', '测试正则表达式验证', ToolKind.Other, {
      type: 'object',
      properties: {
        email: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' },
        phone: { type: 'string', pattern: '^\\d{11}$' },
      },
      required: ['email'],
    });
  }

  build(params: any) {
    const email = this.validateString(params.email, 'email', {
      required: true,
      pattern: /^[^@]+@[^@]+\.[^@]+$/,
    });
    const phone = this.validateString(params.phone, 'phone', {
      pattern: /^\d{11}$/,
    });

    return {
      toolName: this.name,
      params: { email, phone },
      getDescription: () => `验证联系信息: ${email}`,
      getAffectedPaths: () => [],
      shouldConfirm: async () => null,
      execute: async () => ({
        success: true,
        llmContent: `验证通过`,
        displayContent: `联系信息有效`,
      }),
    };
  }
}

describe('DeclarativeTool', () => {
  let testTool: TestTool;
  let patternTool: PatternValidationTool;

  beforeEach(() => {
    // Arrange: 为每个测试准备新的工具实例
    testTool = new TestTool();
    patternTool = new PatternValidationTool();
  });

  describe('工具基础属性', () => {
    describe('当创建声明式工具时', () => {
      it('应该正确设置所有属性', () => {
        // Assert: 验证工具属性
        expect(testTool.name).toBe('test_tool');
        expect(testTool.displayName).toBe('测试工具');
        expect(testTool.description).toBe('用于测试的声明式工具');
        expect(testTool.kind).toBe(ToolKind.Other);
        expect(testTool.version).toBe('1.0.0');
        expect(testTool.category).toBe('test');
        expect(testTool.tags).toEqual(['mock', 'validation']);
      });

      it('应该生成正确的函数声明', () => {
        // Act: 获取函数声明
        const declaration = testTool.functionDeclaration;

        // Assert: 验证函数声明格式
        expect(declaration).toEqual({
          name: 'test_tool',
          description: '用于测试的声明式工具',
          parameters: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              name: expect.objectContaining({
                type: 'string',
                minLength: 1,
                maxLength: 50,
              }),
              age: expect.objectContaining({
                type: 'number',
                minimum: 0,
                maximum: 150,
              }),
            }),
            required: ['name', 'age'],
          }),
        });
      });

      it('应该正确处理参数模式的默认值', () => {
        // Assert: 验证参数模式被正确处理
        expect(testTool.parameterSchema.type).toBe('object');
        expect(testTool.parameterSchema.properties).toBeDefined();
      });
    });
  });

  describe('参数验证功能', () => {
    describe('字符串验证', () => {
      describe('当提供有效字符串参数时', () => {
        it('应该成功验证和构建工具调用', () => {
          // Arrange: 准备有效参数
          const params = {
            name: 'Alice',
            age: 25,
            active: true,
            tags: ['user', 'active'],
          };

          // Act: 构建工具调用
          const invocation = testTool.build(params);

          // Assert: 验证构建成功
          expect(invocation.toolName).toBe('test_tool');
          expect(invocation.params.name).toBe('Alice');
          expect(invocation.getDescription()).toBe('测试工具: Alice');
        });
      });

      describe('当字符串参数为空时', () => {
        it('应该抛出验证错误', () => {
          // Arrange: 准备空字符串参数
          const params = {
            name: '',
            age: 25,
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [name]: 长度不能少于1个字符');
        });
      });

      describe('当字符串参数过长时', () => {
        it('应该抛出验证错误', () => {
          // Arrange: 准备过长字符串
          const params = {
            name: 'a'.repeat(51), // 超过50字符限制
            age: 25,
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [name]: 长度不能超过50个字符');
        });
      });

      describe('当字符串参数类型错误时', () => {
        it('应该抛出类型错误', () => {
          // Arrange: 准备错误类型参数
          const params = {
            name: 123,
            age: 25,
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [name]: 参数必须是字符串类型');
        });
      });

      describe('当缺少必需字符串参数时', () => {
        it('应该抛出必需参数错误', () => {
          // Arrange: 准备缺少必需参数
          const params = {
            age: 25,
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [name]: 参数不能为空');
        });
      });
    });

    describe('数字验证', () => {
      describe('当提供有效数字参数时', () => {
        it('应该成功验证', () => {
          // Arrange: 准备有效参数
          const params = {
            name: 'Bob',
            age: 30,
          };

          // Act: 构建工具调用
          const invocation = testTool.build(params);

          // Assert: 验证成功
          expect(invocation.params.age).toBe(30);
        });
      });

      describe('当数字参数超出范围时', () => {
        it('应该抛出范围错误', () => {
          // Arrange: 准备超出范围的参数
          const params = {
            name: 'Charlie',
            age: 200, // 超过150的最大值
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [age]: 不能大于150');
        });
      });

      describe('当数字参数小于最小值时', () => {
        it('应该抛出范围错误', () => {
          // Arrange: 准备小于最小值的参数
          const params = {
            name: 'David',
            age: -5, // 小于0的最小值
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [age]: 不能小于0');
        });
      });

      describe('当数字参数不是整数时', () => {
        it('应该抛出整数错误', () => {
          // Arrange: 准备小数参数
          const params = {
            name: 'Eve',
            age: 25.5,
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [age]: 参数必须是整数');
        });
      });

      describe('当数字参数类型错误时', () => {
        it('应该抛出类型错误', () => {
          // Arrange: 准备错误类型参数
          const params = {
            name: 'Frank',
            age: 'twenty-five',
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [age]: 参数必须是数字类型');
        });
      });
    });

    describe('布尔值验证', () => {
      describe('当提供有效布尔参数时', () => {
        it('应该成功验证', () => {
          // Arrange: 准备有效参数
          const params = {
            name: 'Grace',
            age: 28,
            active: false,
          };

          // Act: 构建工具调用
          const invocation = testTool.build(params);

          // Assert: 验证成功
          expect(invocation.params.active).toBe(false);
        });
      });

      describe('当布尔参数类型错误时', () => {
        it('应该抛出类型错误', () => {
          // Arrange: 准备错误类型参数
          const params = {
            name: 'Henry',
            age: 32,
            active: 'yes',
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [active]: 参数必须是布尔类型');
        });
      });

      describe('当缺少可选布尔参数时', () => {
        it('应该使用默认值false', () => {
          // Arrange: 准备参数（省略active）
          const params = {
            name: 'Ivy',
            age: 24,
          };

          // Act: 构建工具调用
          const invocation = testTool.build(params);

          // Assert: 验证默认值
          expect(invocation.params.active).toBe(false);
        });
      });
    });

    describe('数组验证', () => {
      describe('当提供有效数组参数时', () => {
        it('应该成功验证', () => {
          // Arrange: 准备有效参数
          const params = {
            name: 'Jack',
            age: 29,
            tags: ['developer', 'javascript'],
          };

          // Act: 构建工具调用
          const invocation = testTool.build(params);

          // Assert: 验证成功
          expect(invocation.params.tags).toEqual(['developer', 'javascript']);
        });
      });

      describe('当数组长度超出限制时', () => {
        it('应该抛出长度错误', () => {
          // Arrange: 准备超长数组
          const params = {
            name: 'Kate',
            age: 26,
            tags: ['a', 'b', 'c', 'd', 'e', 'f'], // 超过5个元素
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [tags]: 数组长度不能超过5');
        });
      });

      describe('当数组为空但需要最小长度时', () => {
        it('应该抛出长度错误', () => {
          // Arrange: 准备空数组
          const params = {
            name: 'Leo',
            age: 31,
            tags: [],
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [tags]: 数组长度不能少于1');
        });
      });

      describe('当数组元素类型错误时', () => {
        it('应该抛出元素验证错误', () => {
          // Arrange: 准备包含错误类型元素的数组
          const params = {
            name: 'Mia',
            age: 27,
            tags: ['valid', 123, 'also-valid'], // 包含数字元素
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('标签[1]必须是字符串');
        });
      });

      describe('当数组参数类型错误时', () => {
        it('应该抛出类型错误', () => {
          // Arrange: 准备非数组参数
          const params = {
            name: 'Noah',
            age: 33,
            tags: 'not-an-array',
          };

          // Act & Assert: 验证失败
          expect(() => {
            testTool.build(params);
          }).toThrow('参数验证失败 [tags]: 参数必须是数组类型');
        });
      });
    });

    describe('正则表达式验证', () => {
      describe('当提供符合模式的字符串时', () => {
        it('应该成功验证邮箱格式', () => {
          // Arrange: 准备有效邮箱
          const params = {
            email: 'test@example.com',
            phone: '13800138000',
          };

          // Act: 构建工具调用
          const invocation = patternTool.build(params);

          // Assert: 验证成功
          expect(invocation.params.email).toBe('test@example.com');
          expect(invocation.params.phone).toBe('13800138000');
        });
      });

      describe('当字符串不符合模式时', () => {
        it('应该抛出格式错误', () => {
          // Arrange: 准备无效邮箱
          const params = {
            email: 'invalid-email',
          };

          // Act & Assert: 验证失败
          expect(() => {
            patternTool.build(params);
          }).toThrow('参数验证失败 [email]: 格式不符合要求');
        });
      });

      describe('当手机号格式错误时', () => {
        it('应该抛出格式错误', () => {
          // Arrange: 准备无效手机号
          const params = {
            email: 'valid@example.com',
            phone: '123', // 不是11位数字
          };

          // Act & Assert: 验证失败
          expect(() => {
            patternTool.build(params);
          }).toThrow('参数验证失败 [phone]: 格式不符合要求');
        });
      });
    });
  });

  describe('工具元信息功能', () => {
    describe('当获取工具元信息时', () => {
      it('应该返回完整的元数据', () => {
        // Act: 获取元信息
        const metadata = testTool.getMetadata();

        // Assert: 验证元信息
        expect(metadata).toEqual({
          name: 'test_tool',
          displayName: '测试工具',
          description: '用于测试的声明式工具',
          kind: ToolKind.Other,
          version: '1.0.0',
          category: 'test',
          tags: ['mock', 'validation'],
          parameterSchema: expect.any(Object),
        });
      });
    });

    describe('当获取使用示例时', () => {
      it('应该返回示例列表（默认为空）', () => {
        // Act: 获取示例
        const examples = testTool.getExamples();

        // Assert: 验证示例
        expect(examples).toEqual([]);
      });
    });
  });

  describe('一键执行功能', () => {
    describe('当使用execute方法时', () => {
      it('应该自动构建并执行工具调用', async () => {
        // Arrange: 准备有效参数
        const params = {
          name: 'Quinn',
          age: 35,
        };

        // Act: 一键执行
        const result = await testTool.execute(params);

        // Assert: 验证执行结果
        expect(result.success).toBe(true);
        expect(result.llmContent).toBe('执行成功: Quinn');
        expect(result.displayContent).toBe('测试完成: Quinn');
      });

      it('应该支持传入中止信号', async () => {
        // Arrange: 准备参数和中止控制器
        const params = {
          name: 'Ruby',
          age: 28,
        };
        const controller = new AbortController();

        // Act: 传入中止信号执行
        const resultPromise = testTool.execute(params, controller.signal);

        // 立即中止
        controller.abort();

        // Assert: 执行应该被中止（在这个简单示例中会正常完成，但信号已传递）
        const result = await resultPromise;
        expect(result.success).toBe(true);
      });
    });
  });

  describe('错误处理和边界情况', () => {
    describe('当参数完全缺失时', () => {
      it('应该抛出明确的错误', () => {
        // Act & Assert: 验证错误处理
        expect(() => {
          testTool.build(null);
        }).toThrow('参数验证失败');
      });
    });

    describe('当参数为undefined时', () => {
      it('应该抛出明确的错误', () => {
        // Act & Assert: 验证错误处理
        expect(() => {
          testTool.build(undefined);
        }).toThrow('参数验证失败');
      });
    });

    describe('当参数为空对象时', () => {
      it('应该抛出缺少必需参数的错误', () => {
        // Act & Assert: 验证错误处理
        expect(() => {
          testTool.build({});
        }).toThrow('参数验证失败 [name]: 参数不能为空');
      });
    });

    describe('当创建验证错误时', () => {
      it('应该包含详细的错误信息', () => {
        // Arrange: 准备会触发验证错误的参数
        const params = {
          name: '',
          age: 25,
        };

        // Act & Assert: 验证错误信息格式
        expect(() => {
          testTool.build(params);
        }).toThrow(/参数验证失败 \[name\]: .* \(当前值: \)/);
      });
    });
  });

  describe('复杂验证场景', () => {
    describe('当同时验证多个参数时', () => {
      it('应该在第一个错误处停止', () => {
        // Arrange: 准备多个错误参数
        const params = {
          name: '', // 第一个错误：空字符串
          age: -10, // 第二个错误：负数
        };

        // Act & Assert: 应该只报告第一个错误
        expect(() => {
          testTool.build(params);
        }).toThrow('参数验证失败 [name]');
      });
    });

    describe('当验证可选参数时', () => {
      it('应该允许省略可选参数', () => {
        // Arrange: 准备只包含必需参数的数据
        const params = {
          name: 'Sam',
          age: 40,
        };

        // Act: 构建工具调用
        const invocation = testTool.build(params);

        // Assert: 验证可选参数被正确处理
        expect(invocation.params.active).toBe(false); // 布尔默认值
        expect(invocation.params.tags).toEqual([]); // 数组默认值
      });
    });
  });
});
