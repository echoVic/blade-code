/**
 * ACP 服务上下文管理器
 *
 * 管理 ACP 模式下的各种服务（文件系统、终端等），
 * 使工具可以透明地使用 IDE 提供的能力或回退到本地实现。
 */

import type {
  AgentSideConnection,
  ClientCapabilities,
  SessionNotification,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import {
  type ForegroundProcessOwnership,
  prepareForegroundProcess,
} from '../context/storage/DurableForegroundProcess.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type FileSystemService,
  LocalFileSystemService,
} from '../services/FileSystemService.js';
import {
  BackgroundShellCapacityError,
  BackgroundShellManager,
  type BackgroundShellStatus,
} from '../tools/builtin/shell/BackgroundShellManager.js';
import {
  ShellOutputCapture,
  type ShellOutputCaptureSnapshot,
} from '../tools/builtin/shell/ShellOutputCapture.js';
import { getCwd } from '../utils/cwd.js';
import { AcpFileSystemService } from './AcpFileSystemService.js';

const logger = createLogger(LogCategory.AGENT);
const ACP_TERMINAL_OUTPUT_READ_TIMEOUT_MS = 5_000;

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

export interface TerminalExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (output: string) => void;
  allowLocalFallback?: boolean;
  durableOwnership?: ForegroundProcessOwnership;
  foregroundHandoffMs?: number;
}

export type TerminalFailureKind =
  | 'timeout'
  | 'aborted'
  | 'admission'
  | 'finalization'
  | 'unavailable'
  | 'spawn';

export type TerminalTransport = 'local' | 'acp' | 'local_fallback';

export interface TerminalExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  failureKind?: TerminalFailureKind;
  transport: TerminalTransport;
  capture?: ShellOutputCaptureSnapshot;
  background?: {
    shellId: string;
    autoBackgrounded: true;
    foregroundBudgetMs: number;
  };
}

/**
 * 本地终端服务（使用 child_process）
 */
class LocalTerminalService implements TerminalService {
  constructor(private readonly defaultCwd?: string) {}

  async execute(
    command: string,
    options?: TerminalExecuteOptions
  ): Promise<TerminalExecuteResult> {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    let prepared: Awaited<ReturnType<typeof prepareForegroundProcess>>;
    try {
      prepared = await prepareForegroundProcess(
        shell,
        shellArgs,
        {
          cwd: options?.cwd ?? this.defaultCwd ?? getCwd(),
          env: { ...process.env, ...options?.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
        options?.durableOwnership
      );
    } catch (error) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error:
          error instanceof Error
            ? error.message
            : 'Foreground command admission failed',
        failureKind: 'admission',
        transport: 'local',
      };
    }

    return new Promise((resolve) => {
      const { child: proc, processTree } = prepared;
      let terminationPromise: ReturnType<typeof processTree.terminate> | undefined;
      const terminateProcessTree = () => {
        terminationPromise ??= processTree.terminate();
        return terminationPromise;
      };

      const capture = new ShellOutputCapture();
      let terminalEvent: 'timeout' | 'aborted' | 'admission' | undefined;
      let admissionFailed = false;
      let finalizationFailed = false;
      let settled = false;
      let terminalHandlingStarted = false;
      let completionPromise: Promise<void> | undefined;
      let releasePromise: Promise<void> | undefined;

      const timeoutId = options?.timeout
        ? setTimeout(() => {
            if (terminalHandlingStarted) return;
            if (!terminalEvent) terminalEvent = 'timeout';
            void terminateProcessTree();
          }, options.timeout)
        : null;

      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
          abortHandler = null;
        }
      };
      const settle = (result: TerminalExecuteResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      if (options?.signal) {
        abortHandler = () => {
          if (terminalHandlingStarted) return;
          if (!terminalEvent) terminalEvent = 'aborted';
          void terminateProcessTree();
        };
        options.signal.addEventListener('abort', abortHandler);
        if (options.signal.aborted) abortHandler();
      }

      proc.stdout?.on('data', (data) => {
        capture.append('stdout', data);
        const chunk = data.toString();
        options?.onOutput?.(chunk);
      });

      proc.stderr?.on('data', (data) => {
        capture.append('stderr', data);
        const chunk = data.toString();
        options?.onOutput?.(chunk);
      });

      const finish = (code: number | null, spawnError?: Error) => {
        terminalHandlingStarted = true;
        cleanup();
        completionPromise ??= (async () => {
          await releasePromise;
          if (terminalEvent || admissionFailed) await terminateProcessTree();
          try {
            await prepared.finalize();
          } catch {
            finalizationFailed = true;
          }
          capture.finish();
          const snapshot = capture.snapshot();
          const failureKind: TerminalFailureKind | undefined =
            terminalEvent === 'timeout'
              ? 'timeout'
              : terminalEvent === 'aborted'
                ? 'aborted'
                : admissionFailed
                  ? 'admission'
                  : finalizationFailed
                    ? 'finalization'
                    : spawnError
                      ? 'spawn'
                      : undefined;
          settle({
            success: code === 0 && !failureKind,
            stdout: snapshot.stdout.content,
            stderr: snapshot.stderr.content,
            exitCode: code,
            error:
              failureKind === 'timeout' || failureKind === 'aborted'
                ? 'Command was terminated'
                : failureKind === 'admission'
                  ? 'Foreground command admission failed'
                  : failureKind === 'finalization'
                    ? 'Foreground command finalization failed'
                    : spawnError?.message,
            failureKind,
            transport: 'local',
            capture: snapshot,
          });
        })();
        void completionPromise;
      };

      proc.once('close', (code) => finish(code));
      proc.once('error', (error) => finish(null, error));
      if (options?.signal?.aborted) {
        terminalEvent = 'aborted';
        releasePromise = Promise.resolve();
        void terminateProcessTree();
      } else {
        releasePromise = prepared.release().catch(async () => {
          admissionFailed = true;
          if (!terminalEvent) terminalEvent = 'admission';
          await terminateProcessTree();
        });
      }
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
    let terminal:
      | Awaited<ReturnType<AgentSideConnection['createTerminal']>>
      | undefined;
    try {
      logger.debug(`[AcpTerminal] Executing command via ACP: ${command}`);
      terminal = await this.connection.createTerminal({
        sessionId: this.sessionId,
        command,
        cwd: options?.cwd,
        env: options?.env
          ? Object.entries(options.env).map(([name, value]) => ({ name, value }))
          : undefined,
      });
      const activeTerminal = terminal;

      type RaceOutcome =
        | { type: 'completed'; exitCode: number | null }
        | { type: 'timeout' }
        | { type: 'aborted' }
        | { type: 'killed' }
        | { type: 'handoff' }
        | { type: 'failed'; error: unknown };

      const manager = BackgroundShellManager.getInstance();
      let candidateId: string | undefined;
      let handedOff = false;
      let capture = new ShellOutputCapture(undefined, true);
      let observedLength = 0;
      let emittedLength = 0;
      let pollingStopped = false;
      let outputReadStalled = false;
      let wakePoll: (() => void) | undefined;
      let terminalFinalization: Promise<TerminalExecuteResult> | undefined;
      let terminateExternal: (
        reason: 'timeout' | 'aborted' | 'killed'
      ) => Promise<void> = async () => undefined;

      const readCurrentOutput = async (): Promise<
        | {
            type: 'output';
            response: Awaited<ReturnType<typeof activeTerminal.currentOutput>>;
          }
        | { type: 'error' }
        | { type: 'timeout' }
      > => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = activeTerminal
          .currentOutput()
          .then((response) => ({ type: 'output' as const, response }))
          .catch(() => ({ type: 'error' as const }));
        const timeout = new Promise<{ type: 'timeout' }>((resolve) => {
          timer = setTimeout(
            () => resolve({ type: 'timeout' }),
            ACP_TERMINAL_OUTPUT_READ_TIMEOUT_MS
          );
        });
        return await Promise.race([read, timeout]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      };
      const emitNew = (output: string) => {
        const len = output.length;
        if (len >= emittedLength) {
          const delta = output.slice(emittedLength);
          if (delta) options?.onOutput?.(delta);
          emittedLength = len;
        }
      };
      const appendPoll = (response: { output: string; truncated: boolean }) => {
        const len = response.output.length;
        if (!response.truncated && len >= observedLength) {
          const delta = response.output.slice(observedLength);
          if (delta) {
            capture.append('stdout', delta);
            if (candidateId) {
              manager.appendExternalOutput(
                candidateId,
                this.sessionId,
                'stdout',
                delta
              );
            }
          }
          emitNew(response.output);
          observedLength = len;
          return;
        }
        capture = new ShellOutputCapture(undefined, true);
        capture.append('stdout', response.output);
        capture.markAccountingIncomplete();
        if (candidateId) {
          manager.replaceExternalOutput(
            candidateId,
            this.sessionId,
            response.output,
            ''
          );
        }
        emittedLength = len;
        observedLength = len;
      };
      const polling = (async () => {
        while (!pollingStopped) {
          const read = await readCurrentOutput();
          if (read.type === 'output') {
            appendPoll(read.response);
          } else {
            capture.markAccountingIncomplete();
            if (read.type === 'timeout') {
              outputReadStalled = true;
              pollingStopped = true;
              break;
            }
          }
          if (pollingStopped) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 100);
            wakePoll = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wakePoll = undefined;
        }
      })();
      const stopPolling = async () => {
        pollingStopped = true;
        wakePoll?.();
        await polling;
      };
      const exitPromise: Promise<RaceOutcome> = activeTerminal
        .waitForExit()
        .then((result) => ({
          type: 'completed' as const,
          exitCode: result.exitCode ?? null,
        }))
        .catch((error: unknown) => ({ type: 'failed' as const, error }));

      const finalizeTerminal = (outcome: RaceOutcome) => {
        terminalFinalization ??= (async (): Promise<TerminalExecuteResult> => {
          if (outcome.type !== 'completed') {
            await activeTerminal.kill().catch(() => undefined);
          }
          await stopPolling();
          const finalRead = outputReadStalled
            ? ({ type: 'timeout' } as const)
            : await readCurrentOutput();
          if (finalRead.type === 'output') {
            const finalOutput = finalRead.response;
            if (finalOutput.output.length >= emittedLength) {
              emitNew(finalOutput.output);
            }
            capture = new ShellOutputCapture(undefined, true);
            capture.append('stdout', finalOutput.output);
            if (finalOutput.truncated) capture.markAccountingIncomplete();
          } else {
            capture.markAccountingIncomplete();
          }
          await activeTerminal.release().catch(() => undefined);
          capture.finish();
          const snapshot = capture.snapshot();

          if (candidateId) {
            manager.replaceExternalOutput(
              candidateId,
              this.sessionId,
              snapshot.stdout.content,
              snapshot.stderr.content
            );
            const status: BackgroundShellStatus =
              outcome.type === 'completed'
                ? 'exited'
                : outcome.type === 'timeout'
                  ? 'timed_out'
                  : outcome.type === 'aborted'
                    ? 'aborted'
                    : outcome.type === 'killed'
                      ? 'killed'
                      : 'error';
            manager.completeExternalProcess(candidateId, this.sessionId, {
              status,
              exitCode: outcome.type === 'completed' ? outcome.exitCode : null,
              errorMessage:
                outcome.type === 'failed'
                  ? outcome.error instanceof Error
                    ? outcome.error.message
                    : 'ACP terminal unavailable'
                  : undefined,
            });
            if (!handedOff) manager.removeCandidate(candidateId, this.sessionId);
          }

          return {
            success: outcome.type === 'completed' && outcome.exitCode === 0,
            stdout: snapshot.stdout.content,
            stderr: snapshot.stderr.content,
            exitCode: outcome.type === 'completed' ? outcome.exitCode : null,
            error:
              outcome.type === 'timeout'
                ? 'Command timed out'
                : outcome.type === 'aborted' || outcome.type === 'killed'
                  ? 'Command was aborted'
                  : outcome.type === 'failed'
                    ? outcome.error instanceof Error
                      ? `ACP terminal unavailable: ${outcome.error.message}`
                      : 'ACP terminal unavailable'
                    : undefined,
            failureKind:
              outcome.type === 'timeout'
                ? 'timeout'
                : outcome.type === 'aborted' || outcome.type === 'killed'
                  ? 'aborted'
                  : outcome.type === 'failed'
                    ? 'unavailable'
                    : undefined,
            transport: 'acp',
            capture: snapshot,
          };
        })();
        return terminalFinalization;
      };

      if (
        options?.foregroundHandoffMs &&
        options.foregroundHandoffMs > 0 &&
        options.durableOwnership
      ) {
        try {
          const candidate = manager.startExternalForegroundCandidate({
            command,
            sessionId: this.sessionId,
            cwd: options.cwd,
            terminate: async (reason) => {
              await terminateExternal(reason);
            },
          });
          candidateId = candidate.id;
          terminateExternal = async (reason) => {
            await finalizeTerminal({ type: reason });
          };
        } catch (error) {
          if (!(error instanceof BackgroundShellCapacityError)) throw error;
        }
      }

      const raced = await new Promise<RaceOutcome>((resolve) => {
        let resolved = false;
        const settleRace = (value: RaceOutcome) => {
          if (resolved) return;
          resolved = true;
          if (timeoutId) clearTimeout(timeoutId);
          if (handoffId) clearTimeout(handoffId);
          options?.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const timeoutId = options?.timeout
          ? setTimeout(() => settleRace({ type: 'timeout' }), options.timeout)
          : undefined;
        const handoffId =
          candidateId && options?.foregroundHandoffMs
            ? setTimeout(
                () => settleRace({ type: 'handoff' }),
                options.foregroundHandoffMs
              )
            : undefined;
        const onAbort = () => settleRace({ type: 'aborted' });
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener('abort', onAbort, { once: true });
        void exitPromise.then(settleRace);
      });

      if (raced.type === 'handoff' && candidateId && options?.foregroundHandoffMs) {
        const promoted = manager.promoteExternalForegroundCandidate(
          candidateId,
          this.sessionId,
          options.foregroundHandoffMs
        );
        if (promoted) {
          handedOff = true;
          void exitPromise.then(finalizeTerminal);
          return {
            success: true,
            stdout: '',
            stderr: '',
            exitCode: null,
            transport: 'acp',
            capture: capture.snapshot(),
            background: {
              shellId: promoted.id,
              autoBackgrounded: true,
              foregroundBudgetMs: options.foregroundHandoffMs,
            },
          };
        }
      }

      return await finalizeTerminal(
        raced.type === 'handoff' ? await exitPromise : raced
      );
    } catch (error) {
      if (terminal) await terminal.release().catch(() => undefined);
      if (options?.allowLocalFallback !== true) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          error:
            error instanceof Error
              ? `ACP terminal unavailable: ${error.message}`
              : 'ACP terminal unavailable',
          failureKind: 'unavailable',
          transport: 'acp',
        };
      }
      logger.warn(`[AcpTerminal] ACP terminal failed, using fallback:`, error);
      const fallbackResult = await this.fallback.execute(command, options);
      return { ...fallbackResult, transport: 'local_fallback' };
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
  sendUpdate?: (update: SessionNotification['update']) => Promise<void>;
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
    cwd: string,
    sendUpdate?: (update: SessionNotification['update']) => Promise<void>
  ): void {
    // 根据 IDE 能力创建文件系统服务
    const fileSystemService: FileSystemService = clientCapabilities?.fs
      ? new AcpFileSystemService(connection, sessionId, clientCapabilities.fs)
      : new LocalFileSystemService();

    if (clientCapabilities?.fs) {
      logger.debug(`[AcpServiceContext:${sessionId}] Using ACP file system service`);
    }

    // Respect capability negotiation: unsupported ACP methods must not be called.
    const terminalService: TerminalService = clientCapabilities?.terminal
      ? new AcpTerminalService(connection, sessionId)
      : new LocalTerminalService(cwd);
    logger.debug(
      `[AcpServiceContext:${sessionId}] Using ${
        clientCapabilities?.terminal ? 'ACP' : 'local'
      } terminal service`
    );

    // 存储会话服务
    AcpServiceContext.sessions.set(sessionId, {
      fileSystemService,
      terminalService,
      connection,
      sendUpdate,
      clientCapabilities: clientCapabilities || null,
      cwd,
    });

    // 设置当前会话（用于便捷函数）
    AcpServiceContext.currentSessionId = sessionId;

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
      cwd || getCwd()
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
  getFileSystemService(sessionId?: string): FileSystemService {
    const targetSessionId = sessionId ?? AcpServiceContext.currentSessionId;
    if (targetSessionId) {
      const services = AcpServiceContext.sessions.get(targetSessionId);
      if (services) return services.fileSystemService;
    }
    return new LocalFileSystemService();
  }

  /**
   * 获取终端服务（当前会话）
   */
  getTerminalService(sessionId?: string): TerminalService {
    const targetSessionId = sessionId ?? AcpServiceContext.currentSessionId;
    if (targetSessionId) {
      const services = AcpServiceContext.sessions.get(targetSessionId);
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

    if (!services.sendUpdate) return;
    try {
      await services.sendUpdate({
        sessionUpdate: 'tool_call',
        toolCallId,
        status,
        title,
        content: content || [],
        kind: kind || 'other',
      });
    } catch (error) {
      logger.warn('[AcpServiceContext] Failed to send tool update:', error);
    }
  }
}

/**
 * 便捷函数：获取终端服务
 */
export function getAcpFileSystemService(sessionId?: string): FileSystemService {
  return AcpServiceContext.getInstance().getFileSystemService(sessionId);
}

export function getTerminalService(sessionId?: string): TerminalService {
  return AcpServiceContext.getInstance().getTerminalService(sessionId);
}

/**
 * 便捷函数：检查是否在 ACP 模式
 */
export function isAcpMode(sessionId?: string): boolean {
  return sessionId
    ? AcpServiceContext.getSessionServices(sessionId) !== null
    : AcpServiceContext.getInstance().isAcpMode();
}
