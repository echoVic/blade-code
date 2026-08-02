import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { getCwd } from '../../../utils/cwd.js';
import {
  type OwnedProcessTree,
  spawnOwnedProcess,
} from '../../../utils/process/OwnedProcessTree.js';
import {
  isWorkspaceSandboxRuntimeFailure,
  type SandboxedCommand,
} from './WorkspaceWriteSandbox.js';

type BackgroundShellStatus = 'running' | 'exited' | 'killed' | 'error';

interface StartOptions {
  command: string;
  sessionId: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  sandboxedCommand?: SandboxedCommand;
}

interface BackgroundShellProcess {
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
  pendingStdout: string;
  pendingStderr: string;
  sandboxed: boolean;
}

export interface ShellOutputSnapshot {
  id: string;
  command: string;
  status: BackgroundShellStatus;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  errorMessage?: string;
  sandboxed: boolean;
}

export interface KillResult {
  success: boolean;
  alreadyExited: boolean;
  status: BackgroundShellStatus;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export class BackgroundShellManager {
  private static instance: BackgroundShellManager | null = null;
  private processes = new Map<string, BackgroundShellProcess>();

  static getInstance(): BackgroundShellManager {
    if (!BackgroundShellManager.instance) {
      BackgroundShellManager.instance = new BackgroundShellManager();
    }
    return BackgroundShellManager.instance;
  }

  startBackgroundProcess(options: StartOptions): BackgroundShellProcess {
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
    const { child, processTree } = spawnOwnedProcess(executable, args, {
      cwd: options.cwd || getCwd(),
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const processInfo: BackgroundShellProcess = {
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
      pendingStdout: '',
      pendingStderr: '',
      sandboxed: Boolean(options.sandboxedCommand),
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      options.sandboxedCommand?.cleanup();
      const sandboxFailure =
        processInfo.sandboxed &&
        isWorkspaceSandboxRuntimeFailure(code, processInfo.pendingStderr);
      processInfo.status =
        processInfo.status === 'killed'
          ? 'killed'
          : sandboxFailure
            ? 'error'
            : 'exited';
      processInfo.exitCode = code;
      processInfo.signal = signal;
      if (sandboxFailure) {
        processInfo.errorMessage =
          'Workspace sandbox failed to start; command was not executed';
      }
      processInfo.endTime = Date.now();
      processInfo.process = undefined;
    });

    child.on('error', (error) => {
      options.sandboxedCommand?.cleanup();
      processInfo.status = 'error';
      processInfo.errorMessage = error.message;
      processInfo.endTime = Date.now();
      processInfo.process = undefined;
      processInfo.pendingStderr += `\n[error] ${error.message}`;
    });

    this.processes.set(shellId, processInfo);
    return processInfo;
  }

  consumeOutput(shellId: string): ShellOutputSnapshot | undefined {
    const processInfo = this.processes.get(shellId);
    if (!processInfo) {
      return undefined;
    }

    const snapshot: ShellOutputSnapshot = {
      id: processInfo.id,
      command: processInfo.command,
      status: processInfo.status,
      stdout: processInfo.pendingStdout,
      stderr: processInfo.pendingStderr,
      exitCode: processInfo.exitCode,
      signal: processInfo.signal,
      pid: processInfo.pid,
      startedAt: processInfo.startTime,
      endedAt: processInfo.endTime,
      errorMessage: processInfo.errorMessage,
      sandboxed: processInfo.sandboxed,
    };

    processInfo.pendingStdout = '';
    processInfo.pendingStderr = '';

    return snapshot;
  }

  getProcess(shellId: string): BackgroundShellProcess | undefined {
    return this.processes.get(shellId);
  }

  async kill(shellId: string): Promise<KillResult | undefined> {
    const processInfo = this.processes.get(shellId);
    if (!processInfo) {
      return undefined;
    }

    if (processInfo.status !== 'running' || !processInfo.process) {
      return {
        success: false,
        alreadyExited: true,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }

    processInfo.status = 'killed';
    processInfo.endTime = Date.now();
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
    const runningShellIds = Array.from(this.processes.values())
      .filter((processInfo) => processInfo.status === 'running')
      .map((processInfo) => processInfo.id);
    await Promise.all(runningShellIds.map((shellId) => this.kill(shellId)));
    this.processes.clear();
  }
}
