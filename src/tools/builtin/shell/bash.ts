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
      'Execute bash commands in a persistent shell session with optional timeout',
    long: `Executes bash commands with proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing commands:

1. Directory Verification:
   - If the command will create new directories or files, first use 'ls' to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use 'ls foo' to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     * cd "/Users/name/My Documents" (correct)
     * cd /Users/name/My Documents (incorrect - will fail)
     * python "/path/with spaces/script.py" (correct)
     * python /path/with spaces/script.py (incorrect - will fail)`,
    usageNotes: [
      'The command argument is required',
      'You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 30000ms (30 seconds)',
      'It is very helpful if you write a clear, concise description of what this command does in 5-10 words',
      'If the output exceeds 30000 characters, output will be truncated before being returned to you',
      'You can use the run_in_background parameter to run the command in the background, which allows you to continue working while the command runs. You can monitor the output using the BashOutput tool. You do not need to use "&" at the end of the command when using this parameter',
      'Avoid using Bash with the find, grep, cat, head, tail, sed, awk, or echo commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:',
      '  - File search: Use Glob (NOT find or ls)',
      '  - Content search: Use Grep (NOT grep or rg)',
      '  - Read files: Use Read (NOT cat/head/tail)',
      '  - Edit files: Use Edit (NOT sed/awk)',
      '  - Write files: Use Write (NOT echo >/cat <<EOF)',
      '  - Communication: Output text directly (NOT echo/printf)',
      'When issuing multiple commands:',
      '  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel',
      '  - If the commands depend on each other and must run sequentially, use a single Bash call with "&&" to chain them together (e.g., git add . && git commit -m "message" && git push). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead',
      '  - Use ";" only when you need to run commands sequentially but don\'t care if earlier commands fail',
      '  - DO NOT use newlines to separate commands (newlines are ok in quoted strings)',
      'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of cd. You may use cd if the User explicitly requests it',
      '  Good example: pytest /foo/bar/tests',
      '  Bad example: cd /foo/bar && pytest tests',
    ],
    examples: [
      {
        description: 'Run a simple command',
        params: { command: 'ls -la', description: 'List files in current directory' },
      },
      {
        description: 'Temporarily change working directory (this command only)',
        params: {
          command: 'npm install',
          cwd: '/path/to/project',
          description: 'Install package dependencies',
        },
      },
      {
        description: 'Persistently change working directory',
        params: {
          command: 'cd /path/to/project && npm install',
          description: 'Change directory and install dependencies',
        },
      },
      {
        description: 'Run a long-running command in background',
        params: {
          command: 'npm run dev',
          run_in_background: true,
          description: 'Start development server in background',
        },
      },
      {
        description: 'Run multiple independent commands in parallel',
        params: { command: 'git status', description: 'Show working tree status' },
      },
    ],
    important: [
      'Committing changes with git:',
      '  - Only create commits when requested by the user. If unclear, ask first',
      '  - Git Safety Protocol:',
      '    * NEVER update the git config',
      '    * NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them',
      '    * NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it',
      '    * NEVER run force push to main/master, warn the user if they request it',
      '    * Avoid git commit --amend. ONLY use --amend when either (1) user explicitly requested amend OR (2) adding edits from pre-commit hook',
      '    * Before amending: ALWAYS check authorship (git log -1 --format="%an %ae")',
      '    * NEVER commit changes unless the user explicitly asks you to',
      '  - When creating commits:',
      '    1. Run git status, git diff, and git log in parallel to understand changes',
      '    2. Analyze staged changes and draft a concise commit message (1-2 sentences) focusing on "why" rather than "what"',
      '    3. Add relevant untracked files, create the commit, and run git status to verify',
      '    4. Always pass commit message via HEREDOC format',
      '  - DO NOT push to remote repository unless explicitly requested',
      '  - NEVER use git commands with the -i flag (no interactive input supported)',
      '  - If no changes to commit, do not create an empty commit',
      'Creating pull requests:',
      '  - Use the gh command for ALL GitHub-related tasks',
      '  - When creating a PR:',
      '    1. Run git status, git diff, and git log in parallel to understand branch changes',
      '    2. Analyze all commits (not just the latest) and draft a PR summary',
      '    3. Create new branch if needed, push with -u flag, and create PR using gh pr create with HEREDOC body format',
      '  - Return the PR URL when done',
      'Other important notes:',
      '  - Dangerous commands (rm -rf, sudo, etc.) require user confirmation',
      '  - Background commands require manual termination using KillShell',
      '  - NEVER use find, grep, cat, sed, etc. — use dedicated tools instead',
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
