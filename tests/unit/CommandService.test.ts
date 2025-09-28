import { vi } from 'vitest';
import { CommandService } from '../../src/commands/CommandService.js';

describe('CommandService', () => {
  let commandService: CommandService;

  beforeEach(() => {
    // 重置模块缓存以获取新的单例实例
    vi.resetModules();
    commandService = CommandService.getInstance();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be a singleton', () => {
    const instance1 = CommandService.getInstance();
    const instance2 = CommandService.getInstance();

    expect(instance1).toBe(instance2);
  });

  it('should register and get commands', async () => {
    const testCommand = {
      name: 'test',
      description: '测试命令',
      category: 'test',
      usage: 'test',
      aliases: ['t'],
      hidden: false,
      handler: vi.fn(),
    };

    await commandService.registerCommand(testCommand);

    const command = commandService.getCommand('test');
    expect(command).toEqual(testCommand);

    const aliasCommand = commandService.getCommand('t');
    expect(aliasCommand).toEqual(testCommand);
  });

  it('should get all commands', async () => {
    const command1 = {
      name: 'command1',
      description: '命令1',
      category: 'test',
      usage: 'command1',
      aliases: [],
      hidden: false,
      handler: vi.fn(),
    };

    const command2 = {
      name: 'command2',
      description: '命令2',
      category: 'test',
      usage: 'command2',
      aliases: [],
      hidden: false,
      handler: vi.fn(),
    };

    await commandService.registerCommand(command1);
    await commandService.registerCommand(command2);

    const commands = commandService.getAllCommands();
    expect(commands).toHaveLength(2);
    expect(commands).toEqual(expect.arrayContaining([command1, command2]));
  });

  it('should get commands by category', async () => {
    const testCommand = {
      name: 'test',
      description: '测试命令',
      category: 'test-category',
      usage: 'test',
      aliases: [],
      hidden: false,
      handler: vi.fn(),
    };

    const otherCommand = {
      name: 'other',
      description: '其他命令',
      category: 'other-category',
      usage: 'other',
      aliases: [],
      hidden: false,
      handler: vi.fn(),
    };

    await commandService.registerCommand(testCommand);
    await commandService.registerCommand(otherCommand);

    const testCommands = commandService.getCommandsByCategory('test-category');
    expect(testCommands).toHaveLength(1);
    expect(testCommands[0]).toEqual(testCommand);
  });

  it('should execute commands', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    const testCommand = {
      name: 'test',
      description: '测试命令',
      category: 'test',
      usage: 'test',
      aliases: [],
      hidden: false,
      handler,
    };

    await commandService.registerCommand(testCommand);

    const result = await commandService.executeCommand('test', ['arg1', 'arg2'], {
      option: 'value',
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(handler).toHaveBeenCalledWith(['arg1', 'arg2'], { option: 'value' });
  });

  it('should handle command execution errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('执行失败'));

    const testCommand = {
      name: 'test',
      description: '测试命令',
      category: 'test',
      usage: 'test',
      aliases: [],
      hidden: false,
      handler,
    };

    await commandService.registerCommand(testCommand);

    const result = await commandService.executeCommand('test');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('执行失败');
  });

  it('should return error for non-existent commands', async () => {
    const result = await commandService.executeCommand('non-existent');

    expect(result.success).toBe(false);
    expect(result.error).toContain('未找到');
  });

  it('should search commands', async () => {
    const command1 = {
      name: 'build',
      description: '构建项目',
      category: 'development',
      usage: 'build',
      aliases: ['b'],
      hidden: false,
      handler: vi.fn(),
    };

    const command2 = {
      name: 'test',
      description: '运行测试',
      category: 'development',
      usage: 'test',
      aliases: ['t'],
      hidden: false,
      handler: vi.fn(),
    };

    await commandService.registerCommand(command1);
    await commandService.registerCommand(command2);

    const buildCommands = commandService.searchCommands('build');
    expect(buildCommands).toHaveLength(1);
    expect(buildCommands[0].name).toBe('build');

    const devCommands = commandService.searchCommands('development');
    expect(devCommands).toHaveLength(2);
  });

  it('should generate help text', async () => {
    const testCommand = {
      name: 'test',
      description: '测试命令',
      category: 'test',
      usage: 'test [options]',
      aliases: ['t'],
      hidden: false,
      handler: vi.fn(),
      options: [
        {
          name: 'verbose',
          alias: 'v',
          description: '详细输出',
          type: 'boolean',
          default: false,
        },
      ],
      examples: ['test', 'test --verbose'],
    };

    await commandService.registerCommand(testCommand);

    const helpText = commandService.getCommandHelp('test');
    expect(helpText).toContain('test - 测试命令');
    expect(helpText).toContain('用法: test [options]');
    expect(helpText).toContain('别名: t');
    expect(helpText).toContain('详细输出');
    expect(helpText).toContain('示例:');

    const allHelpText = commandService.getAllCommandsHelp();
    expect(allHelpText).toContain('test');
    expect(allHelpText).toContain('测试命令');
  });

  it('should unregister commands', async () => {
    const testCommand = {
      name: 'test',
      description: '测试命令',
      category: 'test',
      usage: 'test',
      aliases: ['t'],
      hidden: false,
      handler: vi.fn(),
    };

    await commandService.registerCommand(testCommand);

    let command = commandService.getCommand('test');
    expect(command).toBeDefined();

    await commandService.unregisterCommand('test');

    command = commandService.getCommand('test');
    expect(command).toBeUndefined();

    const aliasCommand = commandService.getCommand('t');
    expect(aliasCommand).toBeUndefined();
  });
});
