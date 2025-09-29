import { EventEmitter } from 'events';
import type { BladeConfig } from '../config/types.js';

export interface Command {
  name: string;
  description: string;
  category: string;
  usage: string;
  aliases: string[];
  hidden: boolean;
  handler: CommandHandler;
  options?: CommandOption[];
  permissions?: string[];
  deprecated?: boolean;
  examples?: string[];
}

export interface CommandOption {
  name: string;
  alias?: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  default?: any;
  required?: boolean;
  choices?: any[];
}

export interface CommandHandler {
  (args: string[], options: Record<string, any>): Promise<void>;
}

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}

export class CommandService extends EventEmitter {
  private commands: Map<string, Command> = new Map();
  private aliases: Map<string, string> = new Map();
  private config: BladeConfig | null = null;

  constructor() {
    super();
  }

  public async initialize(config: BladeConfig): Promise<void> {
    this.config = config;

    // 注册内置命令
    await this.registerBuiltinCommands();

    this.emit('initialized');
  }

  public async registerCommand(command: Command): Promise<void> {
    // 验证命令
    if (!command.name || !command.handler) {
      throw new Error('命令必须包含名称和处理器');
    }

    // 检查命令是否已存在
    if (this.commands.has(command.name)) {
      console.warn(`命令 "${command.name}" 已存在，将被覆盖`);
    }

    // 注册命令
    this.commands.set(command.name, command);

    // 注册别名
    if (command.aliases) {
      for (const alias of command.aliases) {
        if (this.aliases.has(alias)) {
          console.warn(`别名 "${alias}" 已存在，将被覆盖`);
        }
        this.aliases.set(alias, command.name);
      }
    }

    this.emit('commandRegistered', command);
  }

  public async unregisterCommand(name: string): Promise<void> {
    const command = this.commands.get(name);
    if (!command) {
      throw new Error(`命令 "${name}" 不存在`);
    }

    // 移除命令
    this.commands.delete(name);

    // 移除别名
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.delete(alias);
      }
    }

    this.emit('commandUnregistered', command);
  }

  public getCommand(name: string): Command | undefined {
    // 直接查找命令
    let command = this.commands.get(name);

    // 如果没找到，尝试通过别名查找
    if (!command) {
      const actualName = this.aliases.get(name);
      if (actualName) {
        command = this.commands.get(actualName);
      }
    }

    return command;
  }

  public getAllCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  public getCommandsByCategory(category: string): Command[] {
    return Array.from(this.commands.values()).filter(
      (command) => command.category === category
    );
  }

  public async executeCommand(
    name: string,
    args: string[] = [],
    options: Record<string, any> = {}
  ): Promise<CommandResult> {
    try {
      const command = this.getCommand(name);

      if (!command) {
        return {
          success: false,
          error: `命令 "${name}" 未找到`,
          exitCode: 1,
        };
      }

      // 检查权限
      if (command.permissions && !this.checkPermissions(command.permissions)) {
        return {
          success: false,
          error: `权限不足，无法执行命令 "${name}"`,
          exitCode: 1,
        };
      }

      // 执行命令
      await command.handler(args, options);

      return {
        success: true,
        exitCode: 0,
      };
    } catch (error) {
      console.error(`执行命令 "${name}" 失败:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  public async executeCommandString(commandString: string): Promise<CommandResult> {
    try {
      const parts = commandString.trim().split(/\s+/);
      const name = parts[0];
      const args = parts.slice(1);

      return await this.executeCommand(name, args);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  public searchCommands(query: string): Command[] {
    const lowerQuery = query.toLowerCase();

    return Array.from(this.commands.values()).filter((command) => {
      // 匹配命令名称
      if (command.name.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 匹配描述
      if (command.description.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 匹配别名
      if (
        command.aliases &&
        command.aliases.some((alias) => alias.toLowerCase().includes(lowerQuery))
      ) {
        return true;
      }

      // 匹配分类
      if (command.category.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      return false;
    });
  }

  public async loadCommandsFromDirectory(directory: string): Promise<void> {
    try {
      // 这里应该实现从目录加载命令的逻辑
      // 暂时留空，后续实现
      console.log(`从目录加载命令: ${directory}`);
    } catch (error) {
      console.error(`从目录加载命令失败: ${directory}`, error);
      throw error;
    }
  }

  public async loadCommandsFromFile(filePath: string): Promise<void> {
    try {
      // 这里应该实现从文件加载命令的逻辑
      // 暂时留空，后续实现
      console.log(`从文件加载命令: ${filePath}`);
    } catch (error) {
      console.error(`从文件加载命令失败: ${filePath}`, error);
      throw error;
    }
  }

  private async registerBuiltinCommands(): Promise<void> {
    // 这里应该注册内置命令
    // 暂时留空，后续实现
    console.log('注册内置命令');
  }

  private checkPermissions(requiredPermissions: string[]): boolean {
    // 这里应该实现权限检查逻辑
    // 暂时返回true，后续实现
    return true;
  }

  public getCommandHelp(name: string): string {
    const command = this.getCommand(name);

    if (!command) {
      return `命令 "${name}" 未找到`;
    }

    let help = `${command.name} - ${command.description}\n\n`;

    if (command.usage) {
      help += `用法: ${command.usage}\n`;
    }

    if (command.aliases && command.aliases.length > 0) {
      help += `别名: ${command.aliases.join(', ')}\n`;
    }

    if (command.options && command.options.length > 0) {
      help += '\n选项:\n';
      for (const option of command.options) {
        help += `  --${option.name}`;
        if (option.alias) {
          help += `, -${option.alias}`;
        }
        help += `  ${option.description}`;
        if (option.default !== undefined) {
          help += ` (默认: ${option.default})`;
        }
        help += '\n';
      }
    }

    if (command.examples && command.examples.length > 0) {
      help += '\n示例:\n';
      for (const example of command.examples) {
        help += `  ${example}\n`;
      }
    }

    return help;
  }

  public getAllCommandsHelp(): string {
    const categories = new Set<string>();
    const commands = this.getAllCommands();

    // 收集所有分类
    for (const command of commands) {
      categories.add(command.category);
    }

    let help = '可用命令:\n\n';

    // 按分类显示命令
    for (const category of Array.from(categories).sort()) {
      help += `${category}:\n`;

      const categoryCommands = this.getCommandsByCategory(category);
      for (const command of categoryCommands) {
        if (!command.hidden) {
          help += `  ${command.name.padEnd(20)} ${command.description}\n`;
        }
      }

      help += '\n';
    }

    return help;
  }
}
