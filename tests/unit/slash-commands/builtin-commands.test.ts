/**
 * 内置 Slash Commands 测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinCommands } from '../../../src/slash-commands/builtinCommands.js';
import type { SlashCommandContext } from '../../../src/slash-commands/types.js';

// Mock UI
const mockSendMessage = vi.fn();
const mockUI = {
  sendMessage: mockSendMessage,
};

// Mock getUI helper
vi.mock('../../../src/slash-commands/types.js', async () => {
  const actual = await vi.importActual('../../../src/slash-commands/types.js');
  return {
    ...actual,
    getUI: () => mockUI,
  };
});

// Mock dependencies
vi.mock('../../../src/store/vanilla.js', () => ({
  getConfig: vi.fn().mockReturnValue({}),
  getCurrentModel: vi.fn().mockReturnValue({ id: 'test-model' }),
  getState: vi.fn().mockReturnValue({
    config: { config: {} },
    session: { history: [] },
  }),
}));

vi.mock('../../../src/utils/packageInfo.js', () => ({
  getVersion: () => '1.0.0',
}));

describe('Builtin Slash Commands', () => {
  const mockContext = {
    cwd: '/test/project',
  } as SlashCommandContext;

  beforeEach(() => {
    mockSendMessage.mockReset();
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
      expect(message).toContain('配置状态');
    });
  });
});
