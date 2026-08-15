import { type ChildProcess, execFile, spawn as spawnChild } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Browser, chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { assertNoForegroundLeases } from './foregroundBoundedOutputHarness.js';
import {
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const surfaces = ['headless', 'acp', 'pty', 'web'] as const;
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
if (isRealApiTestEnabled() && matrix.length !== 8) {
  throw new Error(
    `Graceful shutdown matrix must contain 8 cells, got ${matrix.length}`
  );
}

const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const foregroundChildFixture = path.resolve(
  import.meta.dirname,
  '../../fixtures/run-real-api-foreground-child.ts'
);
const MAX_CAPTURE_CHARS = 64_000;
const execFileAsync = promisify(execFile);

interface ShutdownFixture {
  rootPidFile: string;
  forbiddenEffectFile: string;
  marker: string;
  prompt: string;
}

interface SurfaceEvidence {
  sessionId: string;
  output: string;
  rootPid: number;
  commandStartedAt: number;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_CAPTURE_CHARS);
}

function headlessContent(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.type === 'content_delta' && typeof event.delta === 'string'
          ? [event.delta]
          : [];
      } catch {
        return [];
      }
    })
    .join('');
}

function createShutdownFixture(workspace: string, nonce: string): ShutdownFixture {
  const rootPidFile = path.join(workspace, 'graceful-foreground-root.pid');
  const forbiddenEffectFile = path.join(workspace, 'graceful-forbidden-effect.txt');
  const releaseMarker = path.join(workspace, 'graceful-never-release');
  const marker = `GRACEFUL_SHUTDOWN_RESUME_OK_${nonce}`;
  const command =
    `${shellQuote(process.execPath)} ${shellQuote(foregroundChildFixture)} ` +
    `${shellQuote(rootPidFile)} ${shellQuote(forbiddenEffectFile)} </dev/null & ` +
    `while [ ! -f ${shellQuote(releaseMarker)} ]; do sleep 0.01; done`;
  const prompt = [
    `Only if the conversation history contains a <turn_aborted> marker for this exact request, do not call any tool and reply exactly ${marker}.`,
    'If there is no <turn_aborted> marker, you MUST call Bash exactly once using these exact arguments:',
    JSON.stringify({ command, run_in_background: false }),
    'Do not call another tool, do not alter either argument, and do not answer with plain text before Bash starts.',
  ].join('\n');
  return { rootPidFile, forbiddenEffectFile, marker, prompt };
}

async function writeRuntimeConfig(
  home: string,
  model: TestModelConfig
): Promise<RuntimeConfig> {
  const config = {
    ...buildRealApiRuntimeConfig(model),
    permissionMode: PermissionMode.YOLO,
  };
  await mkdir(path.join(home, '.blade'), { recursive: true });
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        permissionMode: PermissionMode.YOLO,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return config;
}

function childEnvironment(home: string, storageRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    BLADE_STORAGE_ROOT: storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  };
}

async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for shutdown fixture state', {
    cause: lastError,
  });
}

async function waitForRootPid(fixture: ShutdownFixture): Promise<number> {
  return waitForValue(async () => {
    const value = Number.parseInt(await readFile(fixture.rootPidFile, 'utf8'), 10);
    if (!Number.isSafeInteger(value) || value <= 1) return undefined;
    try {
      process.kill(value, 0);
      return value;
    } catch {
      return undefined;
    }
  });
}

async function waitForProcessGone(pid: number): Promise<void> {
  await waitForValue(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  }, 15_000);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Blade child did not exit after graceful shutdown'));
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

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve Web qualification port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHttp(url: string): Promise<void> {
  await waitForValue(async () => {
    try {
      const response = await fetch(url);
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, 20_000);
}

async function runHeadlessSurface(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  modelId: string;
  fixture: ShutdownFixture;
  secret: string;
}): Promise<SurfaceEvidence> {
  const child = spawnChild(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '4',
      '--model',
      input.modelId,
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
      input.fixture.prompt,
    ],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  try {
    const rootPid = await Promise.race([
      waitForRootPid(input.fixture),
      waitForChildExit(child, 90_000).then(({ code, signal }) => {
        throw new Error(`Headless exited before Bash started: ${code ?? signal}`);
      }),
    ]);
    const commandStartedAt = Date.now();
    child.kill('SIGTERM');
    let exit: Awaited<ReturnType<typeof waitForChildExit>>;
    try {
      exit = await waitForChildExit(child);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; output=${output
          .slice(-8_000)
          .replaceAll(input.secret, '[redacted]')
          .replaceAll('\u001B', '<ESC>')}`,
        { cause: error }
      );
    }
    if (exit.signal || (exit.code !== 1 && exit.code !== 130)) {
      throw new Error(
        `Headless graceful exit was ${exit.code ?? exit.signal}: ${output
          .slice(-4_000)
          .replaceAll(input.secret, '[redacted]')}`
      );
    }
    return { sessionId: input.sessionId, output, rootPid, commandStartedAt };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runPtySurface(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  fixture: ShutdownFixture;
  secret: string;
}): Promise<SurfaceEvidence> {
  const runner = path.resolve(
    import.meta.dirname,
    '../../support/gracefulShutdownPtyRunner.ts'
  );
  const encodedInput = Buffer.from(
    JSON.stringify({
      cliEntry,
      workspace: input.workspace,
      home: input.home,
      storageRoot: input.storageRoot,
      sessionId: input.sessionId,
      prompt: input.fixture.prompt,
      rootPidFile: input.fixture.rootPidFile,
      secret: input.secret,
    }),
    'utf8'
  ).toString('base64');
  let stdout = '';
  try {
    const result = await execFileAsync('bun', [runner], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        BLADE_GRACEFUL_PTY_INPUT: encodedInput,
      },
      timeout: 90_000,
      maxBuffer: 128 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
  } catch (error) {
    const failed = error as Error & { stdout?: string };
    stdout = failed.stdout ?? stdout;
  }
  const evidence = JSON.parse(stdout) as SurfaceEvidence & {
    success?: unknown;
    error?: unknown;
  };
  if (
    evidence.success !== true ||
    typeof evidence.output !== 'string' ||
    !Number.isSafeInteger(evidence.rootPid) ||
    !Number.isFinite(evidence.commandStartedAt)
  ) {
    throw new Error(
      `Raw PTY graceful shutdown evidence is invalid: ${String(
        evidence.error ?? evidence.output ?? 'unknown'
      )}`
    );
  }
  return evidence;
}

async function runAcpSurface(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  fixture: ShutdownFixture;
  secret: string;
}): Promise<SurfaceEvidence> {
  const runner = path.resolve(
    import.meta.dirname,
    '../../support/gracefulShutdownAcpRunner.ts'
  );
  const encodedInput = Buffer.from(
    JSON.stringify({
      cliEntry,
      workspace: input.workspace,
      home: input.home,
      storageRoot: input.storageRoot,
      prompt: input.fixture.prompt,
      rootPidFile: input.fixture.rootPidFile,
      secret: input.secret,
    }),
    'utf8'
  ).toString('base64');
  let stdout = '';
  try {
    const result = await execFileAsync('bun', [runner], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        BLADE_GRACEFUL_ACP_INPUT: encodedInput,
      },
      timeout: 120_000,
      maxBuffer: 256 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
  } catch (error) {
    const failed = error as Error & { stdout?: string };
    stdout = failed.stdout ?? stdout;
  }
  const evidence = JSON.parse(stdout) as SurfaceEvidence & {
    success?: unknown;
    error?: unknown;
  };
  if (
    evidence.success !== true ||
    typeof evidence.sessionId !== 'string' ||
    typeof evidence.output !== 'string' ||
    !Number.isSafeInteger(evidence.rootPid) ||
    !Number.isFinite(evidence.commandStartedAt)
  ) {
    throw new Error(
      `ACP graceful shutdown evidence is invalid: ${String(
        evidence.error ?? evidence.output ?? 'unknown'
      )}`
    );
  }
  return evidence;
}

async function runWebSurface(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  fixture: ShutdownFixture;
  secret: string;
}): Promise<SurfaceEvidence> {
  const port = await reservePort();
  const child = spawnChild(
    process.execPath,
    [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  let browser: Browser | undefined;
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`);
    const response = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: input.workspace,
        title: 'Graceful shutdown qualification',
      }),
    });
    if (!response.ok)
      throw new Error(`Web Session creation failed: ${response.status}`);
    const created = (await response.json()) as { sessionId?: unknown };
    if (typeof created.sessionId !== 'string') {
      throw new Error('Web Session creation returned no ID');
    }
    const sessionId = created.sessionId;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const navigation = new URL(origin);
    navigation.searchParams.set('session', sessionId);
    navigation.searchParams.set('project', input.workspace);
    await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible' });
    const permissionMode = page.locator('[data-blade-permission-mode]');
    await permissionMode.waitFor({ state: 'visible' });
    if ((await permissionMode.getAttribute('data-blade-permission-mode')) !== 'yolo') {
      await permissionMode.click();
      await page.locator('[data-blade-permission-option="yolo"]').click();
      await page.locator('[data-blade-yolo-confirm]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-blade-permission-mode]')
            ?.getAttribute('data-blade-permission-mode') === 'yolo'
      );
    }
    await composer.fill(input.fixture.prompt);
    const submission = page.waitForResponse(
      (browserResponse) =>
        browserResponse.request().method() === 'POST' &&
        browserResponse.url().includes(`/sessions/${sessionId}/message`)
    );
    await composer.press('Enter');
    const submitted = await submission;
    if (!submitted.ok()) {
      throw new Error(`Web prompt submission failed: ${submitted.status()}`);
    }
    const rootPid = await waitForRootPid(input.fixture);
    const commandStartedAt = Date.now();

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Web graceful exit was ${exit.code ?? exit.signal}: ${output.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    return { sessionId, output, rootPid, commandStartedAt };
  } finally {
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function resumeInterruptedTurn(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  modelId: string;
  secret: string;
}): Promise<{ exitCode: number; output: string }> {
  let output = '';
  const child = spawnChild(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '2',
      '--model',
      input.modelId,
      '--resume',
      input.sessionId,
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
    ],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  try {
    const exit = await waitForChildExit(child, 180_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Resume child exited with ${exit.code ?? exit.signal}: ${output
          .slice(-4_000)
          .replaceAll(input.secret, '[redacted]')}`
      );
    }
    return { exitCode: exit.code, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

describe
  .skipIf(!isRealApiTestEnabled() || process.platform === 'win32')
  .sequential('bounded coordinated graceful shutdown matrix', () => {
    it.each(matrix)('$model.model × $surface', async ({ model, surface }) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `blade-shutdown-${safeSlug(model.model)}-${surface}-`)
      );
      const home = path.join(root, 'home');
      const storageRoot = path.join(root, 'storage');
      const workspace = await realpath(
        await mkdir(path.join(root, 'workspace'), {
          recursive: true,
        }).then(() => path.join(root, 'workspace'))
      );
      const sessionId = `shutdown-${safeSlug(model.model)}-${surface}-${Date.now()}`;
      const fixture = createShutdownFixture(
        workspace,
        `${safeSlug(model.model)}_${surface}_${Date.now()}`
      );
      const previousHome = process.env.HOME;
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const previousAutoMemory = process.env.BLADE_AUTO_MEMORY;
      let rootPid: number | undefined;
      try {
        await Promise.all([
          mkdir(home, { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          writeFile(path.join(workspace, 'README.md'), '# Graceful shutdown\n'),
        ]);
        const runtimeConfig = await writeRuntimeConfig(home, model);
        process.env.HOME = home;
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        WorkspaceTrustService.resetInstance();
        await WorkspaceTrustService.getInstance().trust(workspace);

        const evidence =
          surface === 'headless'
            ? await runHeadlessSurface({
                workspace,
                home,
                storageRoot,
                sessionId,
                modelId: runtimeConfig.currentModelId,
                fixture,
                secret: model.apiKey,
              })
            : surface === 'pty'
              ? await runPtySurface({
                  workspace,
                  home,
                  storageRoot,
                  sessionId,
                  fixture,
                  secret: model.apiKey,
                })
              : surface === 'acp'
                ? await runAcpSurface({
                    workspace,
                    home,
                    storageRoot,
                    fixture,
                    secret: model.apiKey,
                  })
                : await runWebSurface({
                    workspace,
                    home,
                    storageRoot,
                    fixture,
                    secret: model.apiKey,
                  });
        rootPid = evidence.rootPid;

        await waitForProcessGone(evidence.rootPid);
        const remainingDelay = 5_500 - (Date.now() - evidence.commandStartedAt);
        if (remainingDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingDelay));
        }
        await expect(access(fixture.forbiddenEffectFile)).rejects.toMatchObject({
          code: 'ENOENT',
        });

        const transcriptPath = findSessionTranscript(storageRoot, evidence.sessionId);
        const interrupted = readSessionEvents(transcriptPath);
        expect(
          interrupted.filter((event) => event.type === 'turn_started')
        ).toHaveLength(1);
        expect(interrupted.filter((event) => event.type === 'turn_aborted')).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({ cause: 'cancelled' }),
          }),
        ]);
        expect(
          interrupted.filter((event) => event.type === 'turn_completed')
        ).toHaveLength(0);
        expect(
          interrupted.filter(
            (event) =>
              event.type === 'part_created' &&
              event.data.partType === 'tool_call' &&
              event.data.payload !== null &&
              typeof event.data.payload === 'object' &&
              !Array.isArray(event.data.payload) &&
              event.data.payload.toolName === 'Bash'
          )
        ).toHaveLength(1);
        await assertNoForegroundLeases(workspace, evidence.sessionId);

        const resumed = await resumeInterruptedTurn({
          workspace,
          home,
          storageRoot,
          sessionId: evidence.sessionId,
          modelId: runtimeConfig.currentModelId,
          secret: model.apiKey,
        });
        expect(
          resumed.exitCode,
          resumed.output.replaceAll(model.apiKey, '[redacted]')
        ).toBe(0);
        expect(headlessContent(resumed.output)).toContain(fixture.marker);

        const completed = readSessionEvents(transcriptPath);
        expect(completed.filter((event) => event.type === 'turn_aborted')).toHaveLength(
          1
        );
        expect(
          completed.filter((event) => event.type === 'turn_completed')
        ).toHaveLength(1);
        expect(
          completed.filter(
            (event) =>
              event.type === 'part_created' &&
              event.data.partType === 'tool_call' &&
              event.data.payload !== null &&
              typeof event.data.payload === 'object' &&
              !Array.isArray(event.data.payload) &&
              event.data.payload.toolName === 'Bash'
          )
        ).toHaveLength(1);
        expect(
          JSON.stringify({
            surfaceOutput: evidence.output,
            resumedOutput: resumed.output,
            events: completed,
          })
        ).not.toContain(model.apiKey);
      } finally {
        if (rootPid) {
          try {
            process.kill(-rootPid, 'SIGKILL');
          } catch {
            try {
              process.kill(rootPid, 'SIGKILL');
            } catch {
              // The graceful path already reclaimed the process.
            }
          }
        }
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousStorageRoot === undefined) {
          delete process.env.BLADE_STORAGE_ROOT;
        } else {
          process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        }
        if (previousAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = previousAutoMemory;
        WorkspaceTrustService.resetInstance();
        await rm(root, { recursive: true, force: true });
      }
    }, 360_000);
  });
