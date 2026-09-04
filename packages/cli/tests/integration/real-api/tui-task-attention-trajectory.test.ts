import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { CreateTaskResponseSchema, SessionSchema } from '../../../src/api/schemas.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
import { SessionService } from '../../../src/services/SessionService.js';
import type { ProcessIdentity } from '../../../src/utils/process/ProcessIdentity.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import {
  createTuiTaskAttentionStreamCapture,
  runTuiTaskAttentionPtyDriver,
} from '../../support/tuiTaskAttentionPtyDriver.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const enabled = isRealApiTestEnabled();
const models = enabled ? resolveRequiredDeepSeekQualificationModels() : [];
if (enabled && process.env.REAL_API_RELEASE_MATRIX !== '1') {
  throw new Error(
    'TUI task attention qualification requires REAL_API_RELEASE_MATRIX=1'
  );
}

interface TestServer {
  origin: string;
  child: ChildProcess;
  identity: ProcessIdentity;
  output(): string;
  leakedSecretLabels(): string[];
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, '[REDACTED]') : result),
    value
  );
}

function frameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve TUI attention server port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function serverExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForServerExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (serverExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function signalDetachedServer(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  child.kill(signal);
}

async function stopStartedServer(
  child: ChildProcess,
  identity?: ProcessIdentity
): Promise<void> {
  if (identity) {
    await stopForegroundGuiLauncher(child, identity);
    return;
  }
  if (serverExited(child)) return;
  signalDetachedServer(child, 'SIGTERM');
  if (await waitForServerExit(child, 5_000)) return;
  signalDetachedServer(child, 'SIGKILL');
  if (!(await waitForServerExit(child, 5_000))) {
    throw new Error('Unidentified production Blade server remained after SIGKILL');
  }
}

async function startProductionServer(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  secrets: readonly string[];
  captureIdentity?: typeof captureForegroundGuiLauncherIdentity;
}): Promise<TestServer> {
  const port = await reservePort();
  const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
  const child = spawn(
    process.execPath,
    [cliEntry, '--trust-workspace', 'serve', '--port', String(port)],
    {
      cwd: input.workspace,
      detached: true,
      env: {
        ...process.env,
        HOME: input.home,
        BLADE_STORAGE_ROOT: input.storageRoot,
        BLADE_VERSION: '999.0.0',
        BLADE_AUTO_MEMORY: '0',
        BLADE_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const capture = createTuiTaskAttentionStreamCapture(input.secrets, 16_384);
  child.stdout?.on('data', (chunk: Buffer | string) => {
    capture.append(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    capture.append(chunk);
  });
  let identity: ProcessIdentity | undefined;
  try {
    if (!child.pid) throw new Error('Production Blade server has no PID');
    identity = await (input.captureIdentity ?? captureForegroundGuiLauncherIdentity)(
      child.pid
    );
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) {
          const leakedSecrets = capture.leakedSecretLabels();
          if (leakedSecrets.length > 0) {
            throw new Error(
              `Production Blade server output contains credentials: ${leakedSecrets.join(', ')}`
            );
          }
          return {
            origin,
            child,
            identity,
            output: capture.output,
            leakedSecretLabels: capture.leakedSecretLabels,
          };
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('credentials')) {
          throw error;
        }
        // The production server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Production Blade server did not start: ${redact(
        capture.output().slice(-2_000),
        input.secrets
      )}`
    );
  } catch (error) {
    let cleanupError: unknown;
    try {
      await stopStartedServer(child, identity);
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Production Blade server startup and cleanup failed'
      );
    }
    throw error;
  }
}

async function waitForTerminal(
  origin: string,
  sessionId: string,
  workspace: string,
  timeoutMs: number
): Promise<ReturnType<typeof SessionSchema.parse>> {
  const url = new URL(`/sessions/${encodeURIComponent(sessionId)}`, origin);
  url.searchParams.set('projectPath', workspace);
  const deadline = Date.now() + timeoutMs;
  let status = 'unknown';
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.ok) {
      const session = SessionSchema.parse(await response.json());
      status = session.taskStatus;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
        return session;
      }
    } else {
      status = `http-${response.status}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal task status (${status})`);
}

function serverFaults(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /\b(error|panic|fatal)\b/i.test(line))
    .slice(-20);
}

const describeTrajectory =
  enabled && process.platform !== 'win32' ? describe.sequential : describe.skip;

describeTrajectory('TUI durable task attention raw PTY trajectory (real API)', () => {
  it.skipIf(enabled)('requires the real API release matrix', () => undefined);

  for (const model of models) {
    it(`${model.model} surfaces one missed terminal task exactly once`, async (context) => {
      const retry = frameworkRetryBudget(context);
      expect(retry).toBe(0);
      if (!model.baseURL)
        throw new Error(`Missing Provider base URL for ${model.model}`);
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-attention-real-'));
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      const proxy = await startRecordingProviderProxy(model.baseURL, {
        holdRequestNumber: 1,
        holdMs: 240_000,
      });
      let server: TestServer | undefined;
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      let primaryError: unknown;
      let cleanupError: unknown;
      try {
        await Promise.all([
          mkdir(workspace, { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          mkdir(path.join(home, '.blade'), { recursive: true }),
        ]);
        await writeFile(path.join(workspace, 'README.md'), '# TUI attention\n');
        const runtime = buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseUrl });
        const baseConfigured = runtime.models[0];
        if (!baseConfigured) throw new Error('Real API runtime model is missing');
        const configured = {
          ...baseConfigured,
          overrides: { ...baseConfigured.overrides, maxRetries: 0 },
        };
        expect(configured.overrides?.maxRetries).toBe(0);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              currentModelId: runtime.currentModelId,
              models: [configured],
              modelProviders: runtime.modelProviders,
              permissionMode: PermissionMode.YOLO,
              maxTurns: 2,
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        resetProjectionDbCache();
        const startedServer = await startProductionServer({
          workspace,
          storageRoot,
          home,
          secrets: [model.apiKey],
        });
        server = startedServer;
        const marker = `TUI_ATTENTION_${model.model
          .toUpperCase()
          .replaceAll(/[^A-Z0-9]+/g, '_')}_${Date.now()}`;
        const title = `TUI attention ${model.model}`;
        const response = await fetch(`${startedServer.origin}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: `Do not use tools. Reply with exactly ${marker}`,
            title,
            projectPath: workspace,
            modelId: runtime.currentModelId,
            isolation: 'local',
            permissionMode: 'yolo',
          }),
        });
        expect(response.status).toBe(202);
        const accepted = CreateTaskResponseSchema.parse(await response.json());
        expect(accepted.status).toBe('running');
        const statusSequence: string[] = [accepted.status];

        const evidence = await runTuiTaskAttentionPtyDriver({
          workspace,
          storageRoot,
          home,
          sessionId: accepted.session.sessionId,
          title,
          terminalContent: marker,
          secrets: [model.apiKey],
          completionTimeoutMs: 190_000,
          timeoutMs: 300_000,
          completeTask: async () => {
            proxy.releaseHeld();
            const terminal = await waitForTerminal(
              startedServer.origin,
              accepted.session.sessionId,
              workspace,
              180_000
            );
            if (terminal.taskStatus !== 'completed') {
              throw new Error(`Real TUI attention task ended ${terminal.taskStatus}`);
            }
            statusSequence.push(terminal.taskStatus);
            expect(terminal.taskCompletedAt).toEqual(expect.any(String));
            const messages = await SessionService.loadSession(
              accepted.session.sessionId,
              workspace
            );
            const assistant = messages.findLast(
              (message) => message.role === 'assistant'
            );
            const terminalText =
              typeof assistant?.content === 'string'
                ? assistant.content
                : (assistant?.content ?? [])
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('');
            expect(terminalText.trim()).toBe(marker);
          },
        });

        expect(models.map((candidate) => candidate.model)).toEqual([
          'deepseek-v4-flash',
          'deepseek-v4-pro',
        ]);
        expect(proxy.forwardedRequestNumbers).toEqual([1]);
        expect(proxy.injectedRequestNumbers).toEqual([]);
        expect(proxy.requestLifecycle).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ requestNumber: 1, phase: 'upstream_started' }),
            expect.objectContaining({ requestNumber: 1, phase: 'headers_received' }),
            expect.objectContaining({ requestNumber: 1, phase: 'body_completed' }),
          ])
        );
        expect(evidence).toMatchObject({
          baselinePersisted: true,
          firstMarkerAbsent: true,
          newMarkerSeen: true,
          exactSessionSelected: true,
          terminalContentSeen: true,
          markerCleared: true,
          faults: [],
          leakedSecrets: [],
        });
        const serverOutput = startedServer.output();
        const faults = serverFaults(serverOutput);
        const leakedSecrets = startedServer.leakedSecretLabels();
        expect(faults).toEqual([]);
        expect(leakedSecrets).toEqual([]);
        expect(evidence.output.length).toBeLessThanOrEqual(12_000);
        expect(statusSequence).toEqual(['running', 'completed']);
        assertNoSecrets(
          {
            evidence,
            faults,
            leakedSecrets,
            requestCount: proxy.forwardedRequestNumbers.length,
            injectionCount: proxy.injectedRequestNumbers.length,
            frameworkRetries: retry,
            modelMaxRetries: configured.overrides?.maxRetries,
            statusSequence,
          },
          [model.apiKey]
        );
      } catch (error) {
        primaryError = error;
      } finally {
        proxy.releaseHeld();
        try {
          if (server) await stopStartedServer(server.child, server.identity);
        } catch (error) {
          cleanupError = error;
        }
        try {
          await proxy.close();
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError(
                [cleanupError, error],
                'TUI task attention cleanup failed'
              )
            : error;
        }
        resetProjectionDbCache();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        await rm(root, { recursive: true, force: true });
      }
      if (primaryError && cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'TUI task attention trajectory and cleanup failed'
        );
      }
      if (primaryError) throw primaryError;
      if (cleanupError) throw cleanupError;
    }, 360_000);
  }
});
