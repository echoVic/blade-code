/**
 * 安全的命令执行器
 * 防止命令注入攻击
 */

import { execFile, execFileSync, exec as nodeExec } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CommandOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  encoding?: BufferEncoding;
  shell?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class CommandExecutor {
  // 允许执行的命令白名单
  private static readonly ALLOWED_COMMANDS = new Set([
    'git',
    'node',
    'npm',
    'pnpm',
    'yarn',
    'python',
    'python3',
    'pip',
    'docker',
    'mkdir',
    'rm',
    'cp',
    'mv',
    'ls',
    'cat',
    'echo',
    'grep',
    'find',
    'tar',
    'unzip',
    'curl',
    'wget',
  ]);

  // 危险参数模式
  private static readonly DANGEROUS_PATTERNS = [
    /;\s*[a-zA-Z0-9_]+/gi, // 命令连接
    /\|\s*[a-zA-Z0-9_]+/gi, // 管道命令
    /&&\s*[a-zA-Z0-9_]+/gi, // 逻辑与
    /\|\|\s*[a-zA-Z0-9_]+/gi, // 逻辑或
    /\$\([^{]*?\)/gi, // 命令替换
    /`[^`]*?`/gi, // 反引号命令替换
    /<\s*\//gi, // 输入重定向
    />\s*\//gi, // 输出重定向
    /2>&1/gi, // 错误重定向
    /&>/gi, // 重定向
    /\$\{[^}]*\}/gi, // 变量展开
    /\$[a-zA-Z_][a-zA-Z0-9_]*/gi, // 环境变量
  ];

  /**
   * 安全地执行命令（使用文件和参数分离）
   * @param command 命令名称
   * @param args 参数数组
   * @param options 执行选项
   * @returns 执行结果
   */
  static async executeSafe(
    command: string,
    args: string[] = [],
    options: CommandOptions = {}
  ): Promise<CommandResult> {
    // 1. 验证命令白名单
    const commandName = command.split(' ')[0];
    if (!this.ALLOWED_COMMANDS.has(commandName)) {
      throw new Error(`不允许执行的命令: ${commandName}`);
    }

    // 2. 验证参数安全性
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('参数必须是字符串');
      }

      // 检查危险模式
      for (const pattern of this.DANGEROUS_PATTERNS) {
        if (pattern.test(arg)) {
          throw new Error(`检测到危险的参数模式: ${arg}`);
        }
      }

      // 检查特殊字符
      if (arg.includes('..') && (arg.includes('/') || arg.includes('\\'))) {
        throw new Error('参数不允许包含路径遍历字符');
      }
    }

    // 3. 设置默认选项
    const defaultOptions: CommandOptions = {
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 1024 * 1024, // 1MB
      encoding: options.encoding || 'utf8',
      env: {
        ...process.env,
        // 清除危险的环境变量
        PATH: this.sanitizePath(process.env.PATH || ''),
        ...(options.env || {}),
      },
    };

    // 4. 执行命令
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: defaultOptions.timeout,
        maxBuffer: defaultOptions.maxBuffer,
        encoding: defaultOptions.encoding,
        env: defaultOptions.env,
        shell: false, // 禁用 shell，防止注入
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
        signal: null,
      };
    } catch (error: any) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.code || 1,
        signal: error.signal || null,
      };
    }
  }

  /**
   * 安全地执行 Git 命令
   * @param args Git 命令参数
   * @param cwd 工作目录
   * @returns 执行结果
   */
  static async executeGit(args: string[], cwd?: string): Promise<CommandResult> {
    return this.executeSafe('git', args, { cwd });
  }

  /**
   * 安全地执行 Node.js 命令
   * @param args Node.js 命令参数
   * @param cwd 工作目录
   * @returns 执行结果
   */
  static async executeNode(args: string[], cwd?: string): Promise<CommandResult> {
    return this.executeSafe('node', args, { cwd });
  }

  /**
   * 安全地执行 NPM 命令
   * @param args NPM 命令参数
   * @param cwd 工作目录
   * @returns 执行结果
   */
  static async executeNpm(args: string[], cwd?: string): Promise<CommandResult> {
    return this.executeSafe('npm', args, { cwd });
  }

  /**
   * 安全地执行文件操作命令
   * @param command 命令类型 (mkdir, rm, cp, mv)
   * @param args 参数
   * @param cwd 工作目录
   * @returns 执行结果
   */
  static async executeFileCommand(
    command: 'mkdir' | 'rm' | 'cp' | 'mv' | 'ls',
    args: string[],
    cwd?: string
  ): Promise<CommandResult> {
    // 特殊验证：文件操作命令需要额外的路径验证
    const pathS = require('path');

    if (command === 'rm') {
      // 防止危险删除操作
      if (args.includes('-rf') || args.includes('-fr')) {
        if (args.some((arg) => arg.startsWith('/') || arg.startsWith('~'))) {
          throw new Error('禁止删除根目录下的文件');
        }
      }
    }

    return this.executeSafe(command, args, { cwd });
  }

  /**
   * 同步执行命令（仅用于初始化等必要场景）
   * @param command 命令名称
   * @param args 参数数组
   * @param options 执行选项
   * @returns 执行结果
   */
  static executeFileSync(
    command: string,
    args: string[] = [],
    options: CommandOptions = {}
  ): { stdout: string; stderr: string } {
    const commandName = command.split(' ')[0];
    if (!this.ALLOWED_COMMANDS.has(commandName)) {
      throw new Error(`不允许执行的命令: ${commandName}`);
    }

    try {
      const result = execFileSync(command, args, {
        cwd: options.cwd,
        timeout: options.timeout || 30000,
        maxBuffer: options.maxBuffer || 1024 * 1024,
        encoding: options.encoding || 'utf8',
        env: {
          ...process.env,
          PATH: this.sanitizePath(process.env.PATH || ''),
          ...(options.env || {}),
        },
        shell: false,
      });

      return {
        stdout: result.toString(),
        stderr: '',
      };
    } catch (error: any) {
      return {
        stdout: '',
        stderr: error.message,
      };
    }
  }

  /**
   * 添加自定义允许命令
   * @param command 命令名称
   */
  static addAllowedCommand(command: string): void {
    this.ALLOWED_COMMANDS.add(command);
  }

  /**
   * 移除允许的命令
   * @param command 命令名称
   */
  static removeAllowedCommand(command: string): void {
    this.ALLOWED_COMMANDS.delete(command);
  }

  /**
   * 获取当前允许的命令列表
   */
  static getAllowedCommands(): string[] {
    return Array.from(this.ALLOWED_COMMANDS);
  }

  /**
   * 清理 PATH 环境变量
   * @param path 原始 PATH
   * @returns 清理后的 PATH
   */
  private static sanitizePath(path: string): string {
    const pathS = require('path');
    const dangerousPaths = ['/tmp', '/var/tmp', '/dev/shm'];

    return path
      .split(pathS.delimiter)
      .filter((segment) => {
        // 过滤掉危险的目录
        const normalizedSegment = segment.toLowerCase();
        return !dangerousPaths.some((dangerousPath) =>
          normalizedSegment.includes(dangerousPath)
        );
      })
      .join(pathS.delimiter);
  }

  /**
   * 验证命令参数是否安全
   * @param args 参数数组
   * @throws Error 如果参数不安全
   */
  static validateArguments(args: string[]): void {
    for (const arg of args) {
      // 检查 NULL 字节
      if (arg.includes('\0')) {
        throw new Error('参数不能包含 NULL 字节');
      }

      // 检查长度限制
      if (arg.length > 4096) {
        throw new Error('参数过长');
      }

      // 检查换行符
      if (arg.includes('\n') || arg.includes('\r')) {
        throw new Error('参数不能包含换行符');
      }
    }
  }

  /**
   * 创建安全的命令字符串（用于显示）
   * @param command 命令
   * @param args 参数
   * @returns 安全的命令字符串
   */
  static createSafeCommandString(command: string, args: string[]): string {
    return [command, ...args]
      .map((arg) => {
        // 转义特殊字符
        if (arg.includes(' ')) {
          return `"${arg.replace(/"/g, '\\"')}"`;
        }
        return arg;
      })
      .join(' ');
  }
}
