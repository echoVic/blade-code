/**
 * PermissionChecker 单元测试
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PermissionChecker,
  PermissionResult,
  type ToolInvocationDescriptor,
} from '../../../src/config/PermissionChecker.js';
import type { PermissionConfig } from '../../../src/config/types.js';

// Mock 工具实例，用于测试完整签名生成
const createMockTool = (extractFn: (params: Record<string, unknown>) => string) => ({
  extractSignatureContent: extractFn,
  abstractPermissionRule: (params: Record<string, unknown>) => {
    const content = extractFn(params);
    return content ? `${content.split(':')[0]}:*` : '';
  },
});

// 常用的 mock 工具
const mockReadTool = createMockTool((params) => {
  const filePath = params.file_path as string;
  return filePath ? `file_path:${filePath}` : '';
});

const mockWriteTool = createMockTool((params) => {
  const filePath = params.file_path as string;
  return filePath ? `file_path:${filePath}` : '';
});

const mockBashTool = createMockTool((params) => {
  const command = params.command as string;
  return command ? `command:${command}` : '';
});

describe('PermissionChecker', () => {
  let config: PermissionConfig;
  let checker: PermissionChecker;

  beforeEach(() => {
    config = {
      allow: [],
      ask: [],
      deny: [],
    };
    checker = new PermissionChecker(config);
  });

  describe('精确匹配', () => {
    it('应该精确匹配工具调用签名 - allow', () => {
      config.allow = ['Read(file_path:test.txt)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'test.txt' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.matchType).toBe('exact');
    });

    it('应该精确匹配工具调用签名 - deny', () => {
      config.deny = ['Read(file_path:.env)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: '.env' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.DENY);
      expect(result.matchType).toBe('exact');
    });
  });

  describe('前缀匹配', () => {
    it('应该匹配工具名称（不提供tool实例时为精确匹配）', () => {
      config.allow = ['Read'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'any-file.txt' },
        // 不提供 tool 实例，签名将是 'Read'，与规则 'Read' 精确匹配
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.matchType).toBe('exact'); // 签名 'Read' === 规则 'Read'
    });

    it('应该拒绝不匹配工具名的调用', () => {
      config.allow = ['Write'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'test.txt' },
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ASK); // 默认 ASK
    });
  });

  describe('通配符匹配', () => {
    it('应该匹配单星号通配符', () => {
      config.deny = ['Read(file_path:*.env)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'production.env' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.DENY);
      expect(result.matchType).toBe('wildcard');
    });

    it('应该匹配工具名通配符', () => {
      config.allow = ['*'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'AnyTool',
        params: { foo: 'bar' },
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ALLOW);
    });
  });

  describe('Glob 模式匹配', () => {
    it('应该匹配双星号 glob 模式', () => {
      config.deny = ['Read(file_path:**/.env)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'path/to/nested/.env' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.DENY);
      expect(result.matchType).toBe('glob');
    });

    it('应该匹配复杂的 glob 模式', () => {
      config.deny = ['Read(file_path:**/*.{env,key,secret})'];
      checker = new PermissionChecker(config);

      const cases = ['config.env', 'secrets/api.key', 'data/db.secret'];

      for (const filePath of cases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Read',
          params: { file_path: filePath },
          tool: mockReadTool,
        };

        const result = checker.check(descriptor);
        expect(result.result).toBe(PermissionResult.DENY);
      }
    });
  });

  describe('优先级测试', () => {
    it('deny 规则应该优先于 allow 规则', () => {
      config.allow = ['Read'];
      config.deny = ['Read(file_path:.env)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: '.env' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.DENY);
    });

    it('allow 规则应该优先于 ask 规则', () => {
      config.allow = ['Read(file_path:safe.txt)'];
      config.ask = ['Read'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'safe.txt' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('ask 规则应该覆盖默认行为', () => {
      config.ask = ['Write'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Write',
        params: { file_path: 'output.txt' },
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ASK);
    });
  });

  describe('默认行为', () => {
    it('未匹配任何规则时应该返回 ASK', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'SomeTool',
        params: {},
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ASK);
      expect(result.reason).toContain('默认需要确认');
    });
  });

  describe('便捷方法', () => {
    it('isAllowed() 应该正确判断', () => {
      config.allow = ['Read'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'test.txt' },
      };

      expect(checker.isAllowed(descriptor)).toBe(true);
    });

    it('isDenied() 应该正确判断', () => {
      config.deny = ['Delete'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Delete',
        params: { file_path: 'important.txt' },
      };

      expect(checker.isDenied(descriptor)).toBe(true);
    });

    it('needsConfirmation() 应该正确判断', () => {
      config.ask = ['Write'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Write',
        params: { file_path: 'output.txt' },
      };

      expect(checker.needsConfirmation(descriptor)).toBe(true);
    });
  });

  describe('配置更新', () => {
    it('应该能够更新权限配置', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'test.txt' },
      };

      // 初始状态: ASK
      expect(checker.check(descriptor).result).toBe(PermissionResult.ASK);

      // 更新配置: 添加 allow 规则
      checker.updateConfig({ allow: ['Read'] });

      // 现在应该 ALLOW
      expect(checker.check(descriptor).result).toBe(PermissionResult.ALLOW);
    });

    it('updateConfig 应该追加规则而不是替换', () => {
      config.allow = ['Read'];
      checker = new PermissionChecker(config);

      checker.updateConfig({ allow: ['Write'] });

      const currentConfig = checker.getConfig();
      expect(currentConfig.allow).toContain('Read');
      expect(currentConfig.allow).toContain('Write');
    });
  });

  describe('复杂场景', () => {
    it('应该处理多参数工具调用', () => {
      // 注意：新架构下tool的extractSignatureContent只返回单个关键参数
      // 这里测试使用 Write 工具的 file_path 作为签名
      config.allow = ['Write(file_path:test.txt)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Write',
        params: {
          file_path: 'test.txt',
          content: 'new content',
        },
        tool: mockWriteTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该处理无参数工具调用', () => {
      config.allow = ['GetStatus'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'GetStatus',
        params: {},
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该正确处理 affectedPaths', () => {
      config.deny = ['Write(file_path:**/.git/*)'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Write',
        params: { file_path: 'project/.git/config' },
        affectedPaths: ['project/.git/config'],
        tool: mockWriteTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.DENY);
    });
  });

  describe('边界情况', () => {
    it('应该处理空的权限配置', () => {
      const emptyConfig: PermissionConfig = {
        allow: [],
        ask: [],
        deny: [],
      };
      const emptyChecker = new PermissionChecker(emptyConfig);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'AnyTool',
        params: {},
      };

      const result = emptyChecker.check(descriptor);
      expect(result.result).toBe(PermissionResult.ASK); // 默认
    });

    it('应该处理特殊字符的参数值', () => {
      config.deny = ['Read(file_path:*.{env,key})'];
      checker = new PermissionChecker(config);

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: 'my-app.env' },
        tool: mockReadTool,
      };

      const result = checker.check(descriptor);
      expect(result.result).toBe(PermissionResult.DENY);
    });

    it('应该处理undefined和null参数', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'TestTool',
        params: {
          defined: 'value',
          undefined: undefined,
          null: null,
        },
      };

      // 不应该抛出错误
      expect(() => checker.check(descriptor)).not.toThrow();
    });
  });

  describe('实际使用案例', () => {
    it('应该阻止读取敏感文件', () => {
      config.deny = [
        'Read(file_path:.env)',
        'Read(file_path:.env.*)',
        'Read(file_path:**/.env)',
        'Read(file_path:**/*.key)',
      ];
      checker = new PermissionChecker(config);

      const sensitiveFiles = ['.env', '.env.local', 'config/.env', 'secrets/api.key'];

      for (const file of sensitiveFiles) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Read',
          params: { file_path: file },
          tool: mockReadTool,
        };

        const result = checker.check(descriptor);
        expect(result.result).toBe(PermissionResult.DENY);
      }
    });

    it('应该允许读取源代码文件', () => {
      config.allow = [
        'Read(file_path:**/*.ts)',
        'Read(file_path:**/*.js)',
        'Read(file_path:**/*.tsx)',
      ];
      checker = new PermissionChecker(config);

      const codeFiles = ['src/main.ts', 'lib/utils.js', 'components/App.tsx'];

      for (const file of codeFiles) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Read',
          params: { file_path: file },
          tool: mockReadTool,
        };

        const result = checker.check(descriptor);
        expect(result.result).toBe(PermissionResult.ALLOW);
      }
    });

    it('应该要求确认危险操作', () => {
      config.ask = ['Delete', 'Bash(command:rm *)', 'Write(file_path:**/package.json)'];
      checker = new PermissionChecker(config);

      const dangerousOps = [
        { toolName: 'Delete', params: { file_path: 'important.txt' } },
        { toolName: 'Bash', params: { command: 'rm -rf /' } },
        { toolName: 'Write', params: { file_path: 'package.json' } },
      ];

      for (const descriptor of dangerousOps) {
        const result = checker.check(descriptor);
        expect(result.result).toBe(PermissionResult.ASK);
      }
    });
  });
});
