import { spawn } from 'child_process';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type {
  ConfirmationDetails,
  JSONSchema7,
  ToolInvocation,
  ToolResult,
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * Shell命令执行参数接口
 */
interface ShellParams {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  capture_stderr?: boolean;
}

/**
 * 命令执行结果
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  signal?: string;
  execution_time: number;
}

/**
 * Shell工具调用实现
 */
class ShellToolInvocation extends BaseToolInvocation<ShellParams> {
  constructor(params: ShellParams) {
    super('shell', params);
  }

  getDescription(): string {
    const { command, args, cwd } = this.params;
    const fullCommand = args ? `${command} ${args.join(' ')}` : command;
    const location = cwd ? ` (在 ${cwd} 目录)` : '';
    return `执行命令: ${fullCommand}${location}`;
  }

  getAffectedPaths(): string[] {
    const paths: string[] = [];
    if (this.params.cwd) {
      paths.push(this.params.cwd);
    }
    return paths;
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { command, args } = this.params;
    const fullCommand = args ? `${command} ${args.join(' ')}` : command;

    // 检查是否是危险命令
    const dangerousCommands = [
      'rm',
      'del',
      'rmdir',
      'format',
      'fdisk',
      'mkfs',
      'dd',
      'shred',
      'wipe',
      'sudo',
      'su',
      'chmod',
      'chown',
      'passwd',
      'useradd',
      'userdel',
      'groupadd',
      'groupdel',
      'systemctl',
      'service',
      'reboot',
      'shutdown',
    ];

    const isDangerous = dangerousCommands.some((dangerous) =>
      fullCommand.toLowerCase().includes(dangerous)
    );

    if (isDangerous) {
      return {
        type: 'execute',
        title: '确认执行危险命令',
        message: `命令 "${fullCommand}" 可能对系统造成影响，确认要执行吗？`,
        risks: ['命令可能修改或删除文件', '命令可能影响系统配置', '操作可能不可逆'],
        affectedFiles: this.getAffectedPaths(),
      };
    }

    return null;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        command,
        args = [],
        cwd = process.cwd(),
        timeout = 30000,
        env = {},
        capture_stderr = true,
      } = this.params;

      const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
      updateOutput?.(`执行命令: ${fullCommand}`);

      const startTime = Date.now();

      // 过滤掉 undefined 值以满足 Record<string, string> 类型
      const mergedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...process.env, ...env })) {
        if (value !== undefined) {
          mergedEnv[key] = value;
        }
      }

      const result = await this.executeCommand({
        command,
        args,
        cwd,
        timeout,
        env: mergedEnv,
        capture_stderr,
        signal,
        updateOutput,
      });

      const executionTime = Date.now() - startTime;
      result.execution_time = executionTime;

      const metadata = {
        command: fullCommand,
        cwd,
        exit_code: result.exit_code,
        execution_time: executionTime,
        has_stderr: result.stderr.length > 0,
        stdout_length: result.stdout.length,
        stderr_length: result.stderr.length,
      };

      const displayMessage = this.formatDisplayMessage(result, metadata);

      // 如果命令失败，返回错误结果
      if (result.exit_code !== 0) {
        return this.createErrorResult(
          `命令执行失败 (退出码: ${result.exit_code})${result.stderr ? `\n错误输出: ${result.stderr}` : ''}`,
          metadata
        );
      }

      return this.createSuccessResult(result, displayMessage, metadata);
    } catch (error: unknown) {
      return this.createErrorResult(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async executeCommand(options: {
    command: string;
    args: string[];
    cwd: string;
    timeout: number;
    env: Record<string, string>;
    capture_stderr: boolean;
    signal: AbortSignal;
    updateOutput?: (output: string) => void;
  }): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const { command, args, cwd, timeout, env, capture_stderr, signal, updateOutput } =
        options;

      const childProcess = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', capture_stderr ? 'pipe' : 'inherit'],
      });

      let stdout = '';
      let stderr = '';
      let isResolved = false;

      // 设置超时
      const timeoutHandle = setTimeout(() => {
        if (!isResolved) {
          childProcess.kill('SIGTERM');
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        }
      }, timeout);

      // 处理中止信号
      const abortHandler = () => {
        if (!isResolved) {
          childProcess.kill('SIGTERM');
          reject(new Error('命令执行被用户中止'));
        }
      };

      signal.addEventListener('abort', abortHandler);

      // 收集输出
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data) => {
          const output = data.toString();
          stdout += output;
          updateOutput?.(output);
        });
      }

      if (capture_stderr && childProcess.stderr) {
        childProcess.stderr.on('data', (data) => {
          const output = data.toString();
          stderr += output;
          updateOutput?.(output);
        });
      }

      childProcess.on('close', (code, signal) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          options.signal.removeEventListener('abort', abortHandler);

          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exit_code: code || 0,
            signal: signal || undefined,
            execution_time: 0, // 将在外部设置
          });
        }
      });

      childProcess.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          options.signal.removeEventListener('abort', abortHandler);
          reject(error);
        }
      });
    });
  }

  private formatDisplayMessage(
    result: CommandResult,
    metadata: {
      command: string;
      exit_code: number;
      execution_time: number;
      has_stderr: boolean;
      stdout_length: number;
      stderr_length: number;
    }
  ): string {
    const { command, exit_code, execution_time } = metadata;

    let message = `命令执行完成: ${command}`;
    message += `\n退出码: ${exit_code}`;
    message += `\n执行时间: ${execution_time}ms`;

    if (result.stdout) {
      message += `\n标准输出 (${result.stdout.length} 字符):\n${result.stdout}`;
    }

    if (result.stderr && result.stderr.length > 0) {
      message += `\n错误输出 (${result.stderr.length} 字符):\n${result.stderr}`;
    }

    return message;
  }
}

/**
 * Shell命令执行工具
 * 执行单次shell命令并返回结果
 */
export class ShellTool extends DeclarativeTool<ShellParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令',
        },
        args: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: '命令参数列表（可选）',
        },
        cwd: {
          type: 'string',
          description: '执行目录（可选，默认当前目录）',
        },
        timeout: {
          type: 'integer',
          minimum: 1000,
          maximum: 300000,
          default: 30000,
          description: '超时时间（毫秒，默认30秒）',
        },
        env: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
          description: '环境变量（可选）',
        },
        capture_stderr: {
          type: 'boolean',
          default: true,
          description: '是否捕获错误输出',
        },
      },
      required: ['command'],
      additionalProperties: false,
    };

    super(
      'shell',
      'Shell命令执行',
      '执行单次shell命令并返回执行结果，支持超时控制和环境变量',
      ToolKind.Execute,
      schema,
      true, // 命令执行需要确认
      '1.0.0',
      '命令工具',
      ['shell', 'command', 'execute', 'system']
    );
  }

  build(params: ShellParams): ToolInvocation<ShellParams> {
    // 验证参数
    let command = this.validateString(params.command, 'command', {
      required: true,
      minLength: 1,
    });

    let args: string[] | undefined;

    // 🔧 智能解析: 如果 command 包含空格且没有提供 args,自动拆分
    if (!params.args && command.includes(' ')) {
      const parts = command.split(/\s+/);
      command = parts[0];
      args = parts.slice(1);
      console.log(
        `[ShellTool] 自动解析命令: "${params.command}" -> command="${command}", args=${JSON.stringify(args)}`
      );
    } else if (params.args !== undefined) {
      args = this.validateArray(params.args, 'args', {
        itemValidator: (item: unknown, index: number) => {
          return this.validateString(item, `args[${index}]`, {
            required: true,
            minLength: 1,
          });
        },
      });
    }

    let cwd: string | undefined;
    if (params.cwd !== undefined) {
      cwd = this.validateString(params.cwd, 'cwd', {
        required: false,
        minLength: 1,
      });
    }

    let timeout: number | undefined;
    if (params.timeout !== undefined) {
      timeout = this.validateNumber(params.timeout, 'timeout', {
        min: 1000,
        max: 300000,
        integer: true,
      });
    }

    let env: Record<string, string> | undefined;
    if (params.env !== undefined) {
      if (typeof params.env !== 'object' || params.env === null) {
        this.createValidationError('env', '环境变量必须是对象类型', params.env);
      }

      env = {};
      for (const [key, value] of Object.entries(params.env)) {
        env[key] = this.validateString(value, `env.${key}`, { required: true });
      }
    }

    const captureStderr = this.validateBoolean(
      params.capture_stderr ?? true,
      'capture_stderr'
    );

    const validatedParams: ShellParams = {
      command,
      ...(args !== undefined && { args }),
      ...(cwd !== undefined && { cwd }),
      ...(timeout !== undefined && { timeout }),
      ...(env !== undefined && { env }),
      capture_stderr: captureStderr,
    };

    return new ShellToolInvocation(validatedParams);
  }
}
