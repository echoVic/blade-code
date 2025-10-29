import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * Bash 会话上下文 (用于环境变量和工作目录复用)
 */
interface BashSessionContext {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Bash 会话管理器 - 仅存储上下文信息,不维护持久进程
 */
class BashSessionManager {
  private static instance: BashSessionManager;
  private sessionContexts: Map<string, BashSessionContext> = new Map();

  static getInstance(): BashSessionManager {
    if (!BashSessionManager.instance) {
      BashSessionManager.instance = new BashSessionManager();
    }
    return BashSessionManager.instance;
  }

  getOrCreateContext(
    sessionId: string,
    cwd?: string,
    env?: Record<string, string>
  ): BashSessionContext {
    if (!this.sessionContexts.has(sessionId)) {
      this.sessionContexts.set(sessionId, { cwd, env });
    }
    return this.sessionContexts.get(sessionId)!;
  }

  closeSession(sessionId: string): boolean {
    return this.sessionContexts.delete(sessionId);
  }

  getAllSessions(): string[] {
    return Array.from(this.sessionContexts.keys());
  }
}

/**
 * BashTool - Shell 命令执行工具
 * 采用业界标准做法:非交互式执行 + 进程事件监听
 */
export const bashTool = createTool({
  name: 'Bash',
  displayName: 'Bash 命令执行',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    command: ToolSchemas.command({
      description: '要执行的 bash 命令',
    }),
    session_id: z
      .string()
      .optional()
      .describe('会话 ID(可选,用于复用环境变量和工作目录)'),
    timeout: ToolSchemas.timeout(1000, 300000, 30000),
    cwd: z.string().optional().describe('工作目录(可选)'),
    env: ToolSchemas.environment(),
    run_in_background: z
      .boolean()
      .default(false)
      .describe('是否在后台运行(适合长时间执行的命令)'),
  }),

  // 工具描述
  description: {
    short: '执行 bash 命令,支持环境变量和工作目录复用',
    long: `使用非交互式 bash 执行命令。支持通过 session_id 复用环境变量和工作目录。每个命令独立执行,通过进程事件可靠地检测完成状态。`,
    usageNotes: [
      'IMPORTANT: 此工具用于终端操作(git, npm, docker 等)',
      'DO NOT 用于文件操作(读、写、编辑、搜索) - 应使用专用工具',
      'command 参数是必需的',
      '可通过 session_id 复用环境变量和工作目录',
      'timeout 默认 30 秒,最长 5 分钟',
      'run_in_background 用于长时间运行的命令',
      '文件路径包含空格时必须用双引号括起来',
      'NEVER 使用 -i 标志(不支持交互式输入)',
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
        description: '复用会话上下文',
        params: {
          command: 'git status',
          session_id: 'my-session',
        },
      },
    ],
    important: [
      '危险命令(rm -rf, sudo 等)需要用户确认',
      '后台命令需要手动终止',
      'NEVER 使用 find, grep, cat, sed 等命令 - 应使用专用工具',
    ],
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

      // 获取或创建会话上下文
      const sessionContext = sessionManager.getOrCreateContext(
        actualSessionId,
        cwd,
        env
      );

      updateOutput?.(`执行 Bash 命令: ${command}`);

      if (run_in_background) {
        return executeInBackground(command, actualSessionId, sessionContext);
      } else {
        return executeWithTimeout(
          command,
          actualSessionId,
          sessionContext,
          timeout,
          signal,
          updateOutput
        );
      }
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'AbortError') {
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
        llmContent: `命令执行失败: ${err.message}`,
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
   * 提取签名内容：使用 mainCommand:fullCommand 格式
   * 这样可以与 abstractPermissionRule 生成的规则格式匹配
   */
  extractSignatureContent: (params) => {
    const command = params.command.trim();
    const mainCommand = command.split(/\s+/)[0];
    return `${mainCommand}:${command}`;
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
  sessionId: string,
  sessionContext: BashSessionContext
): ToolResult {
  const bashProcess = spawn('bash', ['-c', command], {
    cwd: sessionContext.cwd || process.cwd(),
    env: { ...process.env, ...sessionContext.env },
    detached: true,
    stdio: 'ignore',
  });

  // 分离进程,让它在后台独立运行
  bashProcess.unref();

  // 生成 summary 用于流式显示
  const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
  const summary = `后台启动命令: ${cmdPreview}`;

  const metadata = {
    session_id: sessionId,
    command,
    background: true,
    pid: bashProcess.pid,
    message: '命令已在后台启动',
    summary, // 🆕 流式显示摘要
  };

  const displayMessage =
    `✅ 命令已在后台启动\n` +
    `🔑 会话 ID: ${sessionId}\n` +
    `🆔 进程 ID: ${bashProcess.pid}\n` +
    `⚠️ 后台进程需要手动终止`;

  return {
    success: true,
    llmContent: {
      session_id: sessionId,
      command,
      background: true,
      pid: bashProcess.pid,
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
  sessionId: string,
  sessionContext: BashSessionContext,
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
      cwd: sessionContext.cwd || process.cwd(),
      env: { ...process.env, ...sessionContext.env, BLADE_CLI: '1' },
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
            execution_time: executionTime,
          },
        });
        return;
      }

      // 如果被中止
      if (signal.aborted) {
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
        session_id: sessionId,
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
        session_id: sessionId,
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
          session_id: sessionId,
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
        llmContent: `命令执行失败: ${error.message}`,
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
  session_id: string;
  command: string;
  execution_time: number;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  const { stdout, stderr, session_id, command, execution_time, exit_code, signal } =
    result;

  let message = `✅ Bash 命令执行完成: ${command}`;
  message += `\n🔑 会话 ID: ${session_id}`;
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

// 导出会话管理器供其他工具使用
export { BashSessionManager };
