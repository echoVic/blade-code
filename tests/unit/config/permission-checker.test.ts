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

const _mockWriteTool = createMockTool((params) => {
  const filePath = params.file_path as string;
  return filePath ? `file_path:${filePath}` : '';
});

const _mockBashTool = createMockTool((params) => {
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
  });
});
