import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  type OwnedProcessTreeOptions,
  type ProcessTreeTerminationResult,
  processGroupIsRunning,
  type SpawnedOwnedProcess,
  spawnOwnedProcess,
  terminateProcessGroupByPid,
} from './OwnedProcessTree.js';

const COMMAND_ADMISSION_GATE = String.raw`
const { spawn } = require('node:child_process');
const [ownerPidValue, command, ...args] = process.argv.slice(1);
const ownerPid = Number(ownerPidValue);
const ownerWatchdogIntervalMs = 500;
let child;
let terminating = false;
let finished = false;

const ownerIsRunning = () => {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) return false;
  if (process.platform !== 'win32' && process.ppid !== ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
};

const exitOnce = (code) => {
  if (finished) return;
  finished = true;
  process.exit(code);
};

const terminateTree = () => {
  if (terminating || finished) return;
  terminating = true;
  if (!child || !child.pid) {
    exitOnce(125);
    return;
  }
  child.stdin.destroy();

  if (process.platform === 'win32') {
    const taskkill = (force, done) => {
      const task = spawn(
        'taskkill',
        ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
        { stdio: 'ignore', windowsHide: true }
      );
      task.once('error', done);
      task.once('close', done);
    };
    taskkill(false, () => {
      setTimeout(() => taskkill(true, () => exitOnce(143)), 500);
    });
    return;
  }

  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, 500);
};

setInterval(() => {
  if (!ownerIsRunning()) terminateTree();
}, ownerWatchdogIntervalMs);

process.on('SIGTERM', terminateTree);
process.on('SIGINT', terminateTree);
process.stdin.on('end', () => {
  if (!child) {
    exitOnce(125);
  } else if (ownerIsRunning()) {
    child.stdin.end();
  } else {
    terminateTree();
  }
});
process.stdin.on('close', () => {
  if (!finished && !ownerIsRunning()) terminateTree();
});
process.stdin.on('error', () => {
  if (!ownerIsRunning()) terminateTree();
});

process.stdin.once('data', (chunk) => {
  if (!command || chunk[0] !== 1) {
    exitOnce(125);
    return;
  }
  child = spawn(command, args, {
    env: process.env,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  child.once('error', (error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    exitOnce(126);
  });
  child.once('close', (code) => {
    if (!terminating) exitOnce(code === null ? 1 : code);
  });
  if (chunk.length > 1) child.stdin.write(chunk.subarray(1));
  process.stdin.on('data', (nextChunk) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(nextChunk);
    }
  });
});
`;

export function spawnCommandAdmissionGate(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
  processTreeOptions: OwnedProcessTreeOptions = {}
): SpawnedOwnedProcess {
  return spawnOwnedProcess(
    process.execPath,
    ['-e', COMMAND_ADMISSION_GATE, String(process.pid), executable, ...args],
    options,
    { releaseOnExit: false, ...processTreeOptions }
  );
}

export async function releaseCommandAdmissionGate(child: ChildProcess): Promise<void> {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    throw new Error('Command admission gate stdin is unavailable');
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

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
}

export async function finalizeCommandAdmissionGate(
  child: ChildProcess,
  processTree: SpawnedOwnedProcess['processTree']
): Promise<ProcessTreeTerminationResult> {
  const pid = child.pid;
  if (process.platform === 'win32' || !pid || !processGroupIsRunning(pid)) {
    processTree.release();
    return { success: true, alreadyExited: true, forced: false };
  }

  const result = await terminateProcessGroupByPid(pid, {
    validatePidOwnership: () => !processIsRunning(pid),
  });
  if (result.success) processTree.release();
  return result;
}
