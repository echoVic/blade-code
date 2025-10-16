import { promises as fs } from 'fs';
import * as path from 'path';
import type { BladeConfig } from '../config/types.js';
import { Command, CommandService } from './CommandService.js';

export class BuiltinCommandLoader {
  private commandService: CommandService;
  private config: BladeConfig;

  constructor(commandService: CommandService, config: BladeConfig) {
    this.commandService = commandService;
    this.config = config;
  }

  public async loadBuiltinCommands(): Promise<void> {
    // 注册核心命令
    await this.registerCoreCommands();

    // 注册工具命令
    await this.registerToolCommands();

    // 注册配置命令
    await this.registerConfigCommands();

    // 注册调试命令（仅在调试模式下）
    if (this.config.debug) {
      await this.registerDebugCommands();
    }
  }

  private async registerCoreCommands(): Promise<void> {
    // 帮助命令
    await this.commandService.registerCommand({
      name: 'help',
      description: '显示帮助信息',
      category: 'core',
      usage: 'help [command]',
      aliases: ['h'],
      hidden: false,
      handler: async (args) => {
        if (args.length > 0) {
          const helpText = this.commandService.getCommandHelp(args[0]);
          console.log(helpText);
        } else {
          const helpText = this.commandService.getAllCommandsHelp();
          console.log(helpText);
        }
      },
      options: [
        {
          name: 'all',
          alias: 'a',
          description: '显示所有命令（包括隐藏命令）',
          type: 'boolean',
          default: false,
        },
      ],
      examples: ['help', 'help config'],
    });

    // 版本命令
    await this.commandService.registerCommand({
      name: 'version',
      description: '显示版本信息',
      category: 'core',
      usage: 'version',
      aliases: ['v'],
      hidden: false,
      handler: async () => {
        console.log(`Blade Code v${process.env.BLADE_VERSION || '0.0.0'}`);
      },
      examples: ['version'],
    });

    // 退出命令
    await this.commandService.registerCommand({
      name: 'exit',
      description: '退出应用',
      category: 'core',
      usage: 'exit',
      aliases: ['quit', 'q'],
      hidden: false,
      handler: async () => {
        console.log('再见！');
        process.exit(0);
      },
      examples: ['exit'],
    });
  }

  private async registerToolCommands(): Promise<void> {
    // Git工具命令
    await this.commandService.registerCommand({
      name: 'git',
      description: 'Git工具集',
      category: 'tools',
      usage: 'git <subcommand> [options]',
      aliases: ['g'],
      hidden: false,
      handler: async (args) => {
        if (args.length === 0) {
          console.log(this.commandService.getCommandHelp('git'));
          return;
        }

        const subcommand = args[0];
        // const subArgs = args.slice(1);

        switch (subcommand) {
          case 'status':
            console.log('Git 状态...');
            // 实现Git状态逻辑
            break;
          case 'commit':
            console.log('Git 提交...');
            // 实现Git提交逻辑
            break;
          default:
            console.log(`未知的Git子命令: ${subcommand}`);
        }
      },
      options: [
        {
          name: 'message',
          alias: 'm',
          description: '提交信息',
          type: 'string',
        },
      ],
      examples: ['git status', 'git commit -m "Initial commit"'],
    });

    // 文件系统工具命令
    await this.commandService.registerCommand({
      name: 'fs',
      description: '文件系统工具',
      category: 'tools',
      usage: 'fs <subcommand> [options]',
      aliases: ['file'],
      hidden: false,
      handler: async (args) => {
        if (args.length === 0) {
          console.log(this.commandService.getCommandHelp('fs'));
          return;
        }

        const subcommand = args[0];
        // const subArgs = args.slice(1);

        switch (subcommand) {
          case 'list':
            console.log('文件列表...');
            // 实现文件列表逻辑
            break;
          case 'read':
            console.log('读取文件...');
            // 实现读取文件逻辑
            break;
          default:
            console.log(`未知的文件系统子命令: ${subcommand}`);
        }
      },
      examples: ['fs list', 'fs read package.json'],
    });
  }

  private async registerConfigCommands(): Promise<void> {
    // 配置命令
    await this.commandService.registerCommand({
      name: 'config',
      description: '管理配置',
      category: 'config',
      usage: 'config <subcommand> [options]',
      aliases: ['cfg'],
      hidden: false,
      handler: async (args, options) => {
        if (args.length === 0) {
          console.log(this.commandService.getCommandHelp('config'));
          return;
        }

        const subcommand = args[0];
        // const subArgs = args.slice(1);

        switch (subcommand) {
          case 'list':
            console.log('配置列表...');
            // 实现配置列表逻辑
            break;
          case 'get':
            console.log('获取配置...');
            // 实现获取配置逻辑
            break;
          case 'set':
            console.log('设置配置...');
            // 实现设置配置逻辑
            break;
          default:
            console.log(`未知的配置子命令: ${subcommand}`);
        }
      },
      options: [
        {
          name: 'global',
          alias: 'g',
          description: '全局配置',
          type: 'boolean',
          default: false,
        },
      ],
      examples: ['config list', 'config get core.debug', 'config set core.debug true'],
    });
  }

  private async registerDebugCommands(): Promise<void> {
    // 调试命令（仅在调试模式下可用）
    await this.commandService.registerCommand({
      name: 'debug',
      description: '调试工具（仅调试模式）',
      category: 'debug',
      usage: 'debug <subcommand> [options]',
      aliases: ['dbg'],
      hidden: true,
      handler: async (args) => {
        if (args.length === 0) {
          console.log(this.commandService.getCommandHelp('debug'));
          return;
        }

        const subcommand = args[0];
        // const subArgs = args.slice(1);

        switch (subcommand) {
          case 'info':
            console.log('调试信息...');
            // 实现调试信息逻辑
            break;
          case 'log':
            console.log('调试日志...');
            // 实现调试日志逻辑
            break;
          default:
            console.log(`未知的调试子命令: ${subcommand}`);
        }
      },
      examples: ['debug info', 'debug log'],
    });
  }
}

export class FileCommandLoader {
  private commandService: CommandService;
  private config: BladeConfig;

  constructor(commandService: CommandService, config: BladeConfig) {
    this.commandService = commandService;
    this.config = config;
  }

  public async loadCommandsFromDirectory(directory: string): Promise<void> {
    try {
      const files = await fs.readdir(directory);

      for (const file of files) {
        if (file.endsWith('.js') || file.endsWith('.ts')) {
          const filePath = path.join(directory, file);
          await this.loadCommandFromFile(filePath);
        }
      }
    } catch (error) {
      console.error(`从目录加载命令失败: ${directory}`, error);
    }
  }

  public async loadCommandFromFile(filePath: string): Promise<void> {
    try {
      // 检查文件是否存在
      await fs.access(filePath);

      // 加载命令模块
      const module = await import(filePath);

      // 获取默认导出或命名导出的命令
      const command: Command = module.default || module.command;

      if (command && command.name && typeof command.handler === 'function') {
        await this.commandService.registerCommand(command);
        console.log(`加载命令: ${command.name} (${filePath})`);
      } else {
        console.warn(`文件不包含有效的命令: ${filePath}`);
      }
    } catch (error) {
      console.error(`从文件加载命令失败: ${filePath}`, error);
    }
  }

  public async loadCommandsFromConfig(): Promise<void> {
    // 从配置中加载命令路径
    // 暂时留空，后续实现
    console.log('从配置加载命令');
  }
}
