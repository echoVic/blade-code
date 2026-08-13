import { isAbsolute, resolve } from 'node:path';
import { getTerminalService, isAcpMode } from '../../../acp/AcpServiceContext.js';
import {
  type ForegroundProcessOwnership,
  prepareForegroundProcess,
} from '../../../context/storage/DurableForegroundProcess.js';
import { Default, Type } from '../../../schema/index.js';
import { getCwd } from '../../../utils/cwd.js';
import {
  stripSafeEnvVars,
  stripSafeWrappers,
} from '../../../utils/shell/commandNormalizer.js';
import { isReadOnlyAuditSubagent } from '../../../utils/shell/readOnlyAudit.js';
import { createTool } from '../../core/createTool.js';
import type {
  BashBackgroundMetadata,
  BashForegroundMetadata,
  ExecutionContext,
  NodeError,
  ToolResult,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { BackgroundShellManager } from './BackgroundShellManager.js';
import { OutputTruncator } from './OutputTruncator.js';
import { ShellOutputCapture } from './ShellOutputCapture.js';
import {
  type ProjectedShellOutput,
  projectShellOutput,
} from './ShellOutputProjection.js';
import {
  isWorkspaceSandboxRuntimeFailure,
  type SandboxedCommand,
  WorkspaceSandboxBoundaryError,
  WorkspaceSandboxUnavailableError,
  workspaceWriteSandbox,
} from './WorkspaceWriteSandbox.js';

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
  isConcurrencySafe: false, // 命令执行，可能有副作用
  parallelism: 'shared', // 独立命令并行；execute bucket 维持进程级上限

  schema: Type.Object({
    command: ToolSchemas.command({
      description: 'Bash command to execute',
    }),
    timeout: ToolSchemas.timeout(1000, 300000, 30000),
    cwd: Type.Optional(
      Type.String({
        description:
          'Working directory (optional; applies only to this command). To persist, use cd',
      })
    ),
    env: ToolSchemas.environment(),
    run_in_background: Default(
      Type.Boolean({
        description: 'Run in background (suitable for long-running commands)',
      }),
      false
    ),
  }),

  // 工具描述
  description: {
    short: 'Execute bash commands in a persistent shell session with optional timeout',
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
      'You can use the run_in_background parameter to run the command in the background, which allows you to continue working while the command runs. You can monitor the output using the TaskOutput tool. You do not need to use "&" at the end of the command when using this parameter',
      'Background commands accept input through WriteStdin. Include a newline for line-oriented programs, and set close_stdin=true when the process must receive EOF before it can finish',
      'Avoid using Bash with the find, grep, cat, head, tail, sed, awk, or echo commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:',
      ' - File search: Use Glob (NOT find or ls)',
      ' - Content search: Use Grep (NOT grep or rg)',
      ' - Read files: Use Read (NOT cat/head/tail)',
      ' - Edit files: Use Edit (NOT sed/awk)',
      ' - Write files: Use Write (NOT echo >/cat <<EOF)',
      ' - Communication: Output text directly (NOT echo/printf)',
      'When issuing multiple commands:',
      ' - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel',
      ' - If the commands depend on each other and must run sequentially, use a single Bash call with "&&" to chain them together (e.g., git add . && git commit -m "message" && git push). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead',
      ' - Use ";" only when you need to run commands sequentially but don\'t care if earlier commands fail',
      ' - DO NOT use newlines to separate commands (newlines are ok in quoted strings)',
      'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of cd. You may use cd if the User explicitly requests it',
      ' Good example: pytest /foo/bar/tests',
      ' Bad example: cd /foo/bar && pytest tests',
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
      ' - Only create commits when requested by the user. If unclear, ask first',
      ' - Git Safety Protocol:',
      ' * NEVER update the git config',
      ' * NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them',
      ' * NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it',
      ' * NEVER run force push to main/master, warn the user if they request it',
      ' * Avoid git commit --amend. ONLY use --amend when either (1) user explicitly requested amend OR (2) adding edits from pre-commit hook',
      ' * Before amending: ALWAYS check authorship (git log -1 --format="%an %ae")',
      ' * NEVER commit changes unless the user explicitly asks you to',
      ' - When creating commits:',
      ' 1. Run git status, git diff, and git log in parallel to understand changes',
      ' 2. Analyze staged changes and draft a concise commit message (1-2 sentences) focusing on "why" rather than "what"',
      ' 3. Add relevant untracked files, create the commit, and run git status to verify',
      ' 4. Always pass commit message via HEREDOC format',
      ' - DO NOT push to remote repository unless explicitly requested',
      ' - NEVER use git commands with the -i flag (no interactive input supported)',
      ' - If no changes to commit, do not create an empty commit',
      'Creating pull requests:',
      ' - Use the gh command for ALL GitHub-related tasks',
      ' - When creating a PR:',
      ' 1. Run git status, git diff, and git log in parallel to understand branch changes',
      ' 2. Analyze all commits (not just the latest) and draft a PR summary',
      ' 3. Create new branch if needed, push with -u flag, and create PR using gh pr create with HEREDOC body format',
      ' - Return the PR URL when done',
      'Other important notes:',
      ' - Dangerous commands (rm -rf, sudo, etc.) require user confirmation',
      ' - Background commands require manual termination using KillShell',
      ' - NEVER use find, grep, cat, sed, etc. — use dedicated tools instead',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { command, timeout = 30000, cwd, env, run_in_background = false } = params;
    const { updateOutput } = context;
    const readOnlyAudit = isReadOnlyAuditSubagent(context.subagentType);
    const effectiveEnv = readOnlyAudit
      ? {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0',
        }
      : {
          ...context.environment,
          ...env,
        };
    const signal = context.signal ?? new AbortController().signal;
    const workspaceRoot = context.workspaceRoot ?? getCwd();
    const effectiveCwd =
      cwd === undefined
        ? workspaceRoot
        : isAbsolute(cwd)
          ? cwd
          : resolve(workspaceRoot, cwd);
    const foregroundOwnership = context.sessionId
      ? {
          sessionId: context.sessionId,
          projectPath: workspaceRoot,
        }
      : undefined;

    try {
      updateOutput?.('Executing Bash command...');
      const acpMode = isAcpMode(context.sessionId);
      const sandboxedCommand =
        readOnlyAudit && !acpMode
          ? await workspaceWriteSandbox.prepare({
              command,
              cwd: effectiveCwd,
              workspaceRoot,
              access: 'workspace-read-only',
              signal,
            })
          : context.worktreeActive
            ? await workspaceWriteSandbox.prepare({
                command,
                cwd: effectiveCwd,
                workspaceRoot,
                access: 'workspace-write',
                signal,
              })
            : undefined;

      if (run_in_background) {
        return await executeInBackground(
          command,
          effectiveCwd,
          effectiveEnv,
          context.sessionId,
          workspaceRoot,
          sandboxedCommand
        );
      }

      // 检查是否在 ACP 模式下运行
      const useAcp = acpMode && !sandboxedCommand;
      if (useAcp) {
        // ACP 模式：通过 IDE 终端执行命令
        updateOutput?.('通过 IDE 终端执行命令...');
        return await executeWithAcpTerminal(
          command,
          effectiveCwd,
          effectiveEnv,
          timeout,
          signal,
          context.sessionId,
          updateOutput,
          foregroundOwnership
        );
      } else {
        return await executeWithTimeout(
          command,
          effectiveCwd,
          effectiveEnv,
          timeout,
          signal,
          sandboxedCommand,
          foregroundOwnership
        );
      }
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Command execution aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Operation aborted',
          },
        };
      }
      if (
        error instanceof WorkspaceSandboxUnavailableError ||
        error instanceof WorkspaceSandboxBoundaryError
      ) {
        return {
          success: false,
          llmContent:
            `Workspace sandbox blocked Bash execution: ${err.message}. ` +
            'The command was not started.',
          error: {
            type: ToolErrorType.PERMISSION_DENIED,
            message: err.message,
          },
          metadata: {
            command,
            sandbox_required: true,
            sandboxed: false,
            summary: 'Workspace sandbox unavailable; command not started',
          },
        };
      }

      return {
        success: false,
        llmContent: `Command execution failed: ${err.message}`,
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
   * 抽象权限规则：智能提取命令模式
   *
   * 设计目标：保留命令的"意图"部分，对变化的参数部分使用通配符
   *
   * 策略：
   * 1. 对于 `cmd run/exec/test xxx args` 类型：保留前3个词 + 通配符
   * 例如: `bun run test:unit foo.ts` -> `bun run test:unit *`
   * 2. 对于其他带参数的命令：保留前2个词 + 通配符
   * 例如: `node script.js arg` -> `node script.js *`
   * 3. 对于无额外参数的命令：精确匹配
   * 例如: `npm run build` -> `npm run build`
   * 例如: `git status` -> `git status`
   * 4. 单词命令：直接使用工具名前缀匹配
   * 例如: `ls` -> `` (空字符串，使用工具名前缀匹配 Bash)
   *
   * 注意：使用空格而非冒号，避免被 parseParamPairs 误解析为键值对
   */
  abstractPermissionRule: (params) => {
    // 先规范化：剥离安全环境变量和 wrapper
    const command = stripSafeEnvVars(stripSafeWrappers(params.command.trim()));
    const parts = command.split(/\s+/);

    if (parts.length === 1) {
      // 单词命令: ls -> ls
      return parts[0];
    }

    // 检查是否是 run/exec/test 子命令模式
    const runLikeSubcommands = ['run', 'exec', 'test', 'start', 'build', 'dev'];
    if (runLikeSubcommands.includes(parts[1])) {
      if (parts.length === 2) {
        // npm run -> npm run
        return `${parts[0]} ${parts[1]}`;
      }
      // bun test foo.ts -> bun test *
      // bun run build -> bun run build (但 npm run build:dev -> npm run build:dev 也可接受)
      // 统一使用通配符，更宽松
      return `${parts[0]} ${parts[1]} *`;
    }

    if (parts.length === 2) {
      // git status -> git status
      return `${parts[0]} ${parts[1]}`;
    }

    // 有额外参数的命令：保留前2个词 + 通配符
    // node script.js arg -> node script.js *
    return `${parts[0]} ${parts[1]} *`;
  },
});

/**
 * 后台执行命令
 */
async function executeInBackground(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
  sessionId?: string,
  projectPath: string = getCwd(),
  sandboxedCommand?: SandboxedCommand
): Promise<ToolResult> {
  if (!sessionId) {
    sandboxedCommand?.cleanup();
    return {
      success: false,
      llmContent: 'Background Bash requires an active session',
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: '后台命令缺少 session 上下文',
      },
      metadata: { summary: '后台命令启动失败: 缺少 session' },
    };
  }

  const manager = BackgroundShellManager.getInstance();
  const backgroundProcess = await manager.startBackgroundProcess({
    command,
    sessionId,
    projectPath,
    cwd: cwd || getCwd(),
    env,
    sandboxedCommand,
  });

  const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
  const summary = `后台启动命令: ${cmdPreview}`;

  const metadata: BashBackgroundMetadata = {
    command,
    background: true,
    pid: backgroundProcess.pid ?? 0,
    bash_id: backgroundProcess.id,
    shell_id: backgroundProcess.id,
    message: '命令已在后台启动',
    sandboxed: Boolean(sandboxedCommand),
    summary,
  };

  return {
    success: true,
    llmContent: {
      command,
      background: true,
      pid: backgroundProcess.pid,
      bash_id: backgroundProcess.id,
      shell_id: backgroundProcess.id,
    },
    metadata,
  };
}

function formatCommandFailure(
  exitCode: number | null,
  signal: NodeJS.Signals | null | undefined,
  stdout: string,
  stderr: string
): string {
  const reason =
    exitCode === null
      ? `Command terminated${signal ? ` by signal ${signal}` : ''}`
      : `Command exited with code ${exitCode}`;
  const diagnostics = [
    stderr ? `stderr:\n${stderr}` : '',
    stdout ? `stdout:\n${stdout}` : '',
  ].filter(Boolean);

  return diagnostics.length > 0 ? `${reason}\n${diagnostics.join('\n')}` : reason;
}

/**
 * 使用 ACP 终端服务执行命令
 * 通过 IDE 的终端执行命令，支持更好的 IDE 集成体验
 */
async function executeWithAcpTerminal(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeout: number,
  signal: AbortSignal,
  sessionId?: string,
  updateOutput?: (output: string) => void,
  ownership?: ForegroundProcessOwnership
): Promise<ToolResult> {
  const startTime = Date.now();

  try {
    const terminalService = getTerminalService(sessionId);
    const result = await terminalService.execute(command, {
      cwd: cwd || getCwd(),
      env,
      timeout,
      signal,
      onOutput: (output) => {
        updateOutput?.(output);
      },
      durableOwnership: ownership,
    });

    const executionTime = Date.now() - startTime;

    // 检查是否被中止（支持多种错误消息格式）
    if (
      signal.aborted ||
      result.error === 'Command was aborted' ||
      result.error === 'Command was terminated'
    ) {
      return {
        success: false,
        llmContent: 'Command execution aborted by user',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: '操作被中止',
        },
        metadata: {
          command,
          aborted: true,
          stdout: result.stdout,
          stderr: result.stderr,
          execution_time: executionTime,
        },
      };
    }

    // 检查是否超时（支持多种错误消息格式）
    if (result.error === 'Command timed out') {
      return {
        success: false,
        llmContent: `Command execution timed out (${timeout}ms)`,
        error: {
          type: ToolErrorType.TIMEOUT_ERROR,
          message: '命令执行超时',
        },
        metadata: {
          command,
          timeout: true,
          stdout: result.stdout,
          stderr: result.stderr,
          execution_time: executionTime,
        },
      };
    }

    // 生成 summary 用于流式显示
    const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
    const summary =
      result.exitCode === 0
        ? `执行命令成功 (${executionTime}ms): ${cmdPreview}`
        : `执行命令完成 (退出码 ${result.exitCode}, ${executionTime}ms): ${cmdPreview}`;

    const metadata: BashForegroundMetadata = {
      command,
      execution_time: executionTime,
      exit_code: result.exitCode,
      stdout_length: result.stdout.length,
      stderr_length: result.stderr.length,
      has_stderr: result.stderr.length > 0,
      acp_mode: true,
      summary,
    };

    const truncated = OutputTruncator.truncateForLLM(
      result.stdout.trim(),
      result.stderr.trim(),
      command
    );

    const llmContent = {
      stdout: truncated.stdout,
      stderr: truncated.stderr,
      execution_time: executionTime,
      exit_code: result.exitCode,
      ...(truncated.truncationInfo && { truncation_info: truncated.truncationInfo }),
    };

    return {
      success: result.success,
      llmContent,
      ...(result.success
        ? {}
        : {
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: formatCommandFailure(
                result.exitCode,
                undefined,
                truncated.stdout,
                truncated.stderr
              ),
            },
          }),
      metadata,
    };
  } catch (error) {
    const nodeError = error as NodeError;
    const executionTime = Date.now() - startTime;

    return {
      success: false,
      llmContent: `Command execution failed: ${nodeError.message}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: nodeError.message,
        details: nodeError,
      },
      metadata: {
        command,
        execution_time: executionTime,
        error: nodeError.message,
      },
    };
  }
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
  sandboxedCommand?: SandboxedCommand,
  ownership?: ForegroundProcessOwnership
): Promise<ToolResult> {
  const startTime = Date.now();
  const executable = sandboxedCommand?.executable ?? 'bash';
  const args = sandboxedCommand?.args ?? ['-c', command];
  const inheritedEnvironment =
    sandboxedCommand?.inheritProcessEnv === false
      ? selectVerificationEnvironment(process.env)
      : process.env;
  let prepared: Awaited<ReturnType<typeof prepareForegroundProcess>>;
  try {
    prepared = await prepareForegroundProcess(
      executable,
      args,
      {
        cwd: cwd || getCwd(),
        env: {
          ...inheritedEnvironment,
          ...env,
          ...sandboxedCommand?.env,
          BLADE_CLI: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      ownership
    );
  } catch (error) {
    sandboxedCommand?.cleanup();
    throw error;
  }

  return new Promise((resolve) => {
    const { child: bashProcess, processTree } = prepared;
    const capture = new ShellOutputCapture();
    let timedOut = false;
    let settled = false;
    let admissionError: Error | undefined;
    let finalizationError: Error | undefined;
    let releaseCompletion: Promise<void> | undefined;
    let terminationPromise: ReturnType<typeof processTree.terminate> | undefined;
    const terminateProcessTree = () => {
      terminationPromise ??= processTree.terminate();
      return terminationPromise;
    };
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree();
    }, timeout);
    const abortHandler = () => {
      void terminateProcessTree();
      clearTimeout(timeoutHandle);
    };
    const cleanup = () => {
      sandboxedCommand?.cleanup();
      clearTimeout(timeoutHandle);
      if (signal.removeEventListener) {
        signal.removeEventListener('abort', abortHandler);
      } else if ('onabort' in signal) {
        (signal as unknown as { onabort: null }).onabort = null;
      }
    };
    const output = (): ProjectedShellOutput => {
      capture.finish();
      return projectShellOutput(capture.snapshot(), command);
    };
    const metadataFor = (
      projected: ProjectedShellOutput,
      details: Record<string, unknown>,
      includeLengths: boolean = true
    ) => {
      const snapshot = projected.snapshot;
      const outputTruncated =
        projected.captureTruncated || projected.projectionTruncated;
      return {
        ...details,
        capture_truncated: projected.captureTruncated,
        projection_truncated: projected.projectionTruncated,
        output_truncated: outputTruncated,
        stdout_projection_truncated: projected.stdoutProjectionTruncated,
        stderr_projection_truncated: projected.stderrProjectionTruncated,
        stdout_total_bytes: snapshot.stdout.totalBytes,
        stdout_retained_bytes: snapshot.stdout.retainedBytes,
        stdout_omitted_bytes: snapshot.stdout.omittedBytes,
        stderr_total_bytes: snapshot.stderr.totalBytes,
        stderr_retained_bytes: snapshot.stderr.retainedBytes,
        stderr_omitted_bytes: snapshot.stderr.omittedBytes,
        raw_output_bytes: snapshot.stdout.totalBytes + snapshot.stderr.totalBytes,
        output_accounting_complete:
          snapshot.stdout.accountingComplete && snapshot.stderr.accountingComplete,
        terminal_transport: 'local' as const,
        terminal_output_merged: snapshot.terminalOutputMerged,
        ...(includeLengths
          ? {
              stdout_length: snapshot.stdout.totalChars,
              stderr_length: snapshot.stderr.totalChars,
            }
          : {}),
      };
    };
    const normalLlmContent = (
      projected: ProjectedShellOutput,
      executionTime: number,
      code: number | null,
      sig: NodeJS.Signals | null
    ) => ({
      stdout: projected.stdout,
      stderr: projected.stderr,
      execution_time: executionTime,
      exit_code: code,
      signal: sig,
      output_truncated: projected.captureTruncated || projected.projectionTruncated,
      stdout_omitted_bytes: projected.snapshot.stdout.omittedBytes,
      stderr_omitted_bytes: projected.snapshot.stderr.omittedBytes,
      stdout_total_bytes: projected.snapshot.stdout.totalBytes,
      stderr_total_bytes: projected.snapshot.stderr.totalBytes,
      output_accounting_complete:
        projected.snapshot.stdout.accountingComplete &&
        projected.snapshot.stderr.accountingComplete,
      ...(projected.truncationInfo && {
        truncation_info: projected.truncationInfo,
      }),
    });
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    bashProcess.stdout?.on('data', (data: Buffer | string) => {
      capture.append('stdout', data);
    });
    bashProcess.stderr?.on('data', (data: Buffer | string) => {
      capture.append('stderr', data);
    });

    if (signal.addEventListener) {
      signal.addEventListener('abort', abortHandler);
    } else if ('onabort' in signal) {
      (signal as unknown as { onabort: () => void }).onabort = abortHandler;
    }
    if (signal.aborted) abortHandler();

    bashProcess.on('close', async (code, sig) => {
      await releaseCompletion;
      if (timedOut || signal.aborted || admissionError) {
        await terminateProcessTree();
      }
      try {
        await prepared.finalize();
      } catch (error) {
        finalizationError =
          error instanceof Error
            ? error
            : new Error('Foreground command finalization failed');
      }
      const executionTime = Date.now() - startTime;
      const projected = output();

      if (timedOut) {
        settle({
          success: false,
          llmContent: `Command execution timed out (${timeout}ms)`,
          error: {
            type: ToolErrorType.TIMEOUT_ERROR,
            message: '命令执行超时',
          },
          metadata: {
            ...metadataFor(projected, {
              command,
              sandboxed: Boolean(sandboxedCommand),
            }),
            timeout: true,
            stdout: projected.stdout,
            stderr: projected.stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      if (signal.aborted) {
        settle({
          success: false,
          llmContent: 'Command execution aborted by user',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
          metadata: {
            ...metadataFor(projected, {
              command,
              sandboxed: Boolean(sandboxedCommand),
            }),
            aborted: true,
            stdout: projected.stdout,
            stderr: projected.stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      if (admissionError) {
        settle({
          success: false,
          llmContent: 'Command execution blocked before durable admission',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Foreground command admission failed',
          },
          metadata: {
            ...metadataFor(projected, {
              command,
              sandboxed: Boolean(sandboxedCommand),
            }),
            admission_failed: true,
            stdout: projected.stdout,
            stderr: projected.stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      if (finalizationError) {
        settle({
          success: false,
          llmContent: 'Command process group could not be finalized',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Foreground command finalization failed',
          },
          metadata: {
            ...metadataFor(projected, {
              command,
              sandboxed: Boolean(sandboxedCommand),
            }),
            finalization_failed: true,
            stdout: projected.stdout,
            stderr: projected.stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      if (
        sandboxedCommand &&
        isWorkspaceSandboxRuntimeFailure(code, projected.snapshot.stderr.content)
      ) {
        settle({
          success: false,
          llmContent:
            'Workspace sandbox could not start, so the Bash command was not executed.',
          error: {
            type: ToolErrorType.PERMISSION_DENIED,
            message: projected.stderr || 'Workspace sandbox failed to start',
          },
          metadata: {
            ...metadataFor(projected, { command }),
            sandbox_required: true,
            sandboxed: false,
            execution_time: executionTime,
            exit_code: code,
            stdout: projected.stdout,
            stderr: projected.stderr,
            summary: 'Workspace sandbox failed closed',
          },
        });
        return;
      }

      const cmdPreview =
        command.length > 30 ? `${command.substring(0, 30)}...` : command;
      const summary =
        code === 0
          ? `执行命令成功 (${executionTime}ms): ${cmdPreview}`
          : `执行命令完成 (退出码 ${code}, ${executionTime}ms): ${cmdPreview}`;

      const metadata: BashForegroundMetadata = {
        ...metadataFor(projected, { command }),
        command,
        execution_time: executionTime,
        exit_code: code,
        signal: sig,
        has_stderr:
          projected.snapshot.stderr.totalBytes > 0 ||
          projected.snapshot.stderr.totalChars > 0,
        sandboxed: Boolean(sandboxedCommand),
        summary,
      };

      const llmContent = normalLlmContent(projected, executionTime, code, sig);
      const success = code === 0;

      settle({
        success,
        llmContent,
        ...(success
          ? {}
          : {
              error: {
                type: ToolErrorType.EXECUTION_ERROR,
                message: formatCommandFailure(
                  code,
                  sig,
                  projected.stdout,
                  projected.stderr
                ),
              },
            }),
        metadata,
      });
    });

    bashProcess.on('error', async (error) => {
      await releaseCompletion;
      if (timedOut || signal.aborted || admissionError) {
        await terminateProcessTree();
      }
      try {
        await prepared.finalize();
      } catch (finalizeError) {
        finalizationError =
          finalizeError instanceof Error
            ? finalizeError
            : new Error('Foreground command finalization failed');
      }
      const projected = output();
      const executionTime = Date.now() - startTime;
      settle({
        success: false,
        llmContent: timedOut
          ? `Command execution timed out (${timeout}ms)`
          : signal.aborted
            ? 'Command execution aborted by user'
            : admissionError
              ? 'Command execution blocked before durable admission'
              : finalizationError
                ? 'Command process group could not be finalized'
                : `Command execution failed: ${error.message}`,
        error: {
          type: timedOut ? ToolErrorType.TIMEOUT_ERROR : ToolErrorType.EXECUTION_ERROR,
          message: timedOut
            ? '命令执行超时'
            : signal.aborted
              ? '操作被中止'
              : admissionError
                ? 'Foreground command admission failed'
                : finalizationError
                  ? 'Foreground command finalization failed'
                  : error.message,
          ...(timedOut || signal.aborted || admissionError || finalizationError
            ? {}
            : { details: error }),
        },
        metadata: metadataFor(projected, {
          command,
          sandboxed: Boolean(sandboxedCommand),
          ...(timedOut
            ? { timeout: true }
            : signal.aborted
              ? { aborted: true }
              : admissionError
                ? { admission_failed: true }
                : finalizationError
                  ? { finalization_failed: true }
                  : { error: error.message }),
          stdout: projected.stdout,
          stderr: projected.stderr,
          execution_time: executionTime,
        }),
      });
    });

    if (!signal.aborted) {
      releaseCompletion = prepared.release().catch(async (error: unknown) => {
        admissionError =
          error instanceof Error ? error : new Error('Command admission failed');
        await terminateProcessTree();
      });
    }
  });
}

function selectVerificationEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const allowed = [
    'CI',
    'COLORTERM',
    'FORCE_COLOR',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'NO_COLOR',
    'PATH',
    'TERM',
    'TZ',
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
}
