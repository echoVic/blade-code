import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
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
 * Bash会话参数接口
 */
interface BashParams {
  command: string;
  session_id?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  run_in_background?: boolean;
}

/**
 * Bash会话管理
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
    bashProcess.stdout.on('data', data => {
      const output = data.toString();
      const currentOutput = this.sessionOutputs.get(sessionId) || '';
      this.sessionOutputs.set(sessionId, currentOutput + output);
    });

    bashProcess.stderr.on('data', data => {
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
 * Bash工具调用实现
 */
class BashToolInvocation extends BaseToolInvocation<BashParams> {
  constructor(params: BashParams) {
    super('bash', params);
  }

  getDescription(): string {
    const { command, session_id, run_in_background } = this.params;
    const sessionInfo = session_id ? ` (会话: ${session_id})` : '';
    const backgroundInfo = run_in_background ? ' (后台执行)' : '';
    return `执行Bash命令: ${command}${sessionInfo}${backgroundInfo}`;
  }

  getAffectedPaths(): string[] {
    const paths: string[] = [];
    if (this.params.cwd) {
      paths.push(this.params.cwd);
    }
    return paths;
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { command, run_in_background } = this.params;

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

    const isDangerous = dangerousCommands.some(dangerous =>
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
        affectedFiles: this.getAffectedPaths(),
      };
    }

    return null;
  }

  async execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        command,
        session_id,
        timeout = 30000,
        cwd,
        env,
        run_in_background = false,
      } = this.params;

      const sessionManager = BashSessionManager.getInstance();
      const actualSessionId = session_id || randomUUID();

      updateOutput?.(`在Bash会话中执行: ${command}`);

      // 获取或创建会话
      let bashProcess = sessionManager.getSession(actualSessionId);
      if (!bashProcess) {
        bashProcess = sessionManager.createSession(actualSessionId, cwd, env);
        // 等待bash初始化
        await new Promise(resolve => setTimeout(resolve, 1000));
        sessionManager.clearSessionOutput(actualSessionId);
      }

      this.checkAbortSignal(signal);

      if (run_in_background) {
        return this.executeInBackground(
          bashProcess,
          command,
          actualSessionId,
          sessionManager,
          updateOutput
        );
      } else {
        return this.executeWithTimeout(
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
      return this.createErrorResult(error);
    }
  }

  private async executeInBackground(
    bashProcess: ChildProcess,
    command: string,
    sessionId: string,
    sessionManager: BashSessionManager,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    // 清除之前的输出
    sessionManager.clearSessionOutput(sessionId);

    // 执行命令
    bashProcess.stdin!.write(`${command}\n`);

    // 等待一小段时间让命令开始执行
    await new Promise(resolve => setTimeout(resolve, 500));

    const metadata = {
      session_id: sessionId,
      command,
      background: true,
      message: '命令已在后台启动',
    };

    const displayMessage =
      `命令已在后台会话 ${sessionId} 中启动\n` +
      `使用 bash_output 工具查看输出\n` +
      `使用 kill_bash 工具终止会话`;

    return this.createSuccessResult(
      {
        session_id: sessionId,
        command,
        background: true,
      },
      displayMessage,
      metadata
    );
  }

  private async executeWithTimeout(
    bashProcess: ChildProcess,
    command: string,
    sessionId: string,
    sessionManager: BashSessionManager,
    timeout: number,
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    return new Promise(resolve => {
      const startTime = Date.now();

      // 清除之前的输出
      sessionManager.clearSessionOutput(sessionId);

      // 设置超时
      const timeoutHandle = setTimeout(() => {
        const { stdout, stderr } = sessionManager.getSessionOutput(sessionId);
        resolve(
          this.createErrorResult(`命令执行超时 (${timeout}ms)`, {
            session_id: sessionId,
            command,
            timeout: true,
            stdout: stdout,
            stderr: stderr,
            execution_time: timeout,
          })
        );
      }, timeout);

      // 处理中止信号
      const abortHandler = () => {
        clearTimeout(timeoutHandle);
        const { stdout, stderr } = sessionManager.getSessionOutput(sessionId);
        resolve(
          this.createErrorResult('命令执行被用户中止', {
            session_id: sessionId,
            command,
            aborted: true,
            stdout: stdout,
            stderr: stderr,
            execution_time: Date.now() - startTime,
          })
        );
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

          const displayMessage = this.formatDisplayMessage({
            stdout,
            stderr,
            session_id: sessionId,
            command,
            execution_time: executionTime,
          });

          resolve(
            this.createSuccessResult(
              {
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                session_id: sessionId,
                execution_time: executionTime,
              },
              displayMessage,
              metadata
            )
          );
        }
      }, 100);

      // 执行命令
      bashProcess.stdin!.write(`${command}\n`);
    });
  }

  private formatDisplayMessage(result: {
    stdout: string;
    stderr: string;
    session_id: string;
    command: string;
    execution_time: number;
  }): string {
    const { stdout, stderr, session_id, command, execution_time } = result;

    let message = `Bash命令执行完成: ${command}`;
    message += `\n会话ID: ${session_id}`;
    message += `\n执行时间: ${execution_time}ms`;

    if (stdout && stdout.trim()) {
      const cleanOutput = stdout.replace(/^\$\s*/gm, '').trim();
      if (cleanOutput) {
        message += `\n输出:\n${cleanOutput}`;
      }
    }

    if (stderr && stderr.trim()) {
      message += `\n错误输出:\n${stderr.trim()}`;
    }

    return message;
  }
}

/**
 * Bash持久化会话工具
 * 支持创建和管理持久化的bash会话
 */
export class BashTool extends DeclarativeTool<BashParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的bash命令',
        },
        session_id: {
          type: 'string',
          description: '会话ID（可选，用于复用会话）',
        },
        timeout: {
          type: 'integer',
          minimum: 1000,
          maximum: 300000,
          default: 30000,
          description: '超时时间（毫秒，默认30秒）',
        },
        cwd: {
          type: 'string',
          description: '工作目录（可选，仅在创建新会话时有效）',
        },
        env: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
          description: '环境变量（可选，仅在创建新会话时有效）',
        },
        run_in_background: {
          type: 'boolean',
          default: false,
          description: '是否在后台运行（适合长时间执行的命令）',
        },
      },
      required: ['command'],
      additionalProperties: false,
    };

    super(
      'bash',
      'Bash会话执行',
      '在持久化的bash会话中执行命令，支持会话复用和后台执行',
      ToolKind.Execute,
      schema,
      true, // 命令执行需要确认
      '1.0.0',
      '命令工具',
      ['bash', 'shell', 'session', 'persistent']
    );
  }

  build(params: BashParams): ToolInvocation<BashParams> {
    // 验证参数
    const command = this.validateString(params.command, 'command', {
      required: true,
      minLength: 1,
    });

    let sessionId: string | undefined;
    if (params.session_id !== undefined) {
      sessionId = this.validateString(params.session_id, 'session_id', {
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

    let cwd: string | undefined;
    if (params.cwd !== undefined) {
      cwd = this.validateString(params.cwd, 'cwd', {
        required: false,
        minLength: 1,
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

    const runInBackground = this.validateBoolean(
      params.run_in_background ?? false,
      'run_in_background'
    );

    const validatedParams: BashParams = {
      command,
      ...(sessionId !== undefined && { session_id: sessionId }),
      ...(timeout !== undefined && { timeout }),
      ...(cwd !== undefined && { cwd }),
      ...(env !== undefined && { env }),
      run_in_background: runInBackground,
    };

    return new BashToolInvocation(validatedParams);
  }
}

// 导出会话管理器以供其他工具使用（如BashOutput和KillBash）
export { BashSessionManager };
