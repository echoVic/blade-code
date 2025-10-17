import { spawn } from 'child_process';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

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
 * ShellTool - Shell 命令执行工具
 * 使用新的 Zod 验证设计
 */
export const shellTool = createTool({
  name: 'Shell',
  displayName: 'Shell命令执行',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    command: ToolSchemas.command({
      description: '要执行的命令',
    }),
    args: z.array(z.string().min(1)).optional().describe('命令参数列表(可选)'),
    cwd: z.string().optional().describe('执行目录(可选,默认当前目录)'),
    timeout: ToolSchemas.timeout(1000, 300000, 30000),
    env: ToolSchemas.environment(),
    capture_stderr: z.boolean().default(true).describe('是否捕获错误输出'),
  }),

  // 工具描述
  description: {
    short: '执行单次shell命令并返回执行结果，支持超时控制和环境变量',
    long: `提供单次命令执行功能。适合执行独立的系统命令，每次调用都是新的进程。支持参数列表、工作目录、环境变量等配置。`,
    usageNotes: [
      'IMPORTANT: 此工具用于终端操作(git, npm, docker等)',
      'DO NOT 用于文件操作(读、写、编辑、搜索) - 应使用专用工具',
      'command 参数是必需的',
      '支持通过 args 传递命令参数',
      '如果 command 包含空格且未提供 args，会自动拆分',
      'timeout 默认 30 秒，最长 5 分钟',
      '文件路径包含空格时必须用双引号括起来',
      'NEVER 使用 -i 标志(不支持交互式输入)',
    ],
    examples: [
      {
        description: '执行简单命令',
        params: { command: 'ls', args: ['-la'] },
      },
      {
        description: '在特定目录执行命令',
        params: {
          command: 'npm',
          args: ['install'],
          cwd: '/path/to/project',
        },
      },
      {
        description: '带环境变量执行',
        params: {
          command: 'node',
          args: ['script.js'],
          env: { NODE_ENV: 'production' },
        },
      },
      {
        description: '自动拆分命令',
        params: {
          command: 'git status',
        },
      },
    ],
    important: [
      '危险命令(rm, sudo等)需要用户确认',
      '每次调用都是独立的进程',
      '命令执行完成后进程自动退出',
      'NEVER 使用 find, grep, cat, sed 等命令 - 应使用专用工具',
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
    const { signal, updateOutput } = context;

    try {
      // 🔧 智能解析: 如果 command 包含空格且没有提供 args,自动拆分
      if (!args && command.includes(' ')) {
        const parts = command.split(/\s+/);
        command = parts[0];
        args = parts.slice(1);
        console.log(
          `[ShellTool] 自动解析命令: "${params.command}" -> command="${command}", args=${JSON.stringify(args)}`
        );
      }

      const fullCommand =
        args && args.length > 0 ? `${command} ${args.join(' ')}` : command;
      updateOutput?.(`执行命令: ${fullCommand}`);

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
          llmContent: `命令执行失败 (退出码: ${result.exit_code})${result.stderr ? `\n错误输出: ${result.stderr}` : ''}`,
          displayContent: formatDisplayMessage(result, metadata),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `命令执行失败 (退出码: ${result.exit_code})`,
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
          llmContent: '命令执行被中止',
          displayContent: '⚠️ 命令执行被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `命令执行失败: ${error.message}`,
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
