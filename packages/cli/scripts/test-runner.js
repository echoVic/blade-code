import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const DEFAULT_GRACE_PERIOD_MS = 500;
const WATCHDOG_SHUTDOWN_TIMEOUT_MS = 1_000;
const WATCHDOG_PATH = fileURLToPath(
  new URL('./test-owner-watchdog.js', import.meta.url)
);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

function signalPosixTree(child, signal) {
  const pid = child.pid;
  if (!pid || pid <= 1 || pid === process.pid) return child.kill(signal);

  try {
    return process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return true;
    return child.kill(signal);
  }
}

function taskkill(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const killer = spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const settle = (success) => {
      if (settled) return;
      settled = true;
      resolve(success);
    };
    killer.once('error', () => settle(false));
    killer.once('close', (code) => settle(code === 0));
  });
}

async function terminateProcessTree(child, gracePeriodMs) {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    await taskkill(pid, false);
    await wait(gracePeriodMs);
    await taskkill(pid, true);
    return;
  }

  signalPosixTree(child, 'SIGTERM');
  await wait(gracePeriodMs);
  signalPosixTree(child, 'SIGKILL');
}

function startOwnerWatchdog(targetPid) {
  const watchdog = spawn(
    process.execPath,
    [WATCHDOG_PATH, String(process.pid), String(targetPid)],
    {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    }
  );
  watchdog.unref();
  return watchdog;
}

async function stopOwnerWatchdog(watchdog) {
  if (watchdog.exitCode !== null || watchdog.signalCode !== null) return;
  watchdog.stdin?.end('done\n');
  const exited = once(watchdog, 'close');
  const timeout = wait(WATCHDOG_SHUTDOWN_TIMEOUT_MS).then(() => 'timeout');
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    watchdog.kill('SIGKILL');
  }
}

export async function runOwnedCommand({
  command,
  args,
  cwd,
  env = process.env,
  stdio = 'inherit',
  timeoutMs,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  signal,
}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const watchdog = child.pid ? startOwnerWatchdog(child.pid) : undefined;
  let timedOut = false;
  let aborted = false;
  let terminationPromise;

  const terminate = () => {
    terminationPromise ??= terminateProcessTree(child, gracePeriodMs);
    return terminationPromise;
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);
  const abort = () => {
    aborted = true;
    void terminate();
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => {
        resolve({ exitCode, signal: exitSignal });
      });
    });
    if (terminationPromise) await terminationPromise;
    return { ...result, timedOut, aborted };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (watchdog) await stopOwnerWatchdog(watchdog);
  }
}
