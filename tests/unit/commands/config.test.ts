import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfigManager = {
  initialize: vi.fn(async () => {}),
  updateConfig: vi.fn(async () => {}),
  getConfig: vi.fn(() => ({ theme: 'light', nested: { value: 42 } })),
};

vi.mock('../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: () => mockConfigManager,
    resetInstance: vi.fn(),
  },
}));

function createYargsStub() {
  const commands = new Map<string, any>();
  const api = {
    command(cmd: any) {
      commands.set(cmd.command, cmd);
      return api;
    },
    demandCommand() {
      return api;
    },
    help() {
      return api;
    },
    example() {
      return api;
    },
  } as const;
  return {
    yargs: api,
    getCommand: (name: string) => commands.get(name),
  };
}

describe('commands/config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    Object.assign(mockConfigManager, {
      initialize: vi.fn(async () => {}),
      updateConfig: vi.fn(async () => {}),
      getConfig: vi.fn(() => ({ theme: 'light', nested: { value: 42 } })),
    });
  });

  it('config set 应构建嵌套更新对象并调用 updateConfig', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { configCommands } = await import('../../../src/commands/config.js');

    const { yargs, getCommand } = createYargsStub();
    configCommands.builder(yargs as any);
    const setCommand = getCommand('set <key> <value>');

    await setCommand.handler({ key: 'ui.theme', value: 'dark', global: false } as any);

    expect(mockConfigManager.initialize).toHaveBeenCalled();
    expect(mockConfigManager.updateConfig).toHaveBeenCalledWith({
      ui: { theme: 'dark' },
    });
    expect(logSpy).toHaveBeenCalledWith('✅ Set ui.theme = dark');
  });

  it('config get 应打印配置值并处理缺失键', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const { configCommands } = await import('../../../src/commands/config.js');

    const { yargs, getCommand } = createYargsStub();
    configCommands.builder(yargs as any);
    const getCommandHandler = getCommand('get <key>');

    mockConfigManager.getConfig.mockReturnValue({
      theme: 'dark',
      nested: { value: 1 },
    });
    await getCommandHandler.handler({ key: 'nested.value' } as any);
    expect(logSpy).toHaveBeenCalledWith('🔍 nested.value: 1');

    logSpy.mockClear();
    await getCommandHandler.handler({ key: 'missing.key' } as any);
    expect(logSpy).toHaveBeenCalledWith('🔍 missing.key: undefined');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('config list 应输出完整配置', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { configCommands } = await import('../../../src/commands/config.js');

    const { yargs, getCommand } = createYargsStub();
    configCommands.builder(yargs as any);
    const listCommand = getCommand('list');

    mockConfigManager.getConfig.mockReturnValue({ theme: 'dark' });
    await listCommand.handler({} as any);

    expect(logSpy).toHaveBeenCalledWith('📋 Current configuration:');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ theme: 'dark' }, null, 2));
  });

  it('config reset 未确认时应退出，确认后成功执行', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { configCommands } = await import('../../../src/commands/config.js');

    const { yargs, getCommand } = createYargsStub();
    configCommands.builder(yargs as any);
    const resetCommand = getCommand('reset');

    await resetCommand.handler({ confirm: false } as any);
    expect(errorSpy).toHaveBeenCalledWith('❌ Reset operation requires --confirm flag');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockClear();
    errorSpy.mockClear();
    await resetCommand.handler({ confirm: true } as any);
    expect(mockConfigManager.initialize).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('🔄 Resetting configuration to defaults...');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
