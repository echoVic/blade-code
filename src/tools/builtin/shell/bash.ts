import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { BackgroundShellManager } from './BackgroundShellManager.js';

/**
 * Bash Tool - Shell command executor
 *
 * 设计理念：
 * - 每次命令独立执行（非持久会话）
 * - 工作目录通过 cwd 参数临时设置，或通过 `cd && command` 命令链持久改变
 * - 环境变量通过 env 参数临时设置，或通过 `export` 命令持久改变
 * - 后台进程使用唯一 ID 管理
 */
export const bashTool = createTool({
  name: 'Bash',
  displayName: 'Bash Command',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    command: ToolSchemas.command({
      description: 'Bash command to execute',
    }),
    timeout: ToolSchemas.timeout(1000, 300000, 30000),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working directory (optional; applies only to this command). To persist, use cd'
      ),
    env: ToolSchemas.environment(),
    run_in_background: z
      .boolean()
      .default(false)
      .describe('Run in background (suitable for long-running commands)'),
  }),

  // 工具描述
  description: {
    short:
      'Execute bash commands; supports environment variables and working directory',
    long: `Execute commands using non-interactive bash. Each command runs independently with completion detected via process events. Working directory and environment variables can be set temporarily via parameters or persistently via cd/export.`,
    usageNotes: [
      'IMPORTANT: Use this tool for terminal operations (git, npm, docker, etc.)',
      'DO NOT use for file operations (read, write, edit, search) — use dedicated tools',
      'The command parameter is required',
      'Use cd to change working directory; use export to set environment variables (persistent)',
      'cwd and env parameters apply only to this command (temporary override)',
      'timeout defaults to 30 seconds, max 5 minutes',
      'run_in_background is for long-running commands',
      'Wrap file paths containing spaces in double quotes',
      'NEVER use the -i flag (no interactive input)',
    ],
    examples: [
      {
        description: 'Run a simple command',
        params: { command: 'ls -la' },
      },
      {
        description: 'Temporarily change working directory (this command only)',
        params: {
          command: 'npm install',
          cwd: '/path/to/project',
        },
      },
      {
        description: 'Persistently change working directory',
        params: {
          command: 'cd /path/to/project && npm install',
        },
      },
      {
        description: 'Run a long-running command in background',
        params: {
          command: 'npm run dev',
          run_in_background: true,
        },
      },
    ],
    important: [
      'Dangerous commands (rm -rf, sudo, etc.) require user confirmation',
      'Background commands require manual termination',
      'NEVER use find, grep, cat, sed, etc. — use dedicated tools',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { command, timeout = 30000, cwd, env, run_in_background = false } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      updateOutput?.(`Executing Bash command: ${command}`);

      if (run_in_background) {
        return executeInBackground(command, cwd, env);
      } else {
        return executeWithTimeout(command, cwd, env, timeout, signal, updateOutput);
      }
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'AbortError') {
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
        llmContent: `Command execution failed: ${err.message}`,
        displayContent: `❌ 命令执行失败: ${err.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: err,
        },
      };
    }
  },

  version: '2.0.0',
  category: '命令工具',
  tags: ['bash', 'shell', 'non-interactive', 'event-driven'],

  /**
   * 提取签名内容：返回完整命令
   * 用于显示和权限签名构建
   */
  extractSignatureContent: (params) => {
    return params.command.trim();
  },

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
 * 后台执行命令
 */
function executeInBackground(
  command: string,
  cwd?: string,
  env?: Record<string, string>
): ToolResult {
  const manager = BackgroundShellManager.getInstance();
  const backgroundProcess = manager.startBackgroundProcess({
    command,
    sessionId: randomUUID(), // 每个后台进程使用唯一 ID
    cwd: cwd || process.cwd(),
    env,
  });

  const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
  const summary = `后台启动命令: ${cmdPreview}`;

  const metadata = {
    command,
    background: true,
    pid: backgroundProcess.pid,
    bash_id: backgroundProcess.id,
    shell_id: backgroundProcess.id,
    message: '命令已在后台启动',
    summary,
  };

  const displayMessage =
    `✅ 命令已在后台启动\n` +
    `🆔 进程 ID: ${backgroundProcess.pid}\n` +
    `💡 Bash ID: ${backgroundProcess.id}\n` +
    `⚠️ 使用 BashOutput/KillShell 管理后台进程`;

  return {
    success: true,
    llmContent: {
      command,
      background: true,
      pid: backgroundProcess.pid,
      bash_id: backgroundProcess.id,
      shell_id: backgroundProcess.id,
    },
    displayContent: displayMessage,
    metadata,
  };
}

/**
 * 带超时的命令执行 - 使用进程事件监听
 */
async function executeWithTimeout(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeout: number,
  signal: AbortSignal,
  updateOutput?: (output: string) => void
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // 创建进程
    const bashProcess = spawn('bash', ['-c', command], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env, BLADE_CLI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 收集 stdout
    bashProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    // 收集 stderr
    bashProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 设置超时
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      bashProcess.kill('SIGTERM');

      // 如果 SIGTERM 无效,强制 SIGKILL
      setTimeout(() => {
        if (!bashProcess.killed) {
          bashProcess.kill('SIGKILL');
        }
      }, 1000);
    }, timeout);

    // 处理中止信号
    const abortHandler = () => {
      bashProcess.kill('SIGTERM');
      clearTimeout(timeoutHandle);
    };

    // 兼容不同版本的 AbortSignal API
    if (signal.addEventListener) {
      signal.addEventListener('abort', abortHandler);
    } else if ('onabort' in signal) {
      (signal as unknown as { onabort: () => void }).onabort = abortHandler;
    }

    // 监听进程完成事件 - 业界标准做法
    bashProcess.on('close', (code, sig) => {
      clearTimeout(timeoutHandle);
      // 移除中止监听器
      if (signal.removeEventListener) {
        signal.removeEventListener('abort', abortHandler);
      } else if ('onabort' in signal) {
        (signal as unknown as { onabort: null }).onabort = null;
      }

      const executionTime = Date.now() - startTime;

      // 如果超时
      if (timedOut) {
        resolve({
          success: false,
          llmContent: `Command execution timed out (${timeout}ms)`,
          displayContent: `⏱️ 命令执行超时 (${timeout}ms)\n输出: ${stdout}\n错误: ${stderr}`,
          error: {
            type: ToolErrorType.TIMEOUT_ERROR,
            message: '命令执行超时',
          },
          metadata: {
            command,
            timeout: true,
            stdout,
            stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      // 如果被中止
      if (signal.aborted) {
        resolve({
          success: false,
          llmContent: 'Command execution aborted by user',
          displayContent: `⚠️ 命令执行被用户中止\n输出: ${stdout}\n错误: ${stderr}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
          metadata: {
            command,
            aborted: true,
            stdout,
            stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      // 正常完成
      // 生成 summary 用于流式显示
      const cmdPreview =
        command.length > 30 ? `${command.substring(0, 30)}...` : command;
      const summary =
        code === 0
          ? `执行命令成功 (${executionTime}ms): ${cmdPreview}`
          : `执行命令完成 (退出码 ${code}, ${executionTime}ms): ${cmdPreview}`;

      const metadata = {
        command,
        execution_time: executionTime,
        exit_code: code,
        signal: sig,
        stdout_length: stdout.length,
        stderr_length: stderr.length,
        has_stderr: stderr.length > 0,
        summary, // 🆕 流式显示摘要
      };

      const displayMessage = formatDisplayMessage({
        stdout,
        stderr,
        command,
        execution_time: executionTime,
        exit_code: code,
        signal: sig,
      });

      // 即使退出码非零,也认为执行成功(因为命令确实执行了)
      resolve({
        success: true,
        llmContent: {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          execution_time: executionTime,
          exit_code: code,
          signal: sig,
        },
        displayContent: displayMessage,
        metadata,
      });
    });

    // 监听进程错误
    bashProcess.on('error', (error) => {
      clearTimeout(timeoutHandle);
      // 移除中止监听器
      if (signal.removeEventListener) {
        signal.removeEventListener('abort', abortHandler);
      } else if ('onabort' in signal) {
        (signal as unknown as { onabort: null }).onabort = null;
      }

      resolve({
        success: false,
        llmContent: `Command execution failed: ${error.message}`,
        displayContent: `❌ 命令执行失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      });
    });
  });
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(result: {
  stdout: string;
  stderr: string;
  command: string;
  execution_time: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  const { stdout, stderr, command, execution_time, exit_code, signal } = result;

  let message = `✅ Bash 命令执行完成: ${command}`;
  message += `\n⏱️ 执行时间: ${execution_time}ms`;
  message += `\n📊 退出码: ${exit_code ?? 'N/A'}`;

  if (signal) {
    message += `\n⚡ 信号: ${signal}`;
  }

  if (stdout && stdout.trim()) {
    message += `\n📤 输出:\n${stdout.trim()}`;
  }

  if (stderr && stderr.trim()) {
    message += `\n⚠️ 错误输出:\n${stderr.trim()}`;
  }

  return message;
}
