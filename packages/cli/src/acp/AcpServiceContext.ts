/**
 * ACP 服务上下文管理器
 *
 * 管理 ACP 模式下的各种服务（文件系统、终端等），
 * 使工具可以透明地使用 IDE 提供的能力或回退到本地实现。
 */

import type {
  AgentSideConnection,
  ClientCapabilities,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { spawn } from 'child_process';
import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type FileSystemService,
  LocalFileSystemService,
  resetFileSystemService,
  setFileSystemService,
} from '../services/FileSystemService.js';
import { AcpFileSystemService } from './AcpFileSystemService.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * 终端服务接口
 */
export interface TerminalService {
  /**
   * 执行命令
   * @param command - 要执行的命令
   * @param options - 执行选项
   * @returns 执行结果
   */
  execute(
    command: string,
    options?: TerminalExecuteOptions
  ): Promise<TerminalExecuteResult>;

  /**
   * 检查是否支持终端操作
   */
  isAvailable(): boolean;
}

interface TerminalExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (output: string) => void;
}

interface TerminalExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

/**
 * 本地终端服务（使用 child_process）
 */
class LocalTerminalService implements TerminalService {
  async execute(
    command: string,
    options?: TerminalExecuteOptions
  ): Promise<TerminalExecuteResult> {
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs =
        process.platform === 'win32' ? ['/c', command] : ['-c', command];

      const proc = spawn(shell, shellArgs, {
        cwd: options?.cwd || process.cwd(),
        env: { ...process.env, ...options?.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      // 设置超时
      const timeoutId = options?.timeout
        ? setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
          }, options.timeout)
        : null;

      // 保存 abort handler 引用以便后续移除，避免 MaxListenersExceededWarning
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
          abortHandler = null;
        }
      };

      // 处理中止信号
      if (options?.signal) {
        abortHandler = () => {
          killed = true;
          proc.kill('SIGTERM');
        };
        options.signal.addEventListener('abort', abortHandler);
      }

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        options?.onOutput?.(chunk);
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        options?.onOutput?.(chunk);
      });

      proc.on('close', (code) => {
        cleanup();

        resolve({
          success: code === 0 && !killed,
          stdout,
          stderr,
          exitCode: code,
          error: killed ? 'Command was terminated' : undefined,
        });
      });

      proc.on('error', (error) => {
        cleanup();

        resolve({
          success: false,
          stdout,
          stderr,
          exitCode: null,
          error: error.message,
        });
      });
    });
  }

  isAvailable(): boolean {
    return true;
  }
}

/**
 * ACP 终端服务
 * 通过 ACP 协议在 IDE 中执行命令
 */
class AcpTerminalService implements TerminalService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly fallback: TerminalService = new LocalTerminalService()
  ) {}

  async execute(
    command: string,
    options?: TerminalExecuteOptions
  ): Promise<TerminalExecuteResult> {
    try {
      logger.debug(`[AcpTerminal] Executing command via ACP: ${command}`);

      // 创建终端
      const terminal = await this.connection.createTerminal({
        sessionId: this.sessionId,
        command,
        cwd: options?.cwd,
        env: options?.env
          ? Object.entries(options.env).map(([name, value]) => ({ name, value }))
          : undefined,
      });

      let lastOutputLength = 0;

      // 流式输出轮询（如果提供了 onOutput）
      let pollIntervalId: ReturnType<typeof setInterval> | null = null;
      if (options?.onOutput) {
        pollIntervalId = setInterval(async () => {
          try {
            const output = await terminal.currentOutput();
            const fullOutput = output.output || '';
            if (fullOutput.length > lastOutputLength) {
              const newContent = fullOutput.slice(lastOutputLength);
              lastOutputLength = fullOutput.length;
              options.onOutput?.(newContent);
            }
          } catch {
            // 忽略轮询错误
          }
        }, 100);
      }

      // 清理函数（后台执行，不阻塞返回）
      const cleanup = (shouldKill: boolean = false) => {
        if (pollIntervalId) {
          clearInterval(pollIntervalId);
          pollIntervalId = null;
        }
        // 后台清理：如需终止则先 kill 再 release
        const doCleanup = shouldKill
          ? terminal
              .kill()
              .then(() => logger.debug(`[AcpTerminal] Killed remote command`))
              .catch(() => {
                /* 忽略 kill 错误（命令可能已结束）*/
              })
              .then(() => terminal.release())
              .catch(() => {
                /* 忽略 release 错误 */
              })
          : terminal.release().catch(() => {
              /* 忽略 release 错误 */
            });

        // 不等待，后台执行
        doCleanup.catch(() => {
          /* 忽略清理错误 */
        });
      };

      // 构建竞争 Promise
      const racePromises: Promise<
        | { type: 'completed'; exitCode: number | null }
        | { type: 'timeout' }
        | { type: 'aborted' }
      >[] = [];

      // 1. 命令完成
      racePromises.push(
        terminal.waitForExit().then((result) => ({
          type: 'completed' as const,
          exitCode: result.exitCode ?? null,
        }))
      );

      // 2. 超时
      if (options?.timeout) {
        racePromises.push(
          new Promise((resolve) => {
            setTimeout(() => resolve({ type: 'timeout' as const }), options.timeout);
          })
        );
      }

      // 3. 取消信号
      if (options?.signal) {
        racePromises.push(
          new Promise((resolve) => {
            if (options.signal!.aborted) {
              resolve({ type: 'aborted' as const });
            } else {
              options.signal!.addEventListener(
                'abort',
                () => resolve({ type: 'aborted' as const }),
                { once: true }
              );
            }
          })
        );
      }

      // 使用 Promise.race 实现真正的中断
      const raceResult = await Promise.race(racePromises);

      // 获取当前输出（尽力获取，可能失败）
      let fullOutput = '';
      try {
        const output = await terminal.currentOutput();
        fullOutput = output.output || '';
        // 发送剩余输出
        if (options?.onOutput && fullOutput.length > lastOutputLength) {
          options.onOutput(fullOutput.slice(lastOutputLength));
        }
      } catch {
        // 忽略获取输出失败
      }

      // 根据结果返回（同时清理资源）
      switch (raceResult.type) {
        case 'completed':
          // 正常完成：只释放资源，不需要 kill
          cleanup(false);
          return {
            success: raceResult.exitCode === 0,
            stdout: fullOutput,
            stderr: '',
            exitCode: raceResult.exitCode,
          };

        case 'timeout':
          // 超时：先 kill 远端命令再释放
          logger.debug(`[AcpTerminal] Command timed out, killing: ${command}`);
          cleanup(true);
          return {
            success: false,
            stdout: fullOutput,
            stderr: '',
            exitCode: null,
            error: 'Command timed out',
          };

        case 'aborted':
          // 取消：先 kill 远端命令再释放
          logger.debug(`[AcpTerminal] Command aborted, killing: ${command}`);
          cleanup(true);
          return {
            success: false,
            stdout: fullOutput,
            stderr: '',
            exitCode: null,
            error: 'Command was aborted',
          };
      }
    } catch (error) {
      logger.warn(`[AcpTerminal] ACP terminal failed, using fallback:`, error);
      return this.fallback.execute(command, options);
    }
  }

  isAvailable(): boolean {
    return true;
  }
}

/**
 * 单个会话的服务上下文
 */
interface SessionServices {
  fileSystemService: FileSystemService;
  terminalService: TerminalService;
  connection: AgentSideConnection;
  clientCapabilities: ClientCapabilities | null;
  cwd: string;
}

/**
 * ACP 服务上下文管理器
 *
 * 按 sessionId 管理服务，支持多会话并发。
 * 每个会话有独立的服务实例，互不影响。
 */
export class AcpServiceContext {
  private static sessions: Map<string, SessionServices> = new Map();
  private static currentSessionId: string | null = null;

  private constructor() {
    // 私有构造函数，使用静态方法
  }

  /**
   * 获取单例实例（兼容旧 API）
   * @deprecated 使用 getForSession(sessionId) 代替
   */
  static getInstance(): AcpServiceContext {
    return new AcpServiceContext();
  }

  /**
   * 初始化会话的 ACP 服务
   *
   * @param connection - ACP 连接
   * @param sessionId - 会话 ID
   * @param clientCapabilities - 客户端能力
   * @param cwd - 工作目录
   */
  static initializeSession(
    connection: AgentSideConnection,
    sessionId: string,
    clientCapabilities: ClientCapabilities | undefined,
    cwd: string
  ): void {
    // 根据 IDE 能力创建文件系统服务
    const fileSystemService: FileSystemService = clientCapabilities?.fs
      ? new AcpFileSystemService(connection, sessionId, clientCapabilities.fs)
      : new LocalFileSystemService();

    if (clientCapabilities?.fs) {
      logger.debug(`[AcpServiceContext:${sessionId}] Using ACP file system service`);
    }

    // 终端服务始终可用（ACP 或本地）
    const terminalService: TerminalService = new AcpTerminalService(
      connection,
      sessionId
    );
    logger.debug(`[AcpServiceContext:${sessionId}] Using ACP terminal service`);

    // 存储会话服务
    AcpServiceContext.sessions.set(sessionId, {
      fileSystemService,
      terminalService,
      connection,
      clientCapabilities: clientCapabilities || null,
      cwd,
    });

    // 设置当前会话（用于便捷函数）
    AcpServiceContext.currentSessionId = sessionId;

    // 更新全局文件系统服务（供工具层使用）
    setFileSystemService(fileSystemService);

    logger.debug(`[AcpServiceContext:${sessionId}] Initialized with capabilities:`, {
      fs: !!clientCapabilities?.fs,
      readTextFile: clientCapabilities?.fs?.readTextFile,
      writeTextFile: clientCapabilities?.fs?.writeTextFile,
      cwd,
    });
  }

  /**
   * 销毁会话服务
   *
   * 只清理指定会话，不影响其他会话。
   */
  static destroySession(sessionId: string): void {
    AcpServiceContext.sessions.delete(sessionId);

    // 如果是当前会话，清除当前会话 ID
    if (AcpServiceContext.currentSessionId === sessionId) {
      // 切换到另一个活跃会话，或者清空
      const remainingSessions = Array.from(AcpServiceContext.sessions.keys());
      AcpServiceContext.currentSessionId = remainingSessions[0] || null;

      // 如果没有剩余会话，重置文件系统服务为本地
      if (!AcpServiceContext.currentSessionId) {
        resetFileSystemService();
      } else {
        // 切换到下一个会话的文件系统服务
        const nextSession = AcpServiceContext.sessions.get(
          AcpServiceContext.currentSessionId
        );
        if (nextSession) {
          setFileSystemService(nextSession.fileSystemService);
        }
      }
    }

    logger.debug(`[AcpServiceContext:${sessionId}] Session destroyed`);
  }

  /**
   * 获取指定会话的服务
   */
  static getSessionServices(sessionId: string): SessionServices | null {
    return AcpServiceContext.sessions.get(sessionId) || null;
  }

  /**
   * 设置当前活跃会话
   */
  static setCurrentSession(sessionId: string): void {
    if (AcpServiceContext.sessions.has(sessionId)) {
      AcpServiceContext.currentSessionId = sessionId;

      // 更新全局文件系统服务
      const session = AcpServiceContext.sessions.get(sessionId);
      if (session) {
        setFileSystemService(session.fileSystemService);
      }
    }
  }

  /**
   * 获取当前活跃会话 ID
   */
  static getCurrentSessionId(): string | null {
    return AcpServiceContext.currentSessionId;
  }

  // ==================== 兼容旧 API（实例方法）====================

  /**
   * 初始化 ACP 服务（兼容旧 API）
   * @deprecated 使用 AcpServiceContext.initializeSession() 代替
   */
  initialize(
    connection: AgentSideConnection,
    sessionId: string,
    clientCapabilities: ClientCapabilities | undefined,
    cwd?: string
  ): void {
    AcpServiceContext.initializeSession(
      connection,
      sessionId,
      clientCapabilities,
      cwd || process.cwd()
    );
  }

  /**
   * 重置服务（兼容旧 API）
   * @deprecated 使用 AcpServiceContext.destroySession(sessionId) 代替
   */
  reset(): void {
    // 只重置当前会话，而不是所有会话
    if (AcpServiceContext.currentSessionId) {
      AcpServiceContext.destroySession(AcpServiceContext.currentSessionId);
    }
  }

  /**
   * 检查是否在 ACP 模式下运行
   */
  isAcpMode(): boolean {
    return AcpServiceContext.currentSessionId !== null;
  }

  /**
   * 获取文件系统服务（当前会话）
   */
  getFileSystemService(): FileSystemService {
    if (AcpServiceContext.currentSessionId) {
      const services = AcpServiceContext.sessions.get(
        AcpServiceContext.currentSessionId
      );
      if (services) return services.fileSystemService;
    }
    return new LocalFileSystemService();
  }

  /**
   * 获取终端服务（当前会话）
   */
  getTerminalService(): TerminalService {
    if (AcpServiceContext.currentSessionId) {
      const services = AcpServiceContext.sessions.get(
        AcpServiceContext.currentSessionId
      );
      if (services) return services.terminalService;
    }
    return new LocalTerminalService();
  }

  /**
   * 获取 ACP 连接（当前会话）
   */
  getConnection(): AgentSideConnection | null {
    if (AcpServiceContext.currentSessionId) {
      const services = AcpServiceContext.sessions.get(
        AcpServiceContext.currentSessionId
      );
      if (services) return services.connection;
    }
    return null;
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string | null {
    return AcpServiceContext.currentSessionId;
  }

  /**
   * 获取客户端能力（当前会话）
   */
  getClientCapabilities(): ClientCapabilities | null {
    if (AcpServiceContext.currentSessionId) {
      const services = AcpServiceContext.sessions.get(
        AcpServiceContext.currentSessionId
      );
      if (services) return services.clientCapabilities;
    }
    return null;
  }

  /**
   * 发送工具调用状态更新
   */
  async sendToolUpdate(
    toolCallId: string,
    status: ToolCallStatus,
    title: string,
    content?: ToolCallContent[],
    kind?: ToolKind
  ): Promise<void> {
    const sessionId = AcpServiceContext.currentSessionId;
    if (!sessionId) return;

    const services = AcpServiceContext.sessions.get(sessionId);
    if (!services) return;

    try {
      await services.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          status,
          title,
          content: content || [],
          kind: kind || 'other',
        },
      });
    } catch (error) {
      logger.warn('[AcpServiceContext] Failed to send tool update:', error);
    }
  }
}

/**
 * 便捷函数：获取终端服务
 */
export function getTerminalService(): TerminalService {
  return AcpServiceContext.getInstance().getTerminalService();
}

/**
 * 便捷函数：检查是否在 ACP 模式
 */
export function isAcpMode(): boolean {
  return AcpServiceContext.getInstance().isAcpMode();
}
