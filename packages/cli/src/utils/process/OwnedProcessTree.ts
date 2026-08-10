import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

const DEFAULT_TERM_GRACE_MS = 500;

type ProcessSignal = 'SIGTERM' | 'SIGKILL';
type KillProcess = (pid: number, signal: ProcessSignal) => boolean;
type Taskkill = (pid: number, force: boolean) => Promise<boolean>;
type Wait = (milliseconds: number) => Promise<void>;

export interface OwnedProcessTreeOptions {
  platform?: NodeJS.Platform;
  gracePeriodMs?: number;
  releaseOnExit?: boolean;
  killProcess?: KillProcess;
  taskkill?: Taskkill;
  wait?: Wait;
}

export interface ProcessTreeTerminationResult {
  success: boolean;
  alreadyExited: boolean;
  forced: boolean;
}

export interface SpawnedOwnedProcess {
  child: ChildProcess;
  processTree: OwnedProcessTree;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');

    const killer = spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      resolve(success);
    };
    killer.once('error', () => settle(false));
    killer.once('close', (code) => settle(code === 0));
  });
}

/**
 * Owns the lifetime of one child process and the descendants it creates.
 * POSIX children must be spawned as detached group leaders; use
 * spawnOwnedProcess() to preserve that invariant.
 */
export class OwnedProcessTree {
  private state: 'owned' | 'terminating' | 'released' = 'owned';
  private terminationPromise?: Promise<ProcessTreeTerminationResult>;
  private terminationResult?: ProcessTreeTerminationResult;
  private readonly platform: NodeJS.Platform;
  private readonly gracePeriodMs: number;
  private readonly killProcess: KillProcess;
  private readonly taskkill: Taskkill;
  private readonly wait: Wait;

  constructor(
    private readonly child: ChildProcess,
    options: OwnedProcessTreeOptions = {}
  ) {
    this.platform = options.platform ?? process.platform;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_TERM_GRACE_MS;
    this.killProcess = options.killProcess ?? process.kill.bind(process);
    this.taskkill = options.taskkill ?? runTaskkill;
    this.wait = options.wait ?? wait;

    if (options.releaseOnExit !== false) {
      const releaseAfterNaturalExit = () => {
        if (this.state === 'owned') this.state = 'released';
      };
      child.once('close', releaseAfterNaturalExit);
      child.once('error', releaseAfterNaturalExit);
    }
  }

  release(): void {
    if (this.state === 'owned') this.state = 'released';
  }

  terminate(): Promise<ProcessTreeTerminationResult> {
    if (this.terminationPromise) return this.terminationPromise;
    if (this.terminationResult) return Promise.resolve(this.terminationResult);
    if (this.state === 'released') {
      this.terminationResult = {
        success: true,
        alreadyExited: true,
        forced: false,
      };
      return Promise.resolve(this.terminationResult);
    }

    this.state = 'terminating';
    this.terminationPromise = this.terminateOwnedTree().then((result) => {
      this.state = 'released';
      this.terminationResult = result;
      return result;
    });
    return this.terminationPromise;
  }

  private async terminateOwnedTree(): Promise<ProcessTreeTerminationResult> {
    const pid = this.child.pid;
    if (!pid) {
      return { success: false, alreadyExited: true, forced: false };
    }

    if (this.platform === 'win32') {
      const graceful = await this.taskkill(pid, false);
      await this.wait(this.gracePeriodMs);
      const forced = await this.taskkill(pid, true);
      if (!graceful && !forced) {
        return {
          success: this.signalDirectChild('SIGKILL'),
          alreadyExited: false,
          forced: true,
        };
      }
      return { success: true, alreadyExited: false, forced: true };
    }

    const graceful = this.signalPosixTree(pid, 'SIGTERM');
    await this.wait(this.gracePeriodMs);
    const forced = this.signalPosixTree(pid, 'SIGKILL');
    return {
      success: graceful || forced,
      alreadyExited: false,
      forced,
    };
  }

  private signalPosixTree(pid: number, signal: ProcessSignal): boolean {
    if (pid <= 1 || pid === process.pid) {
      return this.signalDirectChild(signal);
    }

    try {
      return this.killProcess(-pid, signal);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return true;
      return this.signalDirectChild(signal);
    }
  }

  private signalDirectChild(signal: ProcessSignal): boolean {
    try {
      return this.child.kill(signal);
    } catch (error) {
      return errorCode(error) === 'ESRCH';
    }
  }
}

export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  processTreeOptions: OwnedProcessTreeOptions = {}
): SpawnedOwnedProcess {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform === 'win32' ? options.detached : true,
    windowsHide: options.windowsHide ?? true,
  });
  return {
    child,
    processTree: new OwnedProcessTree(child, processTreeOptions),
  };
}
