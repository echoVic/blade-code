import { type ChildProcess, spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Session } from '../../src/api/schemas.js';
import { SessionService } from '../../src/services/SessionService.js';
import type { TestModelConfig } from '../integration/real-api/testConfig.js';
import {
  createPairedAcpProductionFixture,
  type PairedAcpFixtureSessionRef,
  type PairedAcpProductionFixture,
} from './acp/remoteFilesystemQualification.js';

const CLI_ENTRY = path.resolve(import.meta.dirname, '../../dist/blade.js');
const OUTPUT_TAIL_LIMIT = 16_384;

export interface SessionSurfaceGuiContext {
  readonly origin: string;
  readonly session: PairedAcpFixtureSessionRef;
  readonly localSession: Session;
  getOutput(): string;
}

export interface LaunchSessionSurfaceGuiInput {
  readonly model: TestModelConfig;
  readonly frameworkRetryBudget: number;
  readonly fixtureRoot: string;
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
}

function browserCacheRoot(): string {
  let current = path.dirname(chromium.executablePath());
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'ms-playwright') return current;
    current = path.dirname(current);
  }
  throw new Error('Unable to locate the qualified Playwright browser cache');
}

function boundedTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > OUTPUT_TAIL_LIMIT ? next.slice(-OUTPUT_TAIL_LIMIT) : next;
}

export async function reserveSessionSurfacePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve Session surface GUI port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export async function waitForSessionSurfaceCondition(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      cause = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause });
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Session surface GUI server did not exit'));
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForChildExit(child, 10_000);
  } catch {
    child.kill('SIGKILL');
    await waitForChildExit(child, 10_000);
  }
}

export async function withSessionSurfaceGui(
  input: LaunchSessionSurfaceGuiInput,
  callback: (context: SessionSurfaceGuiContext) => undefined | Promise<undefined>
): Promise<{
  readonly evidence: PairedAcpProductionFixture['serializableEvidence'];
  readonly coordinates: PairedAcpProductionFixture['serializableCoordinates'];
}> {
  const fixture = await createPairedAcpProductionFixture({
    model: input.model,
    frameworkRetryBudget: input.frameworkRetryBudget,
    fixtureRoot: input.fixtureRoot,
  });
  try {
    await fixture.withSessionRef(async (session) => {
      const localWorkspace = path.resolve(import.meta.dirname, '../..');
      const localSession = await SessionService.createSessionMetadata(
        'web-local-qualification',
        localWorkspace,
        {
          title: 'Local qualification session',
          taskStatus: 'completed',
        }
      );
      const appPort = await reserveSessionSurfacePort();
      const origin = `http://127.0.0.1:${appPort}`;
      let output = '';
      const child = spawn(
        process.execPath,
        [CLI_ENTRY, 'serve', '--hostname', '127.0.0.1', '--port', String(appPort)],
        {
          cwd: session.hostWorkspace,
          env: {
            ...session.buildLaunchEnv(input.baseEnv ?? process.env),
            NODE_ENV: 'production',
            BLADE_ALLOW_ROOT: '1',
            PLAYWRIGHT_BROWSERS_PATH: browserCacheRoot(),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      child.stdout?.on('data', (chunk) => {
        output = boundedTail(output, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        output = boundedTail(output, chunk);
      });
      try {
        await waitForSessionSurfaceCondition(async () => {
          try {
            return (await fetch(`${origin}/health`)).ok;
          } catch {
            return false;
          }
        }, 'Session surface GUI server did not become ready');
        const returned = await callback({
          origin,
          session,
          localSession,
          getOutput: () => output,
        });
        if (returned !== undefined) {
          throw new Error('Session surface GUI callback cannot return a value');
        }
      } finally {
        await stopChild(child);
      }
      return undefined;
    });
    return {
      evidence: fixture.serializableEvidence,
      coordinates: fixture.serializableCoordinates,
    };
  } finally {
    await fixture.cleanup();
  }
}
