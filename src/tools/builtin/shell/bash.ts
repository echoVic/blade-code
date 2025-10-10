import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext } from '../../types/index.js';
import type { ConfirmationDetails, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zod-schemas.js';

/**
 * Bash 会话管理器
 */
class BashSessionManager {
  private static instance: BashSessionManager;
  private sessions: Map<string, ChildProcess> = new Map();
  private sessionOutputs: Map<string, string> = new Map();
  private sessionErrors: Map<string, string> = new Map();

  static getInstance(): BashSessionManager {
    if (!BashSessionManager.instance) {
      BashSessionManager.instance = new BashSessionManager();
    }
    return BashSessionManager.instance;
  }

  createSession(sessionId: string, cwd?: string, env?: Record<string, string>): ChildProcess {
    if (this.sessions.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 已存在`);
    }

    const bashProcess = spawn('bash', ['-i'], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.sessions.set(sessionId, bashProcess);
    this.sessionOutputs.set(sessionId, '');
    this.sessionErrors.set(sessionId, '');

    // 监听输出
    bashProcess.stdout.on('data', (data) => {
      const output = data.toString();
      const currentOutput = this.sessionOutputs.get(sessionId) || '';
      this.sessionOutputs.set(sessionId, currentOutput + output);
    });

    bashProcess.stderr.on('data', (data) => {
      const error = data.toString();
      const currentError = this.sessionErrors.get(sessionId) || '';
      this.sessionErrors.set(sessionId, currentError + error);
    });

    // 监听进程结束
    bashProcess.on('close', () => {
      this.sessions.delete(sessionId);
      this.sessionOutputs.delete(sessionId);
      this.sessionErrors.delete(sessionId);
    });

    return bashProcess;
  }

  getSession(sessionId: string): ChildProcess | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionOutput(sessionId: string): { stdout: string; stderr: string } {
    return {
      stdout: this.sessionOutputs.get(sessionId) || '',
      stderr: this.sessionErrors.get(sessionId) || '',
    };
  }

  clearSessionOutput(sessionId: string): void {
    this.sessionOutputs.set(sessionId, '');
    this.sessionErrors.set(sessionId, '');
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.kill();
      return true;
    }
    return false;
  }

  getAllSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

/**
 * BashTool - Shell 命令执行工具
 * 使用新的 Zod 验证设计
 */
export const bashTool = createTool({
  name: 'bash',
  displayName: 'Bash 会话执行',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    command: ToolSchemas.command({
      description: '要执行的 bash 命令',
    }),
    session_id: z
      .string()
      .optional()
      .describe('会话 ID（可选，用于复用会话）'),
    timeout: ToolSchemas.timeout(1000, 300000, 30000),
    cwd: z
      .string()
      .optional()
      .describe('工作目录（可选，仅在创建新会话时有效）'),
    env: ToolSchemas.environment(),
    run_in_background: z
      .boolean()
      .default(false)
      .describe('是否在后台运行（适合长时间执行的命令）'),
  }),

  // 工具描述
  description: {
    short: '在持久化的 bash 会话中执行命令，支持会话复用和后台执行',
    long: `提供持久化的 bash 会话执行功能。可以在同一会话中执行多个命令，保持环境变量和工作目录。支持后台执行长时间运行的命令。`,
    usageNotes: [
      'IMPORTANT: 此工具用于终端操作（git, npm, docker 等）',
      'DO NOT 用于文件操作（读、写、编辑、搜索）- 应使用专用工具',
      'command 参数是必需的',
      '可通过 session_id 复用会话，保持环境变量和工作目录',
      'timeout 默认 30 秒，最长 5 分钟',
      'run_in_background 用于长时间运行的命令',
      '后台命令需要使用 bash_output 工具查看输出',
      '文件路径包含空格时必须用双引号括起来',
      'NEVER 使用 -i 标志（不支持交互式输入）',
    ],
    examples: [
      {
        description: '执行简单命令',
        params: { command: 'ls -la' },
      },
      {
        description: '在特定目录执行命令',
        params: {
          command: 'npm install',
          cwd: '/path/to/project',
        },
      },
      {
        description: '在后台运行长时间命令',
        params: {
          command: 'npm run dev',
          run_in_background: true,
        },
      },
      {
        description: '复用会话执行多个命令',
        params: {
          command: 'export VAR=value',
          session_id: 'my-session',
        },
      },
    ],
    important: [
      '危险命令（rm -rf, sudo 等）需要用户确认',
      '后台命令需要手动终止',
      '会话在进程结束时自动清理',
      'NEVER 使用 find, grep, cat, sed 等命令 - 应使用专用工具',
    ],
  },

  // 需要用户确认（危险命令或后台执行）
  requiresConfirmation: async (params): Promise<ConfirmationDetails | null> => {
    const { command, run_in_background } = params;

    // 检查是否是危险命令
    const dangerousCommands = [
      'rm -rf',
      'sudo rm',
      'del /f',
      'format',
      'fdisk',
      'mkfs',
      'dd if=',
      'shred',
      'wipe',
      'sudo',
      'su -',
      'chmod 777',
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
      'killall',
      'pkill',
    ];

    const isDangerous = dangerousCommands.some((dangerous) =>
      command.toLowerCase().includes(dangerous)
    );

    if (isDangerous || run_in_background) {
      return {
        type: 'execute',
        title: run_in_background ? '确认后台执行命令' : '确认执行危险命令',
        message: `命令 "${command}" ${run_in_background ? '将在后台持续运行' : '可能对系统造成影响'}，确认要执行吗？`,
        risks: run_in_background
          ? ['命令将在后台持续运行', '需要手动终止后台进程', '可能消耗系统资源']
          : ['命令可能修改或删除文件', '命令可能影响系统配置', '操作可能不可逆'],
      };
    }

    return null;
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      command,
      session_id,
      timeout = 30000,
      cwd,
      env,
      run_in_background = false,
    } = params;
    const { signal, updateOutput } = context;

    try {
      const sessionManager = BashSessionManager.getInstance();
      const actualSessionId = session_id || randomUUID();

      updateOutput?.(`在 Bash 会话中执行: ${command}`);

      // 获取或创建会话
      let bashProcess = sessionManager.getSession(actualSessionId);
      if (!bashProcess) {
        bashProcess = sessionManager.createSession(actualSessionId, cwd, env);
        // 等待 bash 初始化
        await new Promise((resolve) => setTimeout(resolve, 1000));
        sessionManager.clearSessionOutput(actualSessionId);
      }

      signal.throwIfAborted();

      if (run_in_background) {
        return executeInBackground(
          bashProcess,
          command,
          actualSessionId,
          sessionManager,
          updateOutput
        );
      } else {
        return executeWithTimeout(
          bashProcess,
          command,
          actualSessionId,
          sessionManager,
          timeout,
          signal,
          updateOutput
        );
      }
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
  tags: ['bash', 'shell', 'session', 'persistent'],
});

/**
 * 后台执行命令
 */
function executeInBackground(
  bashProcess: ChildProcess,
  command: string,
  sessionId: string,
  sessionManager: BashSessionManager,
  updateOutput?: (output: string) => void
): ToolResult {
  // 清除之前的输出
  sessionManager.clearSessionOutput(sessionId);

  // 执行命令
  bashProcess.stdin!.write(`${command}\n`);

  const metadata = {
    session_id: sessionId,
    command,
    background: true,
    message: '命令已在后台启动',
  };

  const displayMessage =
    `✅ 命令已在后台会话 ${sessionId} 中启动\n` +
    `📝 使用 bash_output 工具查看输出\n` +
    `🛑 使用 kill_bash 工具终止会话`;

  return {
    success: true,
    llmContent: {
      session_id: sessionId,
      command,
      background: true,
    },
    displayContent: displayMessage,
    metadata,
  };
}

/**
 * 带超时的命令执行
 */
async function executeWithTimeout(
  bashProcess: ChildProcess,
  command: string,
  sessionId: string,
  sessionManager: BashSessionManager,
  timeout: number,
  signal: AbortSignal,
  updateOutput?: (output: string) => void
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // 清除之前的输出
    sessionManager.clearSessionOutput(sessionId);

    // 设置超时
    const timeoutHandle = setTimeout(() => {
      const { stdout, stderr } = sessionManager.getSessionOutput(sessionId);
      resolve({
        success: false,
        llmContent: `命令执行超时 (${timeout}ms)`,
        displayContent: `⏱️ 命令执行超时 (${timeout}ms)\n输出: ${stdout}\n错误: ${stderr}`,
        error: {
          type: ToolErrorType.TIMEOUT_ERROR,
          message: '命令执行超时',
        },
        metadata: {
          session_id: sessionId,
          command,
          timeout: true,
          stdout,
          stderr,
          execution_time: timeout,
        },
      });
    }, timeout);

    // 处理中止信号
    const abortHandler = () => {
      clearTimeout(timeoutHandle);
      const { stdout, stderr } = sessionManager.getSessionOutput(sessionId);
      resolve({
        success: false,
        llmContent: '命令执行被用户中止',
        displayContent: `⚠️ 命令执行被用户中止\n输出: ${stdout}\n错误: ${stderr}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: '操作被中止',
        },
        metadata: {
          session_id: sessionId,
          command,
          aborted: true,
          stdout,
          stderr,
          execution_time: Date.now() - startTime,
        },
      });
    };

    signal.addEventListener('abort', abortHandler);

    // 监听输出变化
    const outputChecker = setInterval(() => {
      const { stdout, stderr } = sessionManager.getSessionOutput(sessionId);

      // 检查命令是否完成（简单的提示符检查）
      if (
        stdout.includes('$ ') ||
        stdout.includes('# ') ||
        stdout.endsWith('\n$ ') ||
        stdout.endsWith('\n# ')
      ) {
        clearInterval(outputChecker);
        clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', abortHandler);

        const executionTime = Date.now() - startTime;
        const metadata = {
          session_id: sessionId,
          command,
          execution_time: executionTime,
          stdout_length: stdout.length,
          stderr_length: stderr.length,
          has_stderr: stderr.length > 0,
        };

        const displayMessage = formatDisplayMessage({
          stdout,
          stderr,
          session_id: sessionId,
          command,
          execution_time: executionTime,
        });

        resolve({
          success: true,
          llmContent: {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            session_id: sessionId,
            execution_time: executionTime,
          },
          displayContent: displayMessage,
          metadata,
        });
      }
    }, 100);

    // 执行命令
    bashProcess.stdin!.write(`${command}\n`);
  });
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(result: {
  stdout: string;
  stderr: string;
  session_id: string;
  command: string;
  execution_time: number;
}): string {
  const { stdout, stderr, session_id, command, execution_time } = result;

  let message = `✅ Bash 命令执行完成: ${command}`;
  message += `\n🔑 会话 ID: ${session_id}`;
  message += `\n⏱️ 执行时间: ${execution_time}ms`;

  if (stdout && stdout.trim()) {
    const cleanOutput = stdout.replace(/^\$\s*/gm, '').trim();
    if (cleanOutput) {
      message += `\n📤 输出:\n${cleanOutput}`;
    }
  }

  if (stderr && stderr.trim()) {
    message += `\n⚠️ 错误输出:\n${stderr.trim()}`;
  }

  return message;
}

// 导出会话管理器供其他工具使用
export { BashSessionManager };
