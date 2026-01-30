/**
 * ExecutionPipeline 测试
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ExecutionPipeline } from '../../../../src/tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import { createMockFileSystem } from '../../../../mocks/mockFileSystem.js';
import { getFileSystemService, setFileSystemService } from '../../../../src/services/FileSystemService.js';
import { ToolErrorType } from '../../../../src/tools/types/index.js';

// Mock AcpServiceContext
vi.mock('../../../../src/acp/AcpServiceContext.js', () => ({
  isAcpMode: vi.fn(() => false),
  AcpServiceContext: {
    initializeSession: vi.fn(),
    destroySession: vi.fn(),
    setCurrentSession: vi.fn(),
  },
}));

describe('ExecutionPipeline', () => {
  let mockFS: ReturnType<typeof createMockFileSystem>;
  let originalFSService: any;
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    // 创建 mock 文件系统
    mockFS = createMockFileSystem();
    originalFSService = (globalThis as any).__fileSystemService;
    setFileSystemService(mockFS as any);

    // 创建 pipeline
    pipeline = new ExecutionPipeline();
  });

  describe('权限检查', () => {
    it('应该通过 ALLOW 规则的工具调用', async () => {
      const context = {
        sessionId: 'test-session',
        permissionRules: [
          {
            tools: ['Read'],
            action: 'allow',
          },
        ],
      };

      const toolCall = {
        name: 'Read',
        input: { file_path: '/tmp/test.txt' },
      };

      const result = await pipeline.checkPermission(toolCall, context);
      expect(result.granted).toBe(true);
    });

    it('应该拒绝 DENY 规则的工具调用', async () => {
      const context = {
        sessionId: 'test-session',
        permissionRules: [
          {
            tools: ['Write'],
            action: 'deny',
          },
        ],
      };

      const toolCall = {
        name: 'Write',
        input: { file_path: '/tmp/test.txt' },
      };

      const result = await pipeline.checkPermission(toolCall, context);
      expect(result.granted).toBe(false);
      expect(result.reason).toContain('DENY');
    });

    it('应该要求 ASK 规则的工具调用', async () => {
      const context = {
        sessionId: 'test-session',
        permissionRules: [
          {
            tools: ['Bash'],
            action: 'ask',
          },
        ],
      };

      const toolCall = {
        name: 'Bash',
        input: { command: 'ls' },
      };

      const result = await pipeline.checkPermission(toolCall, context);
      expect(result.granted).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('应该支持通配符规则', async () => {
      const context = {
        sessionId: 'test-session',
        permissionRules: [
          {
            tools: ['**/*'],
            action: 'allow',
          },
        ],
      };

      const toolCall = {
        name: 'Read',
        input: { file_path: '/tmp/test.txt' },
      };

      const result = await pipeline.checkPermission(toolCall, context);
      expect(result.granted).toBe(true);
    });
  });

  describe('工具调用链', () => {
    it('应该顺序执行工具调用', async () => {
      const context = {
        sessionId: 'test-session',
        updateOutput: vi.fn(),
      };

      const toolCalls = [
        { name: 'Read', input: { file_path: '/tmp/test1.txt' } },
        { name: 'Read', input: { file_path: '/tmp/test2.txt' } },
      ];

      const results = await pipeline.executeChain(toolCalls, context);
      expect(results).toHaveLength(2);
      expect(results[0]).toBeDefined();
      expect(results[1]).toBeDefined();
    });

    it('应该支持并行执行工具调用', async () => {
      const context = {
        sessionId: 'test-session',
        updateOutput: vi.fn(),
      };

      const toolCalls = [
        { name: 'Read', input: { file_path: '/tmp/test1.txt' } },
        { name: 'Read', input: { file_path: '/tmp/test2.txt' } },
      ];

      const results = await pipeline.executeChainParallel(toolCalls, context);
      expect(results).toHaveLength(2);
    });
  });

  describe('错误处理', () => {
    it('应该正确传播工具执行错误', async () => {
      const context = {
        sessionId: 'test-session',
        updateOutput: vi.fn(),
      };

      const toolCall = {
        name: 'Read',
        input: { file_path: '/nonexistent.txt' },
      };

      const result = await pipeline.execute(toolCall, context);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('应该在工具执行失败时停止调用链', async () => {
      const context = {
        sessionId: 'test-session',
        updateOutput: vi.fn(),
        stopOnError: true,
      };

      const toolCalls = [
        { name: 'Read', input: { file_path: '/nonexistent.txt' } },
        { name: 'Read', input: { file_path: '/tmp/test.txt' } },
      ];

      const results = await pipeline.executeChain(toolCalls, context);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });
  });
});
