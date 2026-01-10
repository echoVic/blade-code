import { type ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';

type BackgroundShellStatus = 'running' | 'exited' | 'killed' | 'error';

interface StartOptions {
  command: string;
  sessionId: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface BackgroundShellProcess {
  id: string;
  command: string;
  sessionId: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  process?: ChildProcess;
  pid?: number;
  status: BackgroundShellStatus;
  exitCode?: number | null;
  signal?: string | null;
  startTime: number;
  endTime?: number;
  errorMessage?: string;
  pendingStdout: string;
  pendingStderr: string;
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
      BLADE_CLI: '1',
    })) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }

    const child = spawn('bash', ['-c', options.command], {
      cwd: options.cwd || process.cwd(),
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
      pid: child.pid,
      status: 'running',
      startTime: Date.now(),
      pendingStdout: '',
      pendingStderr: '',
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
      processInfo.status = processInfo.status === 'killed' ? 'killed' : 'exited';
      processInfo.exitCode = code;
      processInfo.signal = signal;
      processInfo.endTime = Date.now();
      processInfo.process = undefined;
    });

    child.on('error', (error) => {
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
    };

    processInfo.pendingStdout = '';
    processInfo.pendingStderr = '';

    return snapshot;
  }

  getProcess(shellId: string): BackgroundShellProcess | undefined {
    return this.processes.get(shellId);
  }

  kill(shellId: string): KillResult | undefined {
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

    const killed = processInfo.process.kill('SIGTERM');
    if (!killed) {
      return {
        success: false,
        alreadyExited: false,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }

    processInfo.status = 'killed';
    processInfo.endTime = Date.now();
    processInfo.process = undefined;

    return {
      success: true,
      alreadyExited: false,
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
  killAll(): void {
    for (const [_shellId, processInfo] of this.processes) {
      if (processInfo.status === 'running' && processInfo.process) {
        try {
          processInfo.process.kill('SIGTERM');
          processInfo.status = 'killed';
          processInfo.endTime = Date.now();
          processInfo.process = undefined;
        } catch {
          // 忽略终止失败（进程可能已退出）
        }
      }
    }
    this.processes.clear();
  }
}
