import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Browser, chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import {
  driveToolAdmissionFixture,
  TOOL_ADMISSION_CALL_IDS,
  waitForToolAdmissionSessionCompletion,
} from '../../support/toolAdmissionFixtureDriver.js';
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
const fairnessModel = models.find((model) => model.model === 'deepseek-v4-flash');
if (isRealApiTestEnabled() && matrix.length !== 8) {
  throw new Error(`Tool admission matrix must contain 8 cells, got ${matrix.length}`);
}
if (isRealApiTestEnabled() && !fairnessModel) {
  throw new Error('Tool admission fairness qualification requires DeepSeek Flash');
}

const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const childFixture = path.resolve(
  import.meta.dirname,
  '../../fixtures/run-real-api-tool-admission-child.ts'
);
const execFileAsync = promisify(execFile);
const MAX_CAPTURE_CHARS = 256_000;
const FAIRNESS_A_CALL_IDS = ['session-a-1', 'session-a-2', 'session-a-3'] as const;
const FAIRNESS_B_CALL_IDS = ['session-b-1'] as const;
const FAIRNESS_CALL_IDS = [...FAIRNESS_A_CALL_IDS, ...FAIRNESS_B_CALL_IDS] as const;

interface AdmissionFixture {
  stateDir: string;
  marker: string;
  prompt: string;
}

interface SurfaceEvidence {
  sessionId: string;
  output: string;
}

interface SessionEventProbe {
  events: Array<{
    type: string;
    properties: Record<string, unknown>;
  }>;
  close(): Promise<void>;
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

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
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

function createAdmissionPrompt(
  stateDir: string,
  callIds: readonly string[],
  marker: string
): string {
  const calls = callIds.map((callId) => {
    const command =
      `${shellQuote(process.execPath)} ${shellQuote(childFixture)} ` +
      `${shellQuote(stateDir)} ${shellQuote(callId)}`;
    return JSON.stringify({
      command,
      run_in_background: false,
      description: `Run bounded admission probe ${callId}`,
    });
  });
  const countName = ['zero', 'one', 'two', 'three', 'four'][callIds.length];
  if (!countName || callIds.length === 0) {
    throw new Error(`Unsupported admission fixture size: ${callIds.length}`);
  }
  return [
    callIds.length === 1
      ? 'Call Bash exactly once in ONE assistant response.'
      : `Call Bash exactly ${countName} times in ONE assistant response.`,
    'Each Bash call must use exactly one object below. Do not combine commands.',
    callIds.length === 1
      ? 'Use this exact call:'
      : `All ${countName} calls are independent and must be emitted together:`,
    ...calls.map((call, index) => `${index + 1}. ${call}`),
    `After ${callIds.length === 1 ? 'the call returns' : `all ${countName} calls return`}, reply exactly ${marker}.`,
    `Do not call any other tool and do not answer before ${
      callIds.length === 1 ? 'the result arrives' : `all ${countName} results arrive`
    }.`,
  ].join('\n');
}

function createAdmissionFixture(workspace: string, nonce: string): AdmissionFixture {
  const stateDir = path.join(workspace, 'tool-admission-state');
  const marker = `TOOL_ADMISSION_OK_${nonce}`;
  const prompt = createAdmissionPrompt(stateDir, TOOL_ADMISSION_CALL_IDS, marker);
  return { stateDir, marker, prompt };
}

async function writeRuntimeConfig(
  home: string,
  model: TestModelConfig
): Promise<RuntimeConfig> {
  const config = {
    ...buildRealApiRuntimeConfig(model),
    permissionMode: PermissionMode.YOLO,
  };
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
          permissionMode: PermissionMode.YOLO,
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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
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
  timeoutMs = 180_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Blade child did not exit after tool admission completed'));
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

async function releaseCalls(
  stateDir: string,
  callIds: readonly string[]
): Promise<void> {
  const releaseDir = path.join(stateDir, 'release');
  await mkdir(releaseDir, { recursive: true });
  await Promise.all(
    callIds.map((callId) => writeFile(path.join(releaseDir, callId), 'release'))
  );
}

async function releaseAll(stateDir: string): Promise<void> {
  await releaseCalls(stateDir, TOOL_ADMISSION_CALL_IDS);
}

async function directoryEntries(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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
    throw new Error(`Web Session SSE probe failed: ${response.status}`);
  }

  const events: SessionEventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readingError: unknown;
  const consume = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as {
      type?: unknown;
      properties?: unknown;
    };
    if (
      typeof event.type === 'string' &&
      event.properties !== null &&
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
    'Web Session SSE probe did not become ready',
    20_000
  );

  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
      if (readingError) {
        throw new Error('Web Session SSE probe failed while reading', {
          cause: readingError,
        });
      }
    },
  };
}

async function createWebSession(
  origin: string,
  projectPath: string,
  title: string
): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath, title }),
  });
  if (!response.ok) {
    throw new Error(`Web Session creation failed: ${response.status}`);
  }
  const created = (await response.json()) as { sessionId?: unknown };
  if (typeof created.sessionId !== 'string') {
    throw new Error('Web Session creation returned no ID');
  }
  return created.sessionId;
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

async function submitWebPrompt(
  page: Page,
  sessionId: string,
  prompt: string
): Promise<void> {
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.fill(prompt);
  const submission = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/sessions/${sessionId}/message`)
  );
  await composer.press('Enter');
  const submitted = await submission;
  if (!submitted.ok()) {
    throw new Error(`Web prompt submission failed: ${submitted.status()}`);
  }
}

async function waitForQueuedToolCards(
  page: Page,
  eventProbe: SessionEventProbe,
  expected: number
): Promise<void> {
  await waitFor(
    () =>
      eventProbe.events.filter(
        (event) =>
          event.type === 'tool.progress' &&
          event.properties.message === 'Waiting for tool execution capacity'
      ).length >= expected,
    `Web SSE did not publish ${expected} queued tool call(s)`
  );
  const toolGroup = page.locator('[data-agent-tool-group]').last();
  try {
    await toolGroup.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const groups = await page
      .locator('[data-agent-tool-group]')
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `Web GUI did not render queued progress; groups=${JSON.stringify(groups)} ` +
        `events=${JSON.stringify(eventProbe.events.map((event) => event.type))}`,
      { cause: error }
    );
  }
  const toggle = toolGroup.locator('button[aria-expanded]').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  const details = toolGroup.locator('[data-agent-tool-group-details]');
  await details.waitFor({ state: 'visible', timeout: 10_000 });
  await waitFor(
    async () =>
      (await details
        .getByText('Waiting for tool execution capacity', { exact: true })
        .count()) >= expected,
    `Web GUI did not render ${expected} queued tool card(s)`
  );
}

function bashPartCount(
  storageRoot: string,
  sessionId: string,
  partType: 'tool_call' | 'tool_result'
): number {
  return readSessionEvents(findSessionTranscript(storageRoot, sessionId)).filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === partType &&
      event.data.payload !== null &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload) &&
      event.data.payload.toolName === 'Bash'
  ).length;
}

function toolPartCallId(event: SessionEvent): string | undefined {
  if (
    event.type !== 'part_created' ||
    event.data.payload === null ||
    typeof event.data.payload !== 'object' ||
    Array.isArray(event.data.payload)
  ) {
    return undefined;
  }
  return typeof event.data.payload.toolCallId === 'string'
    ? event.data.payload.toolCallId
    : undefined;
}

async function waitForBashPartCount(
  storageRoot: string,
  sessionId: string,
  partType: 'tool_call' | 'tool_result',
  expected: number
): Promise<void> {
  await waitFor(
    () => bashPartCount(storageRoot, sessionId, partType) === expected,
    `Session ${sessionId} did not persist ${expected} Bash ${partType} part(s)`
  );
}

async function waitForBashSessionCompletion(
  storageRoot: string,
  sessionId: string,
  expectedResults: number
): Promise<void> {
  await waitFor(() => {
    const events = readSessionEvents(findSessionTranscript(storageRoot, sessionId));
    return (
      bashPartCount(storageRoot, sessionId, 'tool_result') === expectedResults &&
      events.filter((event) => event.type === 'turn_completed').length === 1
    );
  }, `Session ${sessionId} did not complete with ${expectedResults} Bash result(s)`);
}

async function reloadAndAssertMarker(page: Page, marker: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('textarea[data-blade-composer]').waitFor({
    state: 'visible',
  });
  await page.getByText(marker, { exact: true }).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

async function runWebFairnessSurface(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  secret: string;
}): Promise<void> {
  const stateDir = path.join(input.workspace, 'tool-admission-fairness-state');
  const nonce = Date.now();
  const markerA = `TOOL_ADMISSION_FAIR_A_${nonce}`;
  const markerB = `TOOL_ADMISSION_FAIR_B_${nonce}`;
  const promptA = createAdmissionPrompt(stateDir, FAIRNESS_A_CALL_IDS, markerA);
  const promptB = createAdmissionPrompt(stateDir, FAIRNESS_B_CALL_IDS, markerB);
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
  let probeA: SessionEventProbe | undefined;
  let probeB: SessionEventProbe | undefined;

  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`);
    const [sessionA, sessionB] = await Promise.all([
      createWebSession(origin, input.workspace, 'Tool fairness Session A'),
      createWebSession(origin, input.workspace, 'Tool fairness Session B'),
    ]);
    [probeA, probeB] = await Promise.all([
      openSessionEventProbe(origin, sessionA, input.workspace),
      openSessionEventProbe(origin, sessionB, input.workspace),
    ]);
    browser = await chromium.launch({ headless: true });
    const pageA = await openWebSessionPage(browser, origin, sessionA, input.workspace);
    const pageB = await openWebSessionPage(browser, origin, sessionB, input.workspace);

    await submitWebPrompt(pageA, sessionA, promptA);
    await waitForBashPartCount(input.storageRoot, sessionA, 'tool_call', 3);
    await waitForQueuedToolCards(pageA, probeA, 1);
    await waitFor(
      async () =>
        (await directoryEntries(path.join(stateDir, 'started'))).filter((callId) =>
          callId.startsWith('session-a-')
        ).length === 2,
      'Session A did not occupy exactly two execute slots'
    );
    const firstWaveA = (await directoryEntries(path.join(stateDir, 'started'))).filter(
      (callId) => callId.startsWith('session-a-')
    );
    expect(firstWaveA).toHaveLength(2);
    expect(await directoryEntries(path.join(stateDir, 'active'))).toEqual(
      [...firstWaveA].sort()
    );

    await submitWebPrompt(pageB, sessionB, promptB);
    await waitForBashPartCount(input.storageRoot, sessionB, 'tool_call', 1);
    await waitFor(
      async () =>
        (await directoryEntries(path.join(stateDir, 'started'))).includes(
          FAIRNESS_B_CALL_IDS[0]
        ),
      'Session B did not use the remaining global execute slot'
    );
    expect(await directoryEntries(path.join(stateDir, 'started'))).toEqual(
      [...firstWaveA, FAIRNESS_B_CALL_IDS[0]].sort()
    );
    expect(await directoryEntries(path.join(stateDir, 'active'))).toEqual(
      [...firstWaveA, FAIRNESS_B_CALL_IDS[0]].sort()
    );

    await releaseCalls(stateDir, FAIRNESS_B_CALL_IDS);
    await waitForBashSessionCompletion(input.storageRoot, sessionB, 1);
    await pageB.getByText(markerB, { exact: true }).waitFor({
      state: 'visible',
      timeout: 90_000,
    });
    expect(await directoryEntries(path.join(stateDir, 'started'))).toEqual(
      [...firstWaveA, FAIRNESS_B_CALL_IDS[0]].sort()
    );
    expect(await directoryEntries(path.join(stateDir, 'active'))).toEqual(
      [...firstWaveA].sort()
    );
    expect(bashPartCount(input.storageRoot, sessionA, 'tool_result')).toBe(0);
    expect(
      readSessionEvents(findSessionTranscript(input.storageRoot, sessionA)).filter(
        (event) => event.type === 'turn_completed'
      )
    ).toHaveLength(0);
    await reloadAndAssertMarker(pageB, markerB);

    await releaseCalls(stateDir, [firstWaveA[0]]);
    await waitFor(
      async () =>
        (await directoryEntries(path.join(stateDir, 'started'))).filter((callId) =>
          callId.startsWith('session-a-')
        ).length === 3,
      'Session A did not admit one successor after one permit was released'
    );
    const activeA = (await directoryEntries(path.join(stateDir, 'active'))).filter(
      (callId) => callId.startsWith('session-a-')
    );
    expect(activeA).toHaveLength(2);
    expect(activeA).not.toContain(firstWaveA[0]);

    await releaseCalls(stateDir, activeA);
    await waitForBashSessionCompletion(input.storageRoot, sessionA, 3);
    await pageA.getByText(markerA, { exact: true }).waitFor({
      state: 'visible',
      timeout: 90_000,
    });
    expect(await directoryEntries(path.join(stateDir, 'started'))).toEqual(
      [...FAIRNESS_CALL_IDS].sort()
    );
    expect(await directoryEntries(path.join(stateDir, 'completed'))).toEqual(
      [...FAIRNESS_CALL_IDS].sort()
    );
    expect(await directoryEntries(path.join(stateDir, 'active'))).toEqual([]);
    await reloadAndAssertMarker(pageA, markerA);

    const transcriptA = findSessionTranscript(input.storageRoot, sessionA);
    const transcriptB = findSessionTranscript(input.storageRoot, sessionB);
    expect(bashPartCount(input.storageRoot, sessionA, 'tool_call')).toBe(3);
    expect(bashPartCount(input.storageRoot, sessionA, 'tool_result')).toBe(3);
    expect(bashPartCount(input.storageRoot, sessionB, 'tool_call')).toBe(1);
    expect(bashPartCount(input.storageRoot, sessionB, 'tool_result')).toBe(1);
    await Promise.all([
      assertNoForegroundLeases(input.workspace, sessionA),
      assertNoForegroundLeases(input.workspace, sessionB),
    ]);
    expect(
      JSON.stringify({
        output,
        pageA: await pageA.content(),
        pageB: await pageB.content(),
        probeA: probeA.events,
        probeB: probeB.events,
        transcriptA: await readFile(transcriptA, 'utf8'),
        transcriptB: await readFile(transcriptB, 'utf8'),
      })
    ).not.toContain(input.secret);

    await Promise.all([probeA.close(), probeB.close()]);
    probeA = undefined;
    probeB = undefined;
    await browser.close();
    browser = undefined;
    child.kill('SIGTERM');
    const exit = await waitForChildExit(child, 30_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Web fairness exit was ${exit.code ?? exit.signal}: ${output.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
  } finally {
    await releaseCalls(stateDir, FAIRNESS_CALL_IDS).catch(() => undefined);
    await Promise.all([
      probeA?.close().catch(() => undefined),
      probeB?.close().catch(() => undefined),
    ]);
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 10_000).catch(() => undefined);
    }
  }
}

async function runHeadlessSurface(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  modelId: string;
  fixture: AdmissionFixture;
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
    await driveToolAdmissionFixture({
      storageRoot: input.storageRoot,
      sessionId: input.sessionId,
      stateDir: input.fixture.stateDir,
      waitForQueuedEvidence: () =>
        waitFor(
          () => countOccurrences(output, 'Waiting for tool execution capacity') >= 2,
          'Headless did not project two queued tool calls'
        ),
    });
    const exit = await waitForChildExit(child);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Headless admission exit was ${exit.code ?? exit.signal}: ${output
          .slice(-8_000)
          .replaceAll(input.secret, '[redacted]')}`
      );
    }
    await waitForToolAdmissionSessionCompletion(input.storageRoot, input.sessionId);
    if (!headlessContent(output).includes(input.fixture.marker)) {
      throw new Error('Headless did not return the final admission marker');
    }
    return { sessionId: input.sessionId, output };
  } finally {
    await releaseAll(input.fixture.stateDir).catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runBunSurface(
  kind: 'acp' | 'pty',
  input: {
    workspace: string;
    home: string;
    storageRoot: string;
    sessionId: string;
    fixture: AdmissionFixture;
    secret: string;
  }
): Promise<SurfaceEvidence> {
  const runner = path.resolve(
    import.meta.dirname,
    kind === 'acp'
      ? '../../support/toolAdmissionAcpRunner.ts'
      : '../../support/toolAdmissionPtyRunner.ts'
  );
  const variable =
    kind === 'acp'
      ? 'BLADE_TOOL_ADMISSION_ACP_INPUT'
      : 'BLADE_TOOL_ADMISSION_PTY_INPUT';
  const encoded = Buffer.from(
    JSON.stringify({
      cliEntry,
      workspace: input.workspace,
      home: input.home,
      storageRoot: input.storageRoot,
      stateDir: input.fixture.stateDir,
      sessionId: input.sessionId,
      prompt: input.fixture.prompt,
      marker: input.fixture.marker,
      secret: input.secret,
    }),
    'utf8'
  ).toString('base64');
  let stdout = '';
  try {
    const result = await execFileAsync('bun', [runner], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: { ...process.env, [variable]: encoded },
      timeout: 240_000,
      maxBuffer: 512 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = (error as Error & { stdout?: string }).stdout ?? stdout;
  }
  const evidence = JSON.parse(stdout) as SurfaceEvidence & {
    success?: unknown;
    error?: unknown;
  };
  if (
    evidence.success !== true ||
    typeof evidence.sessionId !== 'string' ||
    typeof evidence.output !== 'string'
  ) {
    throw new Error(
      `${kind.toUpperCase()} admission evidence is invalid: ${String(
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
  fixture: AdmissionFixture;
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
  let eventProbe: SessionEventProbe | undefined;
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`);
    const sessionId = await createWebSession(
      origin,
      input.workspace,
      'Tool admission qualification'
    );
    eventProbe = await openSessionEventProbe(origin, sessionId, input.workspace);
    browser = await chromium.launch({ headless: true });
    const page = await openWebSessionPage(browser, origin, sessionId, input.workspace);
    await submitWebPrompt(page, sessionId, input.fixture.prompt);

    await driveToolAdmissionFixture({
      storageRoot: input.storageRoot,
      sessionId,
      stateDir: input.fixture.stateDir,
      waitForQueuedEvidence: () => waitForQueuedToolCards(page, eventProbe!, 2),
    });
    await waitForToolAdmissionSessionCompletion(input.storageRoot, sessionId);
    await page.getByText(input.fixture.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 90_000,
    });
    if ((await page.content()).includes(input.secret)) {
      throw new Error('Web admission DOM contained provider credentials');
    }

    await eventProbe.close();
    eventProbe = undefined;
    await browser.close();
    browser = undefined;
    child.kill('SIGTERM');
    const exit = await waitForChildExit(child, 30_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Web admission exit was ${exit.code ?? exit.signal}: ${output.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    return { sessionId, output };
  } finally {
    await releaseAll(input.fixture.stateDir).catch(() => undefined);
    await eventProbe?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe
  .skipIf(!isRealApiTestEnabled() || process.platform === 'win32')
  .sequential('bounded fair tool admission matrix', () => {
    it.each(matrix)(
      '$model.model × $surface',
      async ({ model, surface }) => {
        const root = await mkdtemp(
          path.join(
            os.tmpdir(),
            `blade-tool-admission-${safeSlug(model.model)}-${surface}-`
          )
        );
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const workspacePath = path.join(root, 'workspace');
        await mkdir(workspacePath, { recursive: true });
        const workspace = await realpath(workspacePath);
        const sessionId = `tool-admission-${safeSlug(model.model)}-${surface}-${Date.now()}`;
        const fixture = createAdmissionFixture(
          workspace,
          `${safeSlug(model.model)}_${surface}_${Date.now()}`
        );
        const previousHome = process.env.HOME;
        const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
        const previousAutoMemory = process.env.BLADE_AUTO_MEMORY;
        try {
          await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            writeFile(path.join(workspace, 'README.md'), '# Tool admission\n'),
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
              : surface === 'acp'
                ? await runBunSurface('acp', {
                    workspace,
                    home,
                    storageRoot,
                    sessionId,
                    fixture,
                    secret: model.apiKey,
                  })
                : surface === 'pty'
                  ? await runBunSurface('pty', {
                      workspace,
                      home,
                      storageRoot,
                      sessionId,
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

          const transcript = findSessionTranscript(storageRoot, evidence.sessionId);
          const events = readSessionEvents(transcript);
          const bashCalls = events.filter(
            (event) =>
              event.type === 'part_created' &&
              event.data.partType === 'tool_call' &&
              event.data.payload !== null &&
              typeof event.data.payload === 'object' &&
              !Array.isArray(event.data.payload) &&
              event.data.payload.toolName === 'Bash'
          );
          const bashResults = events.filter(
            (event) =>
              event.type === 'part_created' &&
              event.data.partType === 'tool_result' &&
              event.data.payload !== null &&
              typeof event.data.payload === 'object' &&
              !Array.isArray(event.data.payload) &&
              event.data.payload.toolName === 'Bash'
          );
          expect(bashCalls).toHaveLength(4);
          expect(bashResults).toHaveLength(4);
          expect(bashResults.map(toolPartCallId)).toEqual(
            bashCalls.map(toolPartCallId)
          );
          expect(
            events.filter((event) => event.type === 'turn_completed')
          ).toHaveLength(1);
          expect(await readdir(path.join(fixture.stateDir, 'active'))).toEqual([]);
          await assertNoForegroundLeases(workspace, evidence.sessionId);
          expect(
            JSON.stringify({
              output: evidence.output,
              events,
              state: await readFile(transcript, 'utf8'),
            })
          ).not.toContain(model.apiKey);
          await expect(
            access(path.join(fixture.stateDir, 'unexpected'))
          ).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await releaseAll(fixture.stateDir).catch(() => undefined);
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
      },
      300_000
    );

    it('deepseek-v4-flash × web two-Session fairness', async () => {
      if (!fairnessModel) {
        throw new Error('DeepSeek Flash fairness model is unavailable');
      }
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'blade-tool-admission-web-fairness-')
      );
      const home = path.join(root, 'home');
      const storageRoot = path.join(root, 'storage');
      const workspacePath = path.join(root, 'workspace');
      await mkdir(workspacePath, { recursive: true });
      const workspace = await realpath(workspacePath);
      const previousHome = process.env.HOME;
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const previousAutoMemory = process.env.BLADE_AUTO_MEMORY;
      try {
        await Promise.all([
          mkdir(home, { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          writeFile(path.join(workspace, 'README.md'), '# Tool fairness\n'),
        ]);
        await writeRuntimeConfig(home, fairnessModel);
        process.env.HOME = home;
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        WorkspaceTrustService.resetInstance();
        await WorkspaceTrustService.getInstance().trust(workspace);

        await runWebFairnessSurface({
          workspace,
          home,
          storageRoot,
          secret: fairnessModel.apiKey,
        });
        await expect(
          access(path.join(workspace, 'tool-admission-fairness-state', 'unexpected'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
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
    }, 300_000);
  });
