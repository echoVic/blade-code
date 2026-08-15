import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Browser, chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { BackgroundShellLeaseStore } from '../../../src/tools/builtin/shell/BackgroundShellLeaseStore.js';
import {
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';
import {
  createForegroundCommandHandoffFixture,
  driveForegroundCommandHandoffFixture,
  type ForegroundCommandHandoffFixture,
  releaseForegroundCommandHandoffFixture,
} from '../../support/foregroundCommandHandoffFixtureDriver.js';
import { assertNoForegroundLeases } from './foregroundBoundedOutputHarness.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const surfaces = ['headless', 'acp', 'pty', 'web'] as const;
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
if (isRealApiTestEnabled() && matrix.length !== 8) {
  throw new Error(
    `Foreground command handoff matrix must contain 8 cells, got ${matrix.length}`
  );
}

const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const childFixture = path.resolve(
  import.meta.dirname,
  '../../fixtures/run-real-api-foreground-handoff-child.ts'
);
const acpRunner = path.resolve(
  import.meta.dirname,
  '../../support/foregroundCommandHandoffAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/foregroundCommandHandoffPtyRunner.ts'
);
const MAX_CAPTURE_CHARS = 256_000;

interface SurfaceEvidence {
  sessionId: string;
  output: string;
  processes?: Array<{ pid: number; identity: ProcessIdentity }>;
}

interface SessionEventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 120_000
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
      reject(new Error('Foreground handoff surface process did not exit'));
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
    throw new Error('Unable to reserve foreground handoff Web port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Foreground handoff\n');
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  return realpath(workspace);
}

async function writeRuntimeConfig(home: string, model: TestModelConfig): Promise<void> {
  const config = buildRealApiRuntimeConfig(model);
  const bladeHome = path.join(home, '.blade');
  const skillCreator = path.join(bladeHome, 'skills', 'skill-creator');
  await Promise.all([
    mkdir(bladeHome, { recursive: true }),
    mkdir(skillCreator, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(bladeHome, 'config.json'),
      `${JSON.stringify(
        {
          currentModelId: config.currentModelId,
          models: config.models,
          modelProviders: config.modelProviders,
          permissionMode: 'yolo',
          bashForegroundHandoffMs: 1_000,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    ),
    writeFile(
      path.join(skillCreator, 'SKILL.md'),
      [
        '---',
        'name: skill-creator',
        'description: Local deterministic qualification fixture.',
        '---',
        '',
        '# Fixture Skill Creator',
        '',
      ].join('\n')
    ),
  ]);
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

async function runHeadless(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  fixture: ForegroundCommandHandoffFixture;
  secret: string;
}): Promise<SurfaceEvidence> {
  const child = spawn(
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
      '6',
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Bash,Read,TaskOutput',
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
    try {
      await driveForegroundCommandHandoffFixture({
        storageRoot: input.storageRoot,
        sessionId: input.sessionId,
        fixture: input.fixture,
        waitForSurfaceHandoff: async (shellId) => {
          await waitFor(
            () =>
              output.includes(shellId) && output.includes('"auto_backgrounded":true'),
            'Headless JSONL did not project foreground handoff metadata'
          );
        },
      });
    } catch (error) {
      throw new Error(
        `${
          error instanceof Error ? error.message : String(error)
        }; headlessTail=${output.replaceAll(input.secret, '[redacted]').slice(-8_000)}`,
        { cause: error }
      );
    }
    const exit = await waitForChildExit(child, 180_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Headless handoff exited ${exit.code ?? exit.signal}: ${output.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    await waitFor(
      () => headlessContent(output).includes(input.fixture.marker),
      'Headless handoff marker was not rendered',
      5_000
    );
    return { sessionId: input.sessionId, output };
  } finally {
    await releaseForegroundCommandHandoffFixture(input.fixture).catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runSubprocessRunner(input: {
  runner: string;
  envName: 'BLADE_FOREGROUND_HANDOFF_ACP_INPUT' | 'BLADE_FOREGROUND_HANDOFF_PTY_INPUT';
  payload: Record<string, unknown>;
  timeoutMs: number;
}): Promise<SurfaceEvidence> {
  const encoded = Buffer.from(JSON.stringify(input.payload), 'utf8').toString('base64');
  const result = await execFileAsync('bun', [input.runner], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, [input.envName]: encoded },
    timeout: input.timeoutMs,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(result.stdout.trim()) as SurfaceEvidence & {
    success?: unknown;
    error?: unknown;
  };
  if (parsed.success !== true) {
    throw new Error(`Foreground handoff runner failed: ${String(parsed.error)}`);
  }
  return parsed;
}

async function waitForHttp(url: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    },
    `Timed out waiting for ${url}`,
    20_000
  );
}

async function createWebSession(origin: string, projectPath: string): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      title: 'Foreground command handoff',
    }),
  });
  if (!response.ok) {
    throw new Error(`Web handoff Session creation failed: ${response.status}`);
  }
  const created = (await response.json()) as { sessionId?: unknown };
  if (typeof created.sessionId !== 'string') {
    throw new Error('Web handoff Session creation returned no ID');
  }
  return created.sessionId;
}

async function openSessionEventProbe(
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<SessionEventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`Web handoff SSE probe failed: ${response.status}`);
  }
  const events: SessionEventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readingError: unknown;
  const consume = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as { type?: unknown; properties?: unknown };
    if (
      typeof event.type === 'string' &&
      event.properties &&
      typeof event.properties === 'object' &&
      !Array.isArray(event.properties)
    ) {
      events.push({
        type: event.type,
        properties: event.properties as Record<string, unknown>,
      });
    }
  };
  const reading = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) consume(frame);
      }
    } catch (error) {
      if (!controller.signal.aborted) readingError = error;
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Web handoff SSE probe did not connect',
    20_000
  );
  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
      if (readingError) {
        throw new Error('Web handoff SSE probe failed while reading', {
          cause: readingError,
        });
      }
    },
  };
}

async function openWebSessionPage(
  browser: Browser,
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<Page> {
  const page = await browser.newPage();
  const navigation = new URL(origin);
  navigation.searchParams.set('session', sessionId);
  navigation.searchParams.set('project', projectPath);
  await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
  await page.locator('textarea[data-blade-composer]').waitFor({
    state: 'visible',
  });
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
  return page;
}

async function expandToolGroups(page: Page): Promise<void> {
  const buttons = page.locator('[data-agent-tool-group] > button');
  const count = await buttons.count();
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    if ((await button.getAttribute('aria-expanded')) !== 'true') {
      await button.click();
    }
  }
}

async function runWeb(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  fixture: ForegroundCommandHandoffFixture;
  secret: string;
}): Promise<SurfaceEvidence> {
  const port = await reservePort();
  const child = spawn(
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
  let probe: SessionEventProbe | undefined;
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`);
    const sessionId = await createWebSession(origin, input.workspace);
    probe = await openSessionEventProbe(origin, sessionId, input.workspace);
    browser = await chromium.launch({ headless: true });
    const page = await openWebSessionPage(browser, origin, sessionId, input.workspace);
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.fill(input.fixture.prompt);
    const submission = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/sessions/${sessionId}/message`)
    );
    await composer.press('Enter');
    if (!(await submission).ok()) {
      throw new Error('Web handoff prompt submission failed');
    }

    await driveForegroundCommandHandoffFixture({
      storageRoot: input.storageRoot,
      sessionId,
      fixture: input.fixture,
      waitForSurfaceHandoff: async (shellId) => {
        await waitFor(
          () =>
            probe?.events.some(
              (event) =>
                event.type === 'tool.result' &&
                event.properties.toolName === 'Bash' &&
                event.properties.metadata !== null &&
                typeof event.properties.metadata === 'object' &&
                (event.properties.metadata as Record<string, unknown>)
                  .auto_backgrounded === true &&
                (event.properties.metadata as Record<string, unknown>).shell_id ===
                  shellId
            ) === true,
          'Web SSE did not project foreground handoff metadata'
        );
        await expandToolGroups(page);
        const card = page
          .locator('[data-tool-name="Bash"][data-tool-status="success"]')
          .last();
        await card.waitFor({ state: 'visible', timeout: 30_000 });
        const text = (await card.textContent()) ?? '';
        expect(text).toContain('still running in background');
        expect(text).toContain(shellId);
      },
    });
    await page.getByText(input.fixture.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 90_000,
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
    });
    await page.getByText(input.fixture.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const html = await page.content();
    assertNoSecrets({ output, html, events: probe.events }, [input.secret]);

    await probe.close();
    probe = undefined;
    await browser.close();
    browser = undefined;
    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Web handoff exited ${exit.code ?? exit.signal}: ${output.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    return { sessionId, output: `${output}\n${html}`.slice(-MAX_CAPTURE_CHARS) };
  } finally {
    await releaseForegroundCommandHandoffFixture(input.fixture).catch(() => undefined);
    await probe?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 10_000).catch(() => undefined);
    }
  }
}

async function assertNoBackgroundLeases(
  workspace: string,
  sessionId: string
): Promise<void> {
  const result = await new BackgroundShellLeaseStore(
    workspace,
    sessionId
  ).reapOrphans();
  expect(result).toEqual({
    reaped: 0,
    stale: 0,
    active: 0,
    protected: 0,
  });
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded foreground command handoff release matrix', () => {
    it.each(matrix)('$model.model × $surface', async ({ model, surface }) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `blade-handoff-${safeSlug(model.model)}-${surface}-`)
      );
      const home = path.join(root, 'home');
      const storage = path.join(root, 'storage');
      const workspaceInput = path.join(root, 'workspace');
      let fixture: ForegroundCommandHandoffFixture | undefined;
      let sessionId = `handoff-${safeSlug(model.model)}-${surface}-${Date.now()}`;
      try {
        await Promise.all([
          mkdir(home, { recursive: true }),
          mkdir(storage, { recursive: true }),
          mkdir(workspaceInput, { recursive: true }),
        ]);
        const workspace = await initializeWorkspace(workspaceInput);
        await writeRuntimeConfig(home, model);
        const nonce = `${safeSlug(model.model)}_${surface}_${Date.now()}`;
        fixture = await createForegroundCommandHandoffFixture(
          workspace,
          nonce,
          childFixture
        );

        let evidence: SurfaceEvidence;
        if (surface === 'headless') {
          evidence = await runHeadless({
            workspace,
            home,
            storageRoot: storage,
            sessionId,
            fixture,
            secret: model.apiKey,
          });
        } else if (surface === 'acp') {
          evidence = await runSubprocessRunner({
            runner: acpRunner,
            envName: 'BLADE_FOREGROUND_HANDOFF_ACP_INPUT',
            payload: {
              cliEntry,
              workspace,
              home,
              storageRoot: storage,
              fixture,
              secret: model.apiKey,
            },
            timeoutMs: 180_000,
          });
          sessionId = evidence.sessionId;
        } else if (surface === 'pty') {
          evidence = await runSubprocessRunner({
            runner: ptyRunner,
            envName: 'BLADE_FOREGROUND_HANDOFF_PTY_INPUT',
            payload: {
              cliEntry,
              workspace,
              home,
              storageRoot: storage,
              sessionId,
              fixture,
              secret: model.apiKey,
            },
            timeoutMs: 210_000,
          });
        } else {
          evidence = await runWeb({
            workspace,
            home,
            storageRoot: storage,
            fixture,
            secret: model.apiKey,
          });
          sessionId = evidence.sessionId;
        }

        const transcriptPath = findSessionTranscript(storage, sessionId);
        const events = readSessionEvents(transcriptPath);
        assertNoSecrets(
          {
            evidence,
            events,
            transcript: await readFile(transcriptPath, 'utf8'),
          },
          [model.apiKey]
        );
        for (const process of evidence.processes ?? []) {
          expect(processIdentityMatches(process.pid, process.identity)).toBe(false);
        }
        await Promise.all([
          assertNoForegroundLeases(workspace, sessionId),
          assertNoBackgroundLeases(workspace, sessionId),
        ]);
      } finally {
        if (fixture) {
          await releaseForegroundCommandHandoffFixture(fixture).catch(() => undefined);
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 240_000);
  });
