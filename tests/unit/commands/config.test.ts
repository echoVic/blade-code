import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all functions from vanilla store that might be used
const mockAddAssistantMessage = vi.fn();
const mockSessionActions = {
  addAssistantMessage: mockAddAssistantMessage,
};
vi.mock('../../../src/store/vanilla.js', () => ({
  sessionActions: vi.fn(() => mockSessionActions),
  ensureStoreInitialized: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockReturnValue(null),
  getCurrentModel: vi.fn().mockReturnValue(null),
  getAllModels: vi.fn().mockReturnValue([]),
  getMcpServers: vi.fn().mockReturnValue({}),
  getState: vi.fn().mockReturnValue({}),
  subscribe: vi.fn().mockReturnValue(() => {
    /* 模拟实现 */
  }),
  appActions: vi.fn().mockReturnValue({}),
  focusActions: vi.fn().mockReturnValue({}),
  commandActions: vi.fn().mockReturnValue({}),
  subscribeToTodos: vi.fn().mockReturnValue(() => {
    /* 模拟实现 */
  }),
  subscribeToProcessing: vi.fn().mockReturnValue(() => {
    /* 模拟实现 */
  }),
  subscribeToThinking: vi.fn().mockReturnValue(() => {
    /* 模拟实现 */
  }),
  subscribeToMessages: vi.fn().mockReturnValue(() => {
    /* 模拟实现 */
  }),
  getSessionId: vi.fn().mockReturnValue('test-session'),
  getMessages: vi.fn().mockReturnValue([]),
  getTodos: vi.fn().mockReturnValue([]),
  isProcessing: vi.fn().mockReturnValue(false),
  isThinking: vi.fn().mockReturnValue(false),
  configActions: vi.fn().mockReturnValue({}),
}));

describe('slash-commands/config', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAddAssistantMessage.mockClear();
  });

  it('config command should display config panel', async () => {
    const { builtinCommands } = await import(
      '../../../src/slash-commands/builtinCommands.js'
    );
    const configCommand = builtinCommands.config;

    const context = { cwd: process.cwd() };
    const result = await configCommand.handler([], context);

    expect(result.success).toBe(true);
    expect(mockAddAssistantMessage).toHaveBeenCalledWith(
      expect.stringContaining('⚙️ **配置面板**')
    );
  });

  it('config command with theme argument should display config panel', async () => {
    const { builtinCommands } = await import(
      '../../../src/slash-commands/builtinCommands.js'
    );
    const configCommand = builtinCommands.config;

    const context = { cwd: process.cwd() };
    const result = await configCommand.handler(['theme'], context);

    expect(result.success).toBe(true);
    expect(mockAddAssistantMessage).toHaveBeenCalledWith(
      expect.stringContaining('⚙️ **配置面板**')
    );
  });
});
