import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import {
  type ForegroundProcessOwnership,
  type PreparedForegroundProcess,
  prepareForegroundProcess,
} from '../../../context/storage/DurableForegroundProcess.js';
import { getCwd } from '../../../utils/cwd.js';
import {
  finalizeCommandAdmissionGate,
  releaseCommandAdmissionGate,
  spawnCommandAdmissionGate,
} from '../../../utils/process/CommandAdmissionGate.js';
import type { OwnedProcessTree } from '../../../utils/process/OwnedProcessTree.js';
import { BackgroundShellLeaseStore } from './BackgroundShellLeaseStore.js';
import { BoundedOutputBuffer } from './BoundedOutputBuffer.js';
import {
  ShellOutputCapture,
  type ShellOutputCaptureSnapshot,
} from './ShellOutputCapture.js';
import {
  isWorkspaceSandboxRuntimeFailure,
  type SandboxedCommand,
} from './WorkspaceWriteSandbox.js';

export const BACKGROUND_SHELL_GLOBAL_MAX_ACTIVE = 16;
export const BACKGROUND_SHELL_SESSION_MAX_ACTIVE = 4;

export type BackgroundShellStatus =
  | 'running'
  | 'exited'
  | 'killed'
  | 'timed_out'
  | 'aborted'
  | 'error';
export type BackgroundShellTransport = 'local' | 'acp';
export type BackgroundShellAdmissionScope = 'global' | 'session';

export interface BackgroundShellLimits {
  globalMaxActive?: number;
  sessionMaxActive?: number;
}

export interface StartOptions {
  command: string;
  sessionId: string;
  projectPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  sandboxedCommand?: SandboxedCommand;
}

export interface StartForegroundCandidateOptions extends StartOptions {
  ownership: ForegroundProcessOwnership;
}

export interface StartExternalForegroundCandidateOptions {
  command: string;
  sessionId: string;
  cwd?: string;
  sandboxed?: boolean;
  terminate(reason: 'timeout' | 'aborted' | 'killed'): Promise<void>;
}

export interface BackgroundShellProcess {
  id: string;
  command: string;
  sessionId: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  process?: ChildProcess;
  processTree?: OwnedProcessTree;
  pid?: number;
  status: BackgroundShellStatus;
  exitCode?: number | null;
  signal?: string | null;
  startTime: number;
  endTime?: number;
  errorMessage?: string;
  pendingStdout: BoundedOutputBuffer;
  pendingStderr: BoundedOutputBuffer;
  sandboxed: boolean;
  transport: BackgroundShellTransport;
  visible: boolean;
  autoBackgrounded: boolean;
  backgroundReason?: 'explicit' | 'foreground_budget';
  foregroundBudgetMs?: number;
  completion: Promise<void>;
  leaseStore?: BackgroundShellLeaseStore;
}

interface ManagedBackgroundShellProcess extends BackgroundShellProcess {
  resolveCompletion(): void;
  releaseAdmission(): void;
  foreground?: PreparedForegroundProcess;
  foregroundCapture?: ShellOutputCapture;
  terminateExternal?: (reason: 'timeout' | 'aborted' | 'killed') => Promise<void>;
  terminalSettled: boolean;
  finalizationPromise?: Promise<boolean>;
}

export interface ShellOutputSnapshot {
  id: string;
  command: string;
  status: BackgroundShellStatus;
  stdout: string;
  stderr: string;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
  stdoutTotalBytes: number;
  stderrTotalBytes: number;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  errorMessage?: string;
  sandboxed: boolean;
  transport: BackgroundShellTransport;
  autoBackgrounded: boolean;
  backgroundReason?: 'explicit' | 'foreground_budget';
  foregroundBudgetMs?: number;
  capture?: ShellOutputCaptureSnapshot;
}

export interface KillResult {
  success: boolean;
  alreadyExited: boolean;
  status: BackgroundShellStatus;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export interface WriteInputResult {
  success: boolean;
  status: BackgroundShellStatus;
  bytesWritten: number;
  stdinClosed: boolean;
  errorMessage?: string;
}

export class BackgroundShellCapacityError extends Error {
  constructor(
    readonly scope: BackgroundShellAdmissionScope,
    readonly limit: number
  ) {
    super(`Background Shell ${scope} capacity is full (max ${limit})`);
    this.name = 'BackgroundShellCapacityError';
  }
}

export class BackgroundShellManager {
  private static instance: BackgroundShellManager | null = null;
  private processes = new Map<string, ManagedBackgroundShellProcess>();
  private activeGlobal = 0;
  private readonly activeBySession = new Map<string, number>();
  private readonly globalMaxActive: number;
  private readonly sessionMaxActive: number;

  constructor(limits: BackgroundShellLimits = {}) {
    this.globalMaxActive = this.positiveLimit(
      limits.globalMaxActive ?? BACKGROUND_SHELL_GLOBAL_MAX_ACTIVE,
      'globalMaxActive'
    );
    this.sessionMaxActive = this.positiveLimit(
      limits.sessionMaxActive ?? BACKGROUND_SHELL_SESSION_MAX_ACTIVE,
      'sessionMaxActive'
    );
    if (this.sessionMaxActive > this.globalMaxActive) {
      throw new Error('sessionMaxActive must not exceed globalMaxActive');
    }
  }

  static getInstance(): BackgroundShellManager {
    if (!BackgroundShellManager.instance) {
      BackgroundShellManager.instance = new BackgroundShellManager();
    }
    return BackgroundShellManager.instance;
  }

  async startBackgroundProcess(options: StartOptions): Promise<BackgroundShellProcess> {
    let releaseAdmission: () => void;
    try {
      releaseAdmission = this.reserve(options.sessionId);
    } catch (error) {
      options.sandboxedCommand?.cleanup();
      throw error;
    }
    const shellId = `bash_${randomUUID()}`;
    const mergedEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries({
      ...process.env,
      ...options.env,
      ...options.sandboxedCommand?.env,
      BLADE_CLI: '1',
    })) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }

    const executable = options.sandboxedCommand?.executable ?? 'bash';
    const args = options.sandboxedCommand?.args ?? ['-c', options.command];
    let child: ChildProcess;
    let processTree: OwnedProcessTree;
    try {
      ({ child, processTree } = spawnCommandAdmissionGate(executable, args, {
        cwd: options.cwd || getCwd(),
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch (error) {
      releaseAdmission();
      options.sandboxedCommand?.cleanup();
      throw error;
    }
    if (!child.pid) {
      void processTree.terminate();
      releaseAdmission();
      options.sandboxedCommand?.cleanup();
      throw new Error('Background process did not expose a PID');
    }
    const leaseStore = new BackgroundShellLeaseStore(
      options.projectPath ?? options.cwd ?? getCwd(),
      options.sessionId
    );
    try {
      leaseStore.register(shellId, child.pid);
    } catch (error) {
      let running = true;
      try {
        process.kill(child.pid, 0);
      } catch (processError) {
        running =
          processError instanceof Error &&
          'code' in processError &&
          (processError as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (running) {
        child.kill('SIGKILL');
        void processTree.terminate();
        releaseAdmission();
        options.sandboxedCommand?.cleanup();
        throw error;
      }
    }

    const completion = this.createCompletion();
    const processInfo: ManagedBackgroundShellProcess = {
      id: shellId,
      command: options.command,
      sessionId: options.sessionId,
      cwd: options.cwd,
      env: options.env,
      process: child,
      processTree,
      pid: child.pid,
      status: 'running',
      startTime: Date.now(),
      pendingStdout: new BoundedOutputBuffer(),
      pendingStderr: new BoundedOutputBuffer(),
      sandboxed: Boolean(options.sandboxedCommand),
      transport: 'local',
      visible: true,
      autoBackgrounded: false,
      backgroundReason: 'explicit',
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      releaseAdmission: this.releaseOnce(releaseAdmission),
      terminalSettled: false,
      leaseStore,
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStdout.append(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStderr.append(chunk);
    });

    const finalizeProcessGroup = () => {
      processInfo.finalizationPromise ??= finalizeCommandAdmissionGate(
        child,
        processTree
      )
        .then((result) => {
          if (result.success) {
            processInfo.leaseStore?.remove(processInfo.id);
            return true;
          }
          return false;
        })
        .catch(() => false);
      return processInfo.finalizationPromise;
    };

    child.on('close', (code, signal) => {
      void (async () => {
        const finalized = await finalizeProcessGroup();
        if (processInfo.terminalSettled) return;
        processInfo.terminalSettled = true;
        options.sandboxedCommand?.cleanup();
        const sandboxFailure =
          processInfo.sandboxed &&
          isWorkspaceSandboxRuntimeFailure(
            code,
            processInfo.pendingStderr.peek().content
          );
        processInfo.status =
          processInfo.status === 'killed'
            ? 'killed'
            : sandboxFailure || !finalized
              ? 'error'
              : 'exited';
        processInfo.exitCode = code;
        processInfo.signal = signal;
        if (sandboxFailure) {
          processInfo.errorMessage =
            'Workspace sandbox failed to start; command was not executed';
        } else if (!finalized) {
          processInfo.errorMessage =
            'Background command process group could not be finalized';
        }
        processInfo.endTime = Date.now();
        processInfo.process = undefined;
        processInfo.releaseAdmission();
        processInfo.resolveCompletion();
      })();
    });

    child.on('error', (error) => {
      void (async () => {
        const finalized = await finalizeProcessGroup();
        if (processInfo.terminalSettled) return;
        processInfo.terminalSettled = true;
        options.sandboxedCommand?.cleanup();
        processInfo.status = 'error';
        processInfo.errorMessage = finalized
          ? error.message
          : 'Background command process group could not be finalized';
        processInfo.endTime = Date.now();
        processInfo.process = undefined;
        processInfo.pendingStderr.append(`\n[error] ${error.message}`);
        processInfo.releaseAdmission();
        processInfo.resolveCompletion();
      })();
    });

    this.processes.set(shellId, processInfo);
    try {
      await releaseCommandAdmissionGate(child);
    } catch (error) {
      processInfo.status = 'killed';
      processInfo.endTime = Date.now();
      await processTree.terminate();
      processInfo.leaseStore?.remove(processInfo.id);
      this.processes.delete(shellId);
      processInfo.releaseAdmission();
      processInfo.resolveCompletion();
      options.sandboxedCommand?.cleanup();
      throw new Error('Failed to release durable background command gate', {
        cause: error,
      });
    }
    return processInfo;
  }

  async startForegroundCandidate(
    options: StartForegroundCandidateOptions
  ): Promise<BackgroundShellProcess> {
    const releaseAdmission = this.reserve(options.sessionId);
    const shellId = `bash_${randomUUID()}`;
    const executable = options.sandboxedCommand?.executable ?? 'bash';
    const args = options.sandboxedCommand?.args ?? ['-c', options.command];
    const inheritedEnvironment =
      options.sandboxedCommand?.inheritProcessEnv === false ? {} : process.env;
    let prepared: PreparedForegroundProcess;
    try {
      prepared = await prepareForegroundProcess(
        executable,
        args,
        {
          cwd: options.cwd || getCwd(),
          env: {
            ...inheritedEnvironment,
            ...options.env,
            ...options.sandboxedCommand?.env,
            BLADE_CLI: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
        options.ownership
      );
    } catch (error) {
      releaseAdmission();
      options.sandboxedCommand?.cleanup();
      throw error;
    }

    const { child, processTree } = prepared;
    const completion = this.createCompletion();
    const processInfo: ManagedBackgroundShellProcess = {
      id: shellId,
      command: options.command,
      sessionId: options.sessionId,
      cwd: options.cwd,
      env: options.env,
      process: child,
      processTree,
      pid: child.pid,
      status: 'running',
      startTime: Date.now(),
      pendingStdout: new BoundedOutputBuffer(),
      pendingStderr: new BoundedOutputBuffer(),
      sandboxed: Boolean(options.sandboxedCommand),
      transport: 'local',
      visible: false,
      autoBackgrounded: false,
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      releaseAdmission: this.releaseOnce(releaseAdmission),
      foreground: prepared,
      foregroundCapture: new ShellOutputCapture(),
      terminalSettled: false,
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStdout.append(chunk);
      processInfo.foregroundCapture?.append('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStderr.append(chunk);
      processInfo.foregroundCapture?.append('stderr', chunk);
    });

    const finalizeProcessGroup = () => {
      processInfo.finalizationPromise ??= prepared
        .finalize()
        .then(() => {
          processInfo.leaseStore?.remove(processInfo.id);
          return true;
        })
        .catch(() => false);
      return processInfo.finalizationPromise;
    };

    child.on('close', (code, signal) => {
      void (async () => {
        const finalized = await finalizeProcessGroup();
        if (processInfo.terminalSettled) return;
        processInfo.terminalSettled = true;
        options.sandboxedCommand?.cleanup();
        const sandboxFailure =
          processInfo.sandboxed &&
          isWorkspaceSandboxRuntimeFailure(
            code,
            processInfo.pendingStderr.peek().content
          );
        processInfo.status =
          processInfo.status !== 'running'
            ? processInfo.status
            : sandboxFailure || !finalized
              ? 'error'
              : 'exited';
        processInfo.exitCode = code;
        processInfo.signal = signal;
        if (sandboxFailure) {
          processInfo.errorMessage =
            'Workspace sandbox failed to start; command was not executed';
        } else if (!finalized) {
          processInfo.errorMessage =
            'Background command process group could not be finalized';
        }
        processInfo.endTime = Date.now();
        processInfo.process = undefined;
        processInfo.releaseAdmission();
        processInfo.resolveCompletion();
      })();
    });

    child.on('error', (error) => {
      void (async () => {
        const finalized = await finalizeProcessGroup();
        if (processInfo.terminalSettled) return;
        processInfo.terminalSettled = true;
        options.sandboxedCommand?.cleanup();
        processInfo.status = 'error';
        processInfo.errorMessage = finalized
          ? error.message
          : 'Background command process group could not be finalized';
        processInfo.endTime = Date.now();
        processInfo.process = undefined;
        processInfo.pendingStderr.append(`\n[error] ${error.message}`);
        processInfo.foregroundCapture?.append('stderr', `\n[error] ${error.message}`);
        processInfo.releaseAdmission();
        processInfo.resolveCompletion();
      })();
    });

    this.processes.set(shellId, processInfo);
    try {
      await prepared.release();
    } catch (error) {
      processInfo.status = 'aborted';
      processInfo.endTime = Date.now();
      await processTree.terminate();
      this.processes.delete(shellId);
      processInfo.releaseAdmission();
      processInfo.resolveCompletion();
      options.sandboxedCommand?.cleanup();
      throw error;
    }
    return processInfo;
  }

  startExternalForegroundCandidate(
    options: StartExternalForegroundCandidateOptions
  ): BackgroundShellProcess {
    const releaseAdmission = this.reserve(options.sessionId);
    const shellId = `bash_${randomUUID()}`;
    const completion = this.createCompletion();
    const processInfo: ManagedBackgroundShellProcess = {
      id: shellId,
      command: options.command,
      sessionId: options.sessionId,
      cwd: options.cwd,
      status: 'running',
      startTime: Date.now(),
      pendingStdout: new BoundedOutputBuffer(),
      pendingStderr: new BoundedOutputBuffer(),
      sandboxed: options.sandboxed ?? false,
      transport: 'acp',
      visible: false,
      autoBackgrounded: false,
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      releaseAdmission: this.releaseOnce(releaseAdmission),
      terminateExternal: options.terminate,
      terminalSettled: false,
    };
    this.processes.set(shellId, processInfo);
    return processInfo;
  }

  promoteExternalForegroundCandidate(
    shellId: string,
    sessionId: string,
    foregroundBudgetMs: number
  ): BackgroundShellProcess | undefined {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (
      !processInfo ||
      processInfo.visible ||
      processInfo.status !== 'running' ||
      processInfo.transport !== 'acp'
    ) {
      return undefined;
    }
    processInfo.visible = true;
    processInfo.autoBackgrounded = true;
    processInfo.backgroundReason = 'foreground_budget';
    processInfo.foregroundBudgetMs = foregroundBudgetMs;
    processInfo.foregroundCapture = undefined;
    return processInfo;
  }

  appendExternalOutput(
    shellId: string,
    sessionId: string,
    stream: 'stdout' | 'stderr',
    content: string | Buffer
  ): void {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (!processInfo || processInfo.transport !== 'acp') return;
    if (stream === 'stdout') processInfo.pendingStdout.append(content);
    else processInfo.pendingStderr.append(content);
  }

  replaceExternalOutput(
    shellId: string,
    sessionId: string,
    stdout: string,
    stderr: string
  ): void {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (!processInfo || processInfo.transport !== 'acp') return;
    processInfo.pendingStdout = new BoundedOutputBuffer();
    processInfo.pendingStderr = new BoundedOutputBuffer();
    processInfo.pendingStdout.append(stdout);
    processInfo.pendingStderr.append(stderr);
  }

  completeExternalProcess(
    shellId: string,
    sessionId: string,
    outcome: {
      status: Extract<
        BackgroundShellStatus,
        'exited' | 'killed' | 'timed_out' | 'aborted' | 'error'
      >;
      exitCode?: number | null;
      signal?: string | null;
      errorMessage?: string;
    }
  ): void {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (
      !processInfo ||
      processInfo.transport !== 'acp' ||
      processInfo.terminalSettled
    ) {
      return;
    }
    processInfo.terminalSettled = true;
    processInfo.status = outcome.status;
    processInfo.exitCode = outcome.exitCode;
    processInfo.signal = outcome.signal;
    processInfo.errorMessage = outcome.errorMessage;
    processInfo.endTime = Date.now();
    processInfo.releaseAdmission();
    processInfo.resolveCompletion();
  }

  promoteForegroundCandidate(
    shellId: string,
    sessionId: string,
    projectPath: string,
    foregroundBudgetMs: number
  ): BackgroundShellProcess | undefined {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (
      !processInfo ||
      processInfo.visible ||
      processInfo.status !== 'running' ||
      !processInfo.foreground
    ) {
      return undefined;
    }

    const leaseStore = new BackgroundShellLeaseStore(projectPath, sessionId);
    processInfo.foreground.handoff(
      (rootPid) => leaseStore.register(shellId, rootPid),
      () => leaseStore.remove(shellId)
    );
    processInfo.leaseStore = leaseStore;
    processInfo.visible = true;
    processInfo.autoBackgrounded = true;
    processInfo.backgroundReason = 'foreground_budget';
    processInfo.foregroundBudgetMs = foregroundBudgetMs;
    return processInfo;
  }

  waitForCompletion(shellId: string, sessionId: string): Promise<void> | undefined {
    return this.getOwnedProcess(shellId, sessionId)?.completion;
  }

  consumeCandidateOutput(
    shellId: string,
    sessionId: string
  ): ShellOutputSnapshot | undefined {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (!processInfo) return undefined;
    const snapshot = this.snapshot(processInfo, true);
    if (processInfo.foregroundCapture) {
      processInfo.foregroundCapture.finish();
      snapshot.capture = processInfo.foregroundCapture.snapshot();
      processInfo.foregroundCapture = undefined;
    }
    return snapshot;
  }

  removeCandidate(shellId: string, sessionId: string): void {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (!processInfo || processInfo.visible || processInfo.status === 'running') return;
    this.processes.delete(shellId);
  }

  terminateForegroundCandidate(
    shellId: string,
    sessionId: string,
    reason: 'timeout' | 'aborted'
  ): Promise<KillResult> | undefined {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (!processInfo || processInfo.visible) return undefined;
    return this.terminateProcess(processInfo, reason);
  }

  consumeOutput(shellId: string, sessionId: string): ShellOutputSnapshot | undefined {
    const processInfo = this.getProcess(shellId, sessionId);
    if (!processInfo) {
      return undefined;
    }

    return this.snapshot(processInfo, true);
  }

  getProcess(shellId: string, sessionId: string): BackgroundShellProcess | undefined {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    return processInfo?.visible ? processInfo : undefined;
  }

  listForSession(sessionId: string): BackgroundShellProcess[] {
    return Array.from(this.processes.values()).filter(
      (processInfo) => processInfo.sessionId === sessionId && processInfo.visible
    );
  }

  async writeInput(
    shellId: string,
    sessionId: string,
    data: string,
    closeStdin = false
  ): Promise<WriteInputResult | undefined> {
    const processInfo = this.getProcess(shellId, sessionId);
    if (!processInfo) {
      return undefined;
    }
    if (processInfo.transport === 'acp') {
      return {
        success: false,
        status: processInfo.status,
        bytesWritten: 0,
        stdinClosed: false,
        errorMessage: 'ACP background terminals do not support stdin writes',
      };
    }

    const stdin = processInfo.process?.stdin;
    if (
      processInfo.status !== 'running' ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      return {
        success: false,
        status: processInfo.status,
        bytesWritten: 0,
        stdinClosed: !stdin || stdin.destroyed || stdin.writableEnded,
        errorMessage: 'Shell stdin is not writable',
      };
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          stdin.off('error', onError);
          reject(error);
        };
        const onWritten = (error?: Error | null) => {
          stdin.off('error', onError);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        stdin.once('error', onError);
        if (closeStdin) {
          stdin.end(data, onWritten);
        } else {
          stdin.write(data, onWritten);
        }
      });

      return {
        success: true,
        status: processInfo.status,
        bytesWritten: Buffer.byteLength(data),
        stdinClosed: closeStdin,
      };
    } catch (error) {
      return {
        success: false,
        status: processInfo.status,
        bytesWritten: 0,
        stdinClosed: stdin.destroyed || stdin.writableEnded,
        errorMessage: error instanceof Error ? error.message : 'Failed to write stdin',
      };
    }
  }

  async kill(shellId: string, sessionId: string): Promise<KillResult | undefined> {
    const processInfo = this.getOwnedProcess(shellId, sessionId);
    if (!processInfo?.visible) {
      return undefined;
    }

    return this.terminateProcess(processInfo);
  }

  async killSession(sessionId: string): Promise<void> {
    const ownedProcesses = Array.from(this.processes.values()).filter(
      (processInfo) => processInfo.sessionId === sessionId
    );
    await Promise.all(
      ownedProcesses.map((processInfo) => this.terminateProcess(processInfo))
    );
    for (const processInfo of ownedProcesses) {
      this.processes.delete(processInfo.id);
    }
  }

  reapOrphanedSession(
    sessionId: string,
    projectPath: string
  ): Promise<{ reaped: number; stale: number; active: number; protected: number }> {
    return new BackgroundShellLeaseStore(projectPath, sessionId).reapOrphans();
  }

  private async terminateProcess(
    processInfo: ManagedBackgroundShellProcess,
    reason: 'timeout' | 'aborted' | 'killed' = 'killed'
  ): Promise<KillResult> {
    if (processInfo.status !== 'running') {
      return {
        success: false,
        alreadyExited: true,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }

    processInfo.status =
      reason === 'timeout' ? 'timed_out' : reason === 'aborted' ? 'aborted' : 'killed';
    processInfo.endTime = Date.now();
    if (processInfo.terminateExternal) {
      try {
        await processInfo.terminateExternal(reason);
      } catch (error) {
        processInfo.status = 'error';
        processInfo.errorMessage =
          error instanceof Error ? error.message : 'Failed to terminate ACP terminal';
      }
      processInfo.releaseAdmission();
      return {
        success: processInfo.status !== 'error',
        alreadyExited: false,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }
    if (!processInfo.process) {
      processInfo.releaseAdmission();
      return {
        success: false,
        alreadyExited: true,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }
    const termination = await processInfo.processTree?.terminate();
    if (!termination?.success) {
      processInfo.status = 'error';
      processInfo.errorMessage = 'Failed to terminate owned process tree';
      return {
        success: false,
        alreadyExited: termination?.alreadyExited ?? false,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }
    processInfo.leaseStore?.remove(processInfo.id);
    processInfo.releaseAdmission();

    return {
      success: true,
      alreadyExited: termination.alreadyExited,
      status: processInfo.status,
      pid: processInfo.pid,
      exitCode: processInfo.exitCode,
      signal: processInfo.signal,
    };
  }

  /**
   * 终止所有后台进程
   * 在应用退出时调用
   */
  async killAll(): Promise<void> {
    await Promise.all(
      Array.from(this.processes.values()).map((processInfo) =>
        this.terminateProcess(processInfo)
      )
    );
    this.processes.clear();
  }

  getAdmissionStats(): {
    active: number;
    maxActive: number;
    sessions: Record<string, { active: number; maxActive: number }>;
  } {
    return {
      active: this.activeGlobal,
      maxActive: this.globalMaxActive,
      sessions: Object.fromEntries(
        [...this.activeBySession].map(([sessionId, active]) => [
          sessionId,
          { active, maxActive: this.sessionMaxActive },
        ])
      ),
    };
  }

  private getOwnedProcess(
    shellId: string,
    sessionId: string
  ): ManagedBackgroundShellProcess | undefined {
    const processInfo = this.processes.get(shellId);
    return processInfo?.sessionId === sessionId ? processInfo : undefined;
  }

  private snapshot(
    processInfo: BackgroundShellProcess,
    consume: boolean
  ): ShellOutputSnapshot {
    const stdout = consume
      ? processInfo.pendingStdout.consume()
      : processInfo.pendingStdout.peek();
    const stderr = consume
      ? processInfo.pendingStderr.consume()
      : processInfo.pendingStderr.peek();
    return {
      id: processInfo.id,
      command: processInfo.command,
      status: processInfo.status,
      stdout: stdout.content,
      stderr: stderr.content,
      stdoutOmittedBytes: stdout.omittedBytes,
      stderrOmittedBytes: stderr.omittedBytes,
      stdoutTotalBytes: stdout.totalBytes,
      stderrTotalBytes: stderr.totalBytes,
      exitCode: processInfo.exitCode,
      signal: processInfo.signal,
      pid: processInfo.pid,
      startedAt: processInfo.startTime,
      endedAt: processInfo.endTime,
      errorMessage: processInfo.errorMessage,
      sandboxed: processInfo.sandboxed,
      transport: processInfo.transport,
      autoBackgrounded: processInfo.autoBackgrounded,
      backgroundReason: processInfo.backgroundReason,
      foregroundBudgetMs: processInfo.foregroundBudgetMs,
    };
  }

  private reserve(sessionId: string): () => void {
    const sessionActive = this.activeBySession.get(sessionId) ?? 0;
    if (sessionActive >= this.sessionMaxActive) {
      throw new BackgroundShellCapacityError('session', this.sessionMaxActive);
    }
    if (this.activeGlobal >= this.globalMaxActive) {
      throw new BackgroundShellCapacityError('global', this.globalMaxActive);
    }

    this.activeGlobal++;
    this.activeBySession.set(sessionId, sessionActive + 1);
    return this.releaseOnce(() => {
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const next = Math.max(0, (this.activeBySession.get(sessionId) ?? 0) - 1);
      if (next === 0) this.activeBySession.delete(sessionId);
      else this.activeBySession.set(sessionId, next);
    });
  }

  private releaseOnce(release: () => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  private createCompletion(): {
    promise: Promise<void>;
    resolve(): void;
  } {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  private positiveLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  }
}
