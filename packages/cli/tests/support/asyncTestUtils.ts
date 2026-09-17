import type { ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';

export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause: lastError });
}

export async function waitForInboxRemoval(
  workspace: string,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  const inboxPath = getSessionInboxFilePath(workspace, sessionId);
  await waitForCondition(
    async () =>
      access(inboxPath).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return true;
          throw error;
        }
      ),
    'Session inbox was not removed before timeout',
    timeoutMs
  );
}

export async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  await waitForCondition(
    async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    },
    `Timed out waiting for ${url}`,
    timeoutMs
  );
}

export function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Test child process did not exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve test server port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
