import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { getCwd } from '../../../utils/cwd.js';
import {
  type OwnedProcessTree,
  spawnOwnedProcess,
} from '../../../utils/process/OwnedProcessTree.js';
import { BackgroundShellLeaseStore } from './BackgroundShellLeaseStore.js';
import { BoundedOutputBuffer } from './BoundedOutputBuffer.js';
import {
  isWorkspaceSandboxRuntimeFailure,
  type SandboxedCommand,
} from './WorkspaceWriteSandbox.js';

type BackgroundShellStatus = 'running' | 'exited' | 'killed' | 'error';

const BACKGROUND_COMMAND_GATE = String.raw`
const { spawn } = require('node:child_process');
const [command, ...args] = process.argv.slice(1);
process.stdin.once('data', (chunk) => {
  if (!command || chunk[0] !== 1) process.exit(125);
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  child.once('error', (error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(126);
  });
  child.once('close', (code) => {
    process.exit(code === null ? 1 : code);
  });
  if (chunk.length > 1) child.stdin.write(chunk.subarray(1));
  process.stdin.pipe(child.stdin);
});
`;

interface StartOptions {
  command: string;
  sessionId: string;
  projectPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  sandboxedCommand?: SandboxedCommand;
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
  leaseStore?: BackgroundShellLeaseStore;
}

export interface ShellOutputSnapshot {
  id: string;
  command: string;
  status: BackgroundShellStatus;
  stdout: string;
  stderr: string;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
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

export interface WriteInputResult {
  success: boolean;
  status: BackgroundShellStatus;
  bytesWritten: number;
  stdinClosed: boolean;
  errorMessage?: string;
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

  async startBackgroundProcess(options: StartOptions): Promise<BackgroundShellProcess> {
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
    const { child, processTree } = spawnOwnedProcess(
      process.execPath,
      ['-e', BACKGROUND_COMMAND_GATE, executable, ...args],
      {
        cwd: options.cwd || getCwd(),
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    if (!child.pid) {
      void processTree.terminate();
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
        options.sandboxedCommand?.cleanup();
        throw error;
      }
    }

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
      pendingStdout: new BoundedOutputBuffer(),
      pendingStderr: new BoundedOutputBuffer(),
      sandboxed: Boolean(options.sandboxedCommand),
      leaseStore,
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStdout.append(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStderr.append(chunk);
    });

    child.on('close', (code, signal) => {
      processInfo.leaseStore?.remove(processInfo.id);
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
      processInfo.leaseStore?.remove(processInfo.id);
      options.sandboxedCommand?.cleanup();
      processInfo.status = 'error';
      processInfo.errorMessage = error.message;
      processInfo.endTime = Date.now();
      processInfo.process = undefined;
      processInfo.pendingStderr.append(`\n[error] ${error.message}`);
    });

    this.processes.set(shellId, processInfo);
    try {
      await this.releaseCommandGate(child);
    } catch (error) {
      processInfo.status = 'killed';
      processInfo.endTime = Date.now();
      await processTree.terminate();
      processInfo.leaseStore?.remove(processInfo.id);
      this.processes.delete(shellId);
      throw new Error('Failed to release durable background command gate', {
        cause: error,
      });
    }
    return processInfo;
  }

  private async releaseCommandGate(child: ChildProcess): Promise<void> {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error('Background command gate stdin is unavailable');
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stdin.off('error', onError);
        reject(error);
      };
      stdin.once('error', onError);
      stdin.write(Buffer.from([1]), (error?: Error | null) => {
        stdin.off('error', onError);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  consumeOutput(shellId: string, sessionId: string): ShellOutputSnapshot | undefined {
    const processInfo = this.getProcess(shellId, sessionId);
    if (!processInfo) {
      return undefined;
    }

    const stdout = processInfo.pendingStdout.consume();
    const stderr = processInfo.pendingStderr.consume();
    const snapshot: ShellOutputSnapshot = {
      id: processInfo.id,
      command: processInfo.command,
      status: processInfo.status,
      stdout: stdout.content,
      stderr: stderr.content,
      stdoutOmittedBytes: stdout.omittedBytes,
      stderrOmittedBytes: stderr.omittedBytes,
      exitCode: processInfo.exitCode,
      signal: processInfo.signal,
      pid: processInfo.pid,
      startedAt: processInfo.startTime,
      endedAt: processInfo.endTime,
      errorMessage: processInfo.errorMessage,
      sandboxed: processInfo.sandboxed,
    };

    return snapshot;
  }

  getProcess(shellId: string, sessionId: string): BackgroundShellProcess | undefined {
    const processInfo = this.processes.get(shellId);
    return processInfo?.sessionId === sessionId ? processInfo : undefined;
  }

  listForSession(sessionId: string): BackgroundShellProcess[] {
    return Array.from(this.processes.values()).filter(
      (processInfo) => processInfo.sessionId === sessionId
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
    const processInfo = this.getProcess(shellId, sessionId);
    if (!processInfo) {
      return undefined;
    }

    return this.terminateProcess(processInfo);
  }

  async killSession(sessionId: string): Promise<void> {
    const ownedProcesses = this.listForSession(sessionId);
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
    processInfo: BackgroundShellProcess
  ): Promise<KillResult> {
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
    processInfo.leaseStore?.remove(processInfo.id);

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
}
