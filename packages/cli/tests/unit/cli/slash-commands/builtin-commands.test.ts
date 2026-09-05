/**
 * 内置 Slash Commands 测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinCommands } from '../../../../src/slash-commands/builtinCommands.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

// Mock UI
const mockSendMessage = vi.fn();
const mockUI = {
  sendMessage: mockSendMessage,
};
const { mockProbeModelProvider } = vi.hoisted(() => ({
  mockProbeModelProvider: vi.fn(),
}));

// Mock getUI helper
vi.mock('../../../../src/slash-commands/types.js', async () => {
  const actual = await vi.importActual('../../../../src/slash-commands/types.js');
  return {
    ...actual,
    getUI: () => mockUI,
  };
});

// Mock dependencies
vi.mock('../../../../src/store/vanilla.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    models: [{ id: 'test-model' }],
  }),
  getCurrentModel: vi.fn().mockReturnValue({
    id: 'test-model',
    name: 'Test Model',
    model: 'test-model-v1',
    provider: 'test-provider',
  }),
  getState: vi.fn().mockReturnValue({
    config: { config: {} },
    session: {
      history: [],
      tokenUsage: {
        turnCount: 2,
        totalInputTokens: 1_000,
        totalOutputTokens: 100,
        estimatedCostUsd: 0,
        maxContextTokens: 2_000,
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        cacheBreak: {
          reason: 'system_prompt_changed',
          previousCacheReadTokens: 5_000,
          cacheReadTokens: 600,
        },
      },
    },
  }),
}));

vi.mock('../../../../src/utils/packageInfo.js', () => ({
  getVersion: () => '1.0.0',
}));

vi.mock('../../../../src/services/ProviderHealthService.js', () => ({
  probeModelProvider: mockProbeModelProvider,
}));

describe('Builtin Slash Commands', () => {
  const mockContext = {
    cwd: '/test/project',
  } as SlashCommandContext;

  beforeEach(() => {
    mockSendMessage.mockReset();
    mockProbeModelProvider.mockReset();
  });

  describe('help command', () => {
    it('should display help message', async () => {
      const helpCmd = builtinCommands.help;
      const result = await helpCmd.handler([], mockContext);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalled();
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('可用的 Slash Commands');
      expect(message).toContain('/init');
      expect(message).toContain('/help');
      expect(message).toContain('/branch');
      expect(message).toContain('/fork [sessionId]');
      expect(message).toContain('/queue');
    });
  });

  describe('branch command', () => {
    it('should register a session branch command', () => {
      expect(builtinCommands.branch).toMatchObject({
        name: 'branch',
      });
      expect(builtinCommands.branch.aliases).toBeUndefined();
    });
  });

  describe('version command', () => {
    it('should display version info', async () => {
      const versionCmd = builtinCommands.version;
      const result = await versionCmd.handler([], mockContext);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalled();
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('Blade Code v1.0.0');
    });
  });

  describe('status command', () => {
    it('should display status info', async () => {
      const statusCmd = builtinCommands.status;
      const result = await statusCmd.handler([], mockContext);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalled();
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('当前状态');
      expect(message).toContain('项目信息');
      expect(message).toContain('模型配置');
      expect(message).toContain('会话统计');
      expect(message).toContain('配置状态');
    });
  });

  describe('cost command', () => {
    it('should display the cumulative prompt-cache hit rate', async () => {
      const result = await builtinCommands.cost.handler([], mockContext);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledOnce();
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('Cache hit rate: 60%');
      expect(message).toContain('Cache read: 600 tokens');
      expect(message).toContain('Cache write: 200 tokens');
      expect(message).toContain(
        'Last cache break: system prompt changed (5,000 → 600 cache-read tokens)'
      );
    });
  });

  describe('doctor command', () => {
    it('只显示 canonical provider failure', async () => {
      mockProbeModelProvider.mockResolvedValueOnce({
        ok: false,
        providerId: 'test-provider',
        modelConfigId: 'test-model',
        model: 'test-model-v1',
        wireApi: 'openai-completions',
        latencyMs: 15,
        code: 'authentication',
        message: 'Provider authentication failed. Check model credentials.',
      });

      const result = await builtinCommands.doctor.handler([], mockContext);

      expect(result.success).toBe(false);
      expect(result.content).toContain(
        'Provider authentication failed. Check model credentials.'
      );
      expect(result.content).not.toContain('sk-');
      expect(mockSendMessage).toHaveBeenCalledWith(result.content);
    });
  });
});
