import { spawn } from 'child_process';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * Command execution result
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  signal?: string;
  execution_time: number;
}

/**
 * ShellTool - Shell command executor
 * Uses the newer Zod validation design
 */
export const shellTool = createTool({
  name: 'Shell',
  displayName: 'Shell Command',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    command: ToolSchemas.command({
      description: 'Command to run',
    }),
    args: z.array(z.string().min(1)).optional().describe('Command arguments (optional)'),
    cwd: z.string().optional().describe('Working directory (optional, defaults to cwd)'),
    timeout: ToolSchemas.timeout(1000, 300000, 30000),
    env: ToolSchemas.environment(),
    capture_stderr: z.boolean().default(true).describe('Capture stderr'),
  }),

  // 工具描述
  description: {
    short: 'Run a one-off shell command with timeout and env control',
    long: `Execute standalone system commands; each call is a new process. Supports args, working directory, environment, and timeout configuration.`,
    usageNotes: [
      'IMPORTANT: Use for terminal ops (git, npm, docker, etc.)',
      'DO NOT use for file operations—use dedicated tools',
      'command is required',
      'Args can be passed via args array',
      'If command includes spaces and args not provided, it will auto-split',
      'timeout defaults to 30s, max 5 minutes',
      'Wrap paths with spaces in double quotes',
      'NEVER use -i (no interactive input)',
    ],
    examples: [
      {
        description: 'Run a simple command',
        params: { command: 'ls', args: ['-la'] },
      },
      {
        description: 'Run in a specific directory',
        params: {
          command: 'npm',
          args: ['install'],
          cwd: '/path/to/project',
        },
      },
      {
        description: 'Run with environment variables',
        params: {
          command: 'node',
          args: ['script.js'],
          env: { NODE_ENV: 'production' },
        },
      },
      {
        description: 'Auto-split command',
        params: {
          command: 'git status',
        },
      },
    ],
    important: [
      'Dangerous commands (rm, sudo, etc.) need user approval',
      'Each call is an isolated process',
      'Process exits when command finishes',
      'NEVER use find/grep/cat/sed—use dedicated tools instead',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    let {
      command,
      args,
      cwd = process.cwd(),
      timeout = 30000,
      env = {},
      capture_stderr = true,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      // 🔧 智能解析: 如果 command 包含空格且没有提供 args,自动拆分
      if (!args && command.includes(' ')) {
        const parts = command.split(/\s+/);
        command = parts[0];
        args = parts.slice(1);
        console.log(
          `[ShellTool] Auto-parsed command: "${params.command}" -> command="${command}", args=${JSON.stringify(args)}`
        );
      }

      const fullCommand =
        args && args.length > 0 ? `${command} ${args.join(' ')}` : command;
      updateOutput?.(`Executing command: ${fullCommand}`);

      signal.throwIfAborted();

      const startTime = Date.now();

      // 过滤掉 undefined 值以满足 Record<string, string> 类型
      const mergedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...process.env, ...env })) {
        if (value !== undefined) {
          mergedEnv[key] = value;
        }
      }

      const result = await executeCommand({
        command,
        args: args || [],
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

      // 如果命令失败，返回错误结果
      if (result.exit_code !== 0) {
        return {
          success: false,
          llmContent: `Command execution failed (exit code: ${result.exit_code})${result.stderr ? `\nStderr: ${result.stderr}` : ''}`,
          displayContent: formatDisplayMessage(result, metadata),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `Command execution failed (exit code: ${result.exit_code})`,
            details: result,
          },
          metadata,
        };
      }

      return {
        success: true,
        llmContent: result,
        displayContent: formatDisplayMessage(result, metadata),
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Command execution aborted',
          displayContent: '⚠️ 命令执行被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Operation aborted',
          },
        };
      }

      return {
        success: false,
        llmContent: `Command execution failed: ${error.message}`,
        displayContent: `❌ 命令执行失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '命令工具',
  tags: ['shell', 'command', 'execute', 'system'],

  /**
   * 提取签名内容：返回命令
   */
  extractSignatureContent: (params) => params.command,

  /**
   * 抽象权限规则：提取主命令并添加通配符
   */
  abstractPermissionRule: (params) => {
    const command = params.command.trim();
    const mainCommand = command.split(/\s+/)[0];
    return `${mainCommand}:*`;
  },
});

/**
 * 执行命令
 */
async function executeCommand(options: {
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

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
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

  let message =
    exit_code === 0 ? `✅ 命令执行完成: ${command}` : `❌ 命令执行失败: ${command}`;
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
