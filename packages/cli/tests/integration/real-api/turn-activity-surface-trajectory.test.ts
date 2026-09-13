import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it, type TestContext, vi } from 'vitest';
import { SessionSchema } from '../../../src/api/schemas.js';
import { TurnActivityProjectionSchema } from '../../../src/api/turnActivitySchemas.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import {
  type RecordingProviderProxy,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
import { createTuiTaskAttentionRunnerEnvironment } from '../../support/tuiTaskAttentionPtyDriver.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  inspectFinalAssistantText,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const enabled = isRealApiTestEnabled();
const models = enabled ? resolveRequiredDeepSeekQualificationModels() : [];
const surfaces = ['headless', 'acp', 'pty', 'web'] as const;
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../../support/turnActivityAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/turnActivityPtyRunner.ts'
);
const describeTrajectory =
  enabled && process.platform !== 'win32' ? describe.sequential : describe.skip;

interface ActivityEvidence {
  sessionId: string;
  phases: string[];
  generationCount: number;
  sawBash: boolean;
  terminalClearSeen: boolean;
  output?: string;
  success?: boolean;
}

interface SessionEventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

function frameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

function childEnvironment(
  home: string,
  storageRoot: string,
  secret: string
): NodeJS.ProcessEnv {
  return {
    ...createTuiTaskAttentionRunnerEnvironment(process.env, {
      HOME: home,
      BLADE_STORAGE_ROOT: storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    }),
    BLADE_API_KEY: secret,
  };
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
      reject(new Error('Turn activity child did not exit'));
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

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Unable to reserve port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function openEventProbe(
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<SessionEventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error('Turn activity SSE unavailable');
  const events: SessionEventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const reading = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
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
        }
      }
    } catch {
      // Aborting the probe closes the reader.
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Turn activity SSE did not connect',
    20_000
  );
  return {
    events,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
    },
  };
}

function activityEvidence(
  values: readonly unknown[],
  sessionId: string
): ActivityEvidence {
  const projections = values.flatMap((value) => {
    const parsed = TurnActivityProjectionSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    sessionId,
    phases: projections.map((activity) => activity.snapshot?.phase ?? 'clear'),
    generationCount: new Set(projections.map((activity) => activity.generation)).size,
    sawBash: projections.some(
      (activity) =>
        activity.snapshot?.phase === 'executing_tools' &&
        activity.snapshot.activeTools.some((tool) => tool.name === 'Bash')
    ),
    terminalClearSeen: projections.at(-1)?.snapshot === null,
  };
}

async function collectWebActivityEvidence(
  probes: readonly SessionEventProbe[],
  sessionId: string
): Promise<ActivityEvidence> {
  await waitFor(
    () =>
      probes.every((probe) => {
        const event = probe.events.findLast((entry) => entry.type === 'turn.activity');
        const parsed = TurnActivityProjectionSchema.safeParse(
          event?.properties.activity
        );
        return parsed.success && parsed.data.snapshot === null;
      }),
    'Web SSE readers did not observe terminal activity clear',
    20_000
  );
  const values = probes.flatMap((probe) =>
    probe.events
      .filter((event) => event.type === 'turn.activity')
      .map((event) => event.properties.activity)
  );
  return activityEvidence(values, sessionId);
}

async function writeRuntimeConfig(
  home: string,
  model: TestModelConfig,
  baseURL: string
): Promise<void> {
  const runtime = buildRealApiRuntimeConfig({ ...model, baseURL });
  const configured = runtime.models[0];
  if (!configured) throw new Error('Turn activity model configuration is absent');
  await mkdir(path.join(home, '.blade'), { recursive: true });
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: runtime.currentModelId,
        models: [
          {
            ...configured,
            overrides: { ...configured.overrides, maxRetries: 0 },
          },
        ],
        modelProviders: runtime.modelProviders,
        permissionMode: 'yolo',
        maxTurns: 4,
        allowedTools: ['Bash'],
        disallowedTools: [],
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

function parseHeadless(stdout: string, sessionId: string): ActivityEvidence {
  const events = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const projections: unknown[] = [];
  for (const event of events) {
    if (event.type !== 'turn_activity') continue;
    if (event.snapshot === null) {
      projections.push({
        version: 1,
        generation: event.generation,
        revision: event.revision,
        snapshot: null,
      });
      continue;
    }
    const snapshot = event.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    const activeTools = Reflect.get(snapshot, 'active_tools');
    projections.push({
      version: 1,
      generation: event.generation,
      revision: event.revision,
      snapshot: {
        phase: Reflect.get(snapshot, 'phase'),
        startedAt: Reflect.get(snapshot, 'started_at'),
        updatedAt: Reflect.get(snapshot, 'updated_at'),
        turn: Reflect.get(snapshot, 'turn'),
        maxTurns: Reflect.get(snapshot, 'max_turns'),
        outputStarted: Reflect.get(snapshot, 'output_started'),
        toolCallsStarted: Reflect.get(snapshot, 'tool_calls_started'),
        toolCallsCompleted: Reflect.get(snapshot, 'tool_calls_completed'),
        activeTools: Array.isArray(activeTools)
          ? activeTools.map((tool: unknown) => {
              if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
                return tool;
              }
              const kind = Reflect.get(tool, 'kind');
              const progress = Reflect.get(tool, 'progress');
              const total = Reflect.get(tool, 'total');
              return {
                name: Reflect.get(tool, 'name'),
                ...(typeof kind === 'string' ? { kind } : {}),
                startedAt: Reflect.get(tool, 'started_at'),
                ...(progress !== undefined && total !== undefined
                  ? { progress, total }
                  : {}),
              };
            })
          : [],
        activeToolOverflow: Reflect.get(snapshot, 'active_tool_overflow'),
      },
    });
  }
  return { ...activityEvidence(projections, sessionId), output: stdout };
}

function headlessContent(stdout: string): string {
  return stdout
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

function createTurnActivityPrompt(command: string, marker: string): string {
  const midpoint = Math.ceil(marker.length / 2);
  return [
    'You must call Bash exactly once before writing any response text.',
    `Use this exact command without modification: ${command}`,
    'Wait until Bash finishes. Do not call any other tool.',
    'After Bash returns, your entire final response must be PART_A immediately ' +
      'followed by PART_B, with no labels, spaces, markdown, or newline.',
    `PART_A=${marker.slice(0, midpoint)}`,
    `PART_B=${marker.slice(midpoint)}`,
  ].join('\n');
}

async function runHeadless(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  secret: string;
  releaseFile: string;
}): Promise<ActivityEvidence> {
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
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
      input.prompt,
    ],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot, input.secret),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-512_000);
    if (
      stdout.includes('"phase":"executing_tools"') &&
      stdout.includes('"name":"Bash"')
    ) {
      void writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    }
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-128_000);
  });
  try {
    const exit = await waitForChildExit(child, 240_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Turn activity Headless exited ${exit.code ?? exit.signal}: ${stderr.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    expect(headlessContent(stdout)).toBe(input.marker);
    return parseHeadless(stdout, input.sessionId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runRunner(input: {
  runner: string;
  envName: 'BLADE_TURN_ACTIVITY_ACP_INPUT' | 'BLADE_TURN_ACTIVITY_PTY_INPUT';
  payload: Record<string, unknown>;
}): Promise<ActivityEvidence> {
  const encoded = Buffer.from(JSON.stringify(input.payload), 'utf8').toString('base64');
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('bun', [input.runner], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: createTuiTaskAttentionRunnerEnvironment(process.env, {
        [input.envName]: encoded,
      }),
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    stdout = failed.stdout ?? stdout;
    stderr = failed.stderr ?? stderr;
  }
  let parsed: ActivityEvidence & { error?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch (error) {
    throw new Error(
      `Turn activity runner emitted invalid JSON: ${stderr.slice(-8_000)}`,
      {
        cause: error,
      }
    );
  }
  if (parsed.success !== true) {
    throw new Error(`Turn activity surface runner failed: ${String(parsed.error)}`);
  }
  return parsed;
}

async function runWeb(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  marker: string;
  secret: string;
  releaseFile: string;
}): Promise<ActivityEvidence> {
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot, input.secret),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-256_000);
  });
  child.stderr?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-256_000);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let probe: SessionEventProbe | undefined;
  let reconnectProbe: SessionEventProbe | undefined;
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          return (await fetch(`${origin}/health`)).ok;
        } catch {
          return false;
        }
      },
      'Turn activity Web server did not become ready',
      20_000
    );
    const createdResponse = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: input.workspace, title: 'Turn activity' }),
    });
    const created = SessionSchema.parse(await createdResponse.json());
    probe = await openEventProbe(origin, created.sessionId, input.workspace);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const faults: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(message.text());
    });
    page.on('pageerror', (error) => faults.push(error.message));
    const url = new URL(origin);
    url.searchParams.set('session', created.sessionId);
    url.searchParams.set('project', input.workspace);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
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
    await composer.fill(input.prompt);
    await page.locator('[data-blade-submit]').click();
    await waitFor(
      () =>
        probe?.events.some(
          (event) =>
            event.type === 'turn.activity' &&
            JSON.stringify(event.properties.activity).includes('executing_tools') &&
            JSON.stringify(event.properties.activity).includes('Bash')
        ) === true,
      'Web SSE did not project active Bash',
      180_000
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-turn-activity-strip]')
          ?.textContent?.includes('Bash') === true,
      undefined,
      { timeout: 20_000 }
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-turn-activity-strip]')
          ?.textContent?.includes('Bash') === true,
      undefined,
      { timeout: 20_000 }
    );
    reconnectProbe = await openEventProbe(origin, created.sessionId, input.workspace);
    expect(reconnectProbe.events[0]).toMatchObject({
      type: 'connected',
      properties: {
        turnActivity: expect.objectContaining({
          snapshot: expect.objectContaining({ phase: 'executing_tools' }),
        }),
      },
    });
    await writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    await page.getByText(input.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 180_000,
    });
    await page
      .locator('[data-turn-activity-strip]')
      .waitFor({ state: 'detached', timeout: 20_000 });
    expect(faults).toEqual([]);
    const evidence = await collectWebActivityEvidence(
      [probe, reconnectProbe],
      created.sessionId
    );
    evidence.output = `${output}\n${await page.content()}`;
    return evidence;
  } finally {
    await probe?.close().catch(() => undefined);
    await reconnectProbe?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForChildExit(child, 10_000).catch(() => child.kill('SIGKILL'));
    }
  }
}

function toolCallNames(events: ReturnType<typeof readSessionEvents>): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'part_created' || event.data.partType !== 'tool_call') return [];
    const payload = event.data.payload;
    return payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof payload.toolName === 'string'
      ? [payload.toolName]
      : [];
  });
}

function summarizeTurnActivityRequests(requestBodies: readonly string[]) {
  return requestBodies.map((body, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const messages =
      parsed &&
      typeof parsed === 'object' &&
      'messages' in parsed &&
      Array.isArray(parsed.messages)
        ? parsed.messages
        : [];
    const firstIndex = requestBodies.indexOf(body);
    return {
      requestNumber: index + 1,
      duplicateOf: firstIndex < index ? firstIndex + 1 : null,
      messages: messages.slice(-16).map((message: unknown) => {
        const role =
          message && typeof message === 'object' && 'role' in message
            ? message.role
            : undefined;
        const content =
          message && typeof message === 'object' && 'content' in message
            ? message.content
            : undefined;
        const calls =
          message && typeof message === 'object' && 'tool_calls' in message
            ? message.tool_calls
            : undefined;
        return {
          role:
            typeof role === 'string' &&
            ['system', 'user', 'assistant', 'tool'].includes(role)
              ? role
              : 'unknown',
          contentChars: typeof content === 'string' ? content.length : 0,
          toolCalls: Array.isArray(calls) ? calls.length : 0,
          emptyFinalCorrection:
            typeof content === 'string' &&
            content.includes(
              'The previous response was empty after successful tool execution.'
            ),
        };
      }),
    };
  });
}

type TurnActivityProviderEvidence = Pick<
  RecordingProviderProxy,
  'requestBodies' | 'forwardedRequestNumbers' | 'responseSummaries' | 'requestLifecycle'
>;

const EMPTY_FINAL_CORRECTION_TEXT =
  'The previous response was empty after successful tool execution. ' +
  "Return a non-empty final response that directly completes the user's request. " +
  'Do not call tools unless unfinished work requires another tool action.';

function assertTurnActivityProviderTrajectory(
  proxy: TurnActivityProviderEvidence,
  events: readonly SessionEvent[]
): void {
  const responses = [...proxy.responseSummaries].sort(
    (left, right) => left.requestNumber - right.requestNumber
  );
  const diagnostic = JSON.stringify({
    requests: summarizeTurnActivityRequests(proxy.requestBodies),
    responses,
    lifecycle: proxy.requestLifecycle.map(({ requestNumber, phase, statusClass }) => ({
      requestNumber,
      phase,
      statusClass,
    })),
  });
  const count = proxy.requestBodies.length;
  expect(count === 2 || count === 3, diagnostic).toBe(true);
  expect(proxy.forwardedRequestNumbers, diagnostic).toEqual(
    Array.from({ length: count }, (_, index) => index + 1)
  );
  expect(new Set(proxy.requestBodies).size, diagnostic).toBe(count);
  expect(responses, diagnostic).toHaveLength(count);
  for (const [index, response] of responses.entries()) {
    expect(response, diagnostic).toMatchObject({
      requestNumber: index + 1,
      finishReasons: [index === 0 ? 'tool_calls' : 'stop'],
      done: true,
      parseStatus: 'complete',
      ...(index === 0 ? {} : { toolCallDeltas: 0 }),
    });
    expect(
      proxy.requestLifecycle.filter(
        (entry) =>
          entry.requestNumber === index + 1 &&
          ['headers_received', 'body_completed', 'downstream_ended', 'failed'].includes(
            entry.phase
          )
      ),
      diagnostic
    ).toEqual([
      { requestNumber: index + 1, phase: 'headers_received', statusClass: 2 },
      { requestNumber: index + 1, phase: 'body_completed' },
      { requestNumber: index + 1, phase: 'downstream_ended' },
    ]);
  }
  expect(responses[0]!.toolCallDeltas, diagnostic).toBeGreaterThan(0);
  expect(responses.at(-1)!.contentChars, diagnostic).toBeGreaterThan(0);

  const messages = proxy.requestBodies.map((body) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Invalid Provider request evidence');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('messages' in parsed) ||
      !Array.isArray(parsed.messages) ||
      !parsed.messages.every(
        (message: unknown) =>
          message && typeof message === 'object' && !Array.isArray(message)
      )
    ) {
      throw new Error('Invalid Provider message evidence');
    }
    return parsed.messages as Record<string, unknown>[];
  });
  const initial = messages[0]!;
  const afterTool = messages[1]!;
  expect(afterTool.length, diagnostic).toBe(initial.length + 2);
  expect(
    JSON.stringify(afterTool.slice(0, initial.length)) === JSON.stringify(initial),
    diagnostic
  ).toBe(true);
  const assistant = afterTool.at(-2)!;
  const result = afterTool.at(-1)!;
  expect(assistant.role === 'assistant' && result.role === 'tool', diagnostic).toBe(
    true
  );
  const calls = assistant.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) {
    throw new Error('Expected one native tool call in Provider evidence');
  }
  const call: unknown = calls[0];
  if (
    !call ||
    typeof call !== 'object' ||
    !('id' in call) ||
    typeof call.id !== 'string' ||
    !('function' in call) ||
    !call.function ||
    typeof call.function !== 'object' ||
    !('name' in call.function) ||
    call.function.name !== 'Bash'
  ) {
    throw new Error('Expected a native Bash call in Provider evidence');
  }
  expect(result.tool_call_id === call.id, diagnostic).toBe(true);
  const results = events.filter(
    (event) => event.type === 'part_created' && event.data.partType === 'tool_result'
  );
  expect(results.length, diagnostic).toBe(1);
  const toolResult = results[0]!;
  if (toolResult.type !== 'part_created')
    throw new Error('Missing durable tool result');
  const payload = toolResult.data.payload;
  expect(
    Boolean(
      payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        payload.toolCallId === call.id &&
        payload.toolName === 'Bash' &&
        payload.error === null
    ),
    diagnostic
  ).toBe(true);
  const completions = events.filter((event) => event.type === 'turn_completed');
  expect(completions.length, diagnostic).toBe(1);
  expect(completions[0]!.data, diagnostic).toMatchObject({
    turnsCount: count,
    toolCallsCount: 1,
  });
  expect(
    events.some((event) => event.type === 'turn_aborted'),
    diagnostic
  ).toBe(false);
  expect(events.indexOf(toolResult), diagnostic).toBeLessThan(
    events.indexOf(completions[0]!)
  );
  const corrections = events.filter((event) => {
    if (event.type !== 'message_created') return false;
    const metadata = event.data.metadata;
    return (
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      metadata.emptyFinalCorrection === true
    );
  });
  expect(corrections.length, diagnostic).toBe(count - 2);
  if (count === 2) return;

  expect(responses[1]!.contentChars, diagnostic).toBe(0);
  const correction = corrections[0]!;
  if (correction.type !== 'message_created')
    throw new Error('Missing durable correction');
  const metadata = correction.data.metadata;
  expect(
    Boolean(
      correction.data.role === 'user' &&
        metadata &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        metadata.clientVisible === false
    ),
    diagnostic
  ).toBe(true);
  expect(correction.data.parentMessageId === call.id, diagnostic).toBe(true);
  const parts = events.filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.messageId === correction.data.messageId &&
      event.data.partType === 'text'
  );
  expect(parts.length, diagnostic).toBe(1);
  const part = parts[0]!;
  if (part.type !== 'part_created') throw new Error('Missing durable correction text');
  const text = part.data.payload;
  expect(
    Boolean(
      text &&
        typeof text === 'object' &&
        !Array.isArray(text) &&
        text.text === EMPTY_FINAL_CORRECTION_TEXT
    ),
    diagnostic
  ).toBe(true);
  expect(
    JSON.stringify(messages[2]) ===
      JSON.stringify([
        ...afterTool,
        { role: 'user', content: EMPTY_FINAL_CORRECTION_TEXT },
      ]),
    diagnostic
  ).toBe(true);
  expect(events.indexOf(toolResult), diagnostic).toBeLessThan(
    events.indexOf(correction)
  );
  expect(events.indexOf(correction), diagnostic).toBeLessThan(events.indexOf(part));
  expect(events.indexOf(part), diagnostic).toBeLessThan(
    events.indexOf(completions[0]!)
  );
}

function createProviderTrajectoryFixture(corrected: boolean): {
  proxy: TurnActivityProviderEvidence;
  events: SessionEvent[];
} {
  const correctionText = EMPTY_FINAL_CORRECTION_TEXT;
  const messages = [{ role: 'user', content: 'Call Bash.' }];
  const afterTool = [
    ...messages,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-bash',
          type: 'function',
          function: { name: 'Bash', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', content: 'done', tool_call_id: 'call-bash' },
  ];
  const count = corrected ? 3 : 2;
  const base = {
    sessionId: 'session-test',
    timestamp: '2026-09-13T00:00:00.000Z',
    cwd: '/workspace',
    version: '0.10.176',
  };
  const events: SessionEvent[] = [
    {
      ...base,
      id: 'tool-result',
      type: 'part_created',
      data: {
        partId: 'call-bash',
        messageId: 'call-bash',
        partType: 'tool_result',
        payload: {
          toolName: 'Bash',
          toolCallId: 'call-bash',
          output: 'done',
          error: null,
        },
        createdAt: base.timestamp,
      },
    },
    ...(corrected
      ? [
          {
            ...base,
            id: 'correction',
            type: 'message_created' as const,
            data: {
              messageId: 'correction',
              role: 'user' as const,
              parentMessageId: 'call-bash',
              createdAt: base.timestamp,
              metadata: { clientVisible: false, emptyFinalCorrection: true },
            },
          },
        ]
      : []),
    ...(corrected
      ? [
          {
            ...base,
            id: 'correction-text',
            type: 'part_created' as const,
            data: {
              partId: 'correction-text',
              messageId: 'correction',
              partType: 'text' as const,
              payload: { text: correctionText },
              createdAt: base.timestamp,
            },
          },
        ]
      : []),
    {
      ...base,
      id: 'turn-complete',
      type: 'turn_completed',
      data: {
        turnId: 'turn-test',
        completedAt: base.timestamp,
        turnsCount: count,
        toolCallsCount: 1,
        durationMs: 1,
      },
    },
  ];
  return {
    events,
    proxy: {
      requestBodies: [
        JSON.stringify({ messages }),
        JSON.stringify({ messages: afterTool }),
        ...(corrected
          ? [
              JSON.stringify({
                messages: [...afterTool, { role: 'user', content: correctionText }],
              }),
            ]
          : []),
      ],
      forwardedRequestNumbers: Array.from({ length: count }, (_, index) => index + 1),
      responseSummaries: Array.from({ length: count }, (_, index) => ({
        requestNumber: index + 1,
        contentChars: index === count - 1 ? 5 : 0,
        reasoningChars: 0,
        toolCallDeltas: index === 0 ? 1 : 0,
        finishReasons: [index === 0 ? 'tool_calls' : 'stop'],
        done: true,
        parseStatus: 'complete',
      })),
      requestLifecycle: Array.from({ length: count }, (_, index) => [
        {
          requestNumber: index + 1,
          phase: 'headers_received' as const,
          statusClass: 2,
        },
        { requestNumber: index + 1, phase: 'body_completed' as const },
        { requestNumber: index + 1, phase: 'downstream_ended' as const },
      ]).flat(),
    },
  };
}

describe('turn activity provider trajectory contract', () => {
  it.each([false, true])(
    'accepts only evidenced completion (corrected: %s)',
    (corrected) => {
      const { proxy, events } = createProviderTrajectoryFixture(corrected);
      expect(() => assertTurnActivityProviderTrajectory(proxy, events)).not.toThrow();
    }
  );

  it.each([
    'nonempty',
    'truncated',
    'incomplete',
    'tool-repeat',
    'duplicate-request',
    'missing-correction',
    'fourth-request',
    'failed-response',
    'missing-downstream',
    'visible-correction',
    'wrong-parent',
    'wrong-text',
    'late-correction',
    'extra-message',
    'failed-tool',
    'wrong-turn-count',
  ] as const)('rejects unexplained recovery: %s', (failure) => {
    const { proxy, events } = createProviderTrajectoryFixture(true);
    const second = proxy.responseSummaries[1]!;
    if (failure === 'nonempty') second.contentChars = 1;
    if (failure === 'truncated') second.finishReasons = ['length'];
    if (failure === 'incomplete') second.parseStatus = 'incomplete';
    if (failure === 'tool-repeat') proxy.responseSummaries[2]!.toolCallDeltas = 1;
    if (failure === 'duplicate-request')
      proxy.requestBodies[2] = proxy.requestBodies[1]!;
    if (failure === 'fourth-request') proxy.requestBodies.push(proxy.requestBodies[2]!);
    if (failure === 'failed-response') proxy.requestLifecycle[3]!.statusClass = 5;
    if (failure === 'missing-downstream') proxy.requestLifecycle.splice(5, 1);
    const correction = events[1]!;
    const text = events[2]!;
    const tool = events[0]!;
    const completion = events[3]!;
    if (
      correction.type !== 'message_created' ||
      text.type !== 'part_created' ||
      tool.type !== 'part_created' ||
      completion.type !== 'turn_completed'
    ) {
      throw new Error('Unexpected trajectory fixture');
    }
    if (failure === 'missing-correction') events.splice(1, 2);
    if (failure === 'visible-correction')
      correction.data.metadata = { emptyFinalCorrection: true, clientVisible: true };
    if (failure === 'wrong-parent') correction.data.parentMessageId = 'wrong-call';
    if (failure === 'wrong-text') text.data.payload = { text: 'PRIVATE_WRONG_TEXT' };
    if (failure === 'late-correction')
      events.splice(1, 2, completion, correction, text);
    if (failure === 'extra-message')
      proxy.requestBodies[2] = JSON.stringify({
        messages: [{ role: 'user', content: 'PRIVATE_EXTRA_MESSAGE' }],
      });
    if (failure === 'failed-tool')
      tool.data.payload = {
        toolCallId: 'call-bash',
        toolName: 'Bash',
        error: 'PRIVATE_ERROR',
      };
    if (failure === 'wrong-turn-count') completion.data.turnsCount = 2;
    let rejected: unknown;
    try {
      assertTurnActivityProviderTrajectory(proxy, events);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).not.toContain('PRIVATE_');
  });
});

describe('turn activity request evidence', () => {
  it('distinguishes request replay from an added corrective message without retaining text', () => {
    const initial = JSON.stringify({
      messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }],
    });
    const corrected = JSON.stringify({
      messages: [
        { role: 'user', content: 'PRIVATE_PROMPT' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'PRIVATE_TOOL_ID' }] },
        { role: 'tool', content: 'PRIVATE_OUTPUT' },
        {
          role: 'user',
          content: 'The previous response was empty after successful tool execution.',
        },
      ],
    });
    const evidence = summarizeTurnActivityRequests([initial, initial, corrected]);
    expect(evidence).toEqual([
      {
        requestNumber: 1,
        duplicateOf: null,
        messages: [
          { role: 'user', contentChars: 14, toolCalls: 0, emptyFinalCorrection: false },
        ],
      },
      {
        requestNumber: 2,
        duplicateOf: 1,
        messages: [
          { role: 'user', contentChars: 14, toolCalls: 0, emptyFinalCorrection: false },
        ],
      },
      {
        requestNumber: 3,
        duplicateOf: null,
        messages: [
          { role: 'user', contentChars: 14, toolCalls: 0, emptyFinalCorrection: false },
          {
            role: 'assistant',
            contentChars: 0,
            toolCalls: 1,
            emptyFinalCorrection: false,
          },
          { role: 'tool', contentChars: 14, toolCalls: 0, emptyFinalCorrection: false },
          { role: 'user', contentChars: 64, toolCalls: 0, emptyFinalCorrection: true },
        ],
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_');
  });

  it('does not echo malformed bodies or unrecognized role values', () => {
    const evidence = summarizeTurnActivityRequests([
      'PRIVATE_INVALID_JSON',
      JSON.stringify({
        messages: [{ role: 'PRIVATE_ROLE', content: 'PRIVATE_CONTENT' }],
      }),
    ]);
    expect(evidence).toEqual([
      { requestNumber: 1, duplicateOf: null, messages: [] },
      {
        requestNumber: 2,
        duplicateOf: null,
        messages: [
          {
            role: 'unknown',
            contentChars: 15,
            toolCalls: 0,
            emptyFinalCorrection: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_');
  });
});

describe('turn activity Web evidence synchronization', () => {
  it('waits for both independent SSE readers to observe terminal clear', async () => {
    const snapshot = {
      phase: 'executing_tools',
      startedAt: 1_780_000_000_000,
      updatedAt: 1_780_000_001_000,
      turn: 1,
      maxTurns: 4,
      outputStarted: true,
      toolCallsStarted: 1,
      toolCallsCompleted: 0,
      activeTools: [{ name: 'Bash', kind: 'execute', startedAt: 1_780_000_001_000 }],
      activeToolOverflow: 0,
    };
    const active = TurnActivityProjectionSchema.parse({
      version: 1,
      generation: 'sync-generation',
      revision: 1,
      snapshot,
    });
    const clear = TurnActivityProjectionSchema.parse({
      version: 1,
      generation: active.generation,
      revision: 2,
      snapshot: null,
    });
    const probe: SessionEventProbe = {
      events: [{ type: 'turn.activity', properties: { activity: active } }],
      close: async () => undefined,
    };
    const reconnect: SessionEventProbe = {
      events: [{ type: 'turn.activity', properties: { activity: active } }],
      close: async () => undefined,
    };
    vi.useFakeTimers();
    try {
      let settled = false;
      const result = collectWebActivityEvidence(
        [probe, reconnect],
        'session-sync'
      ).then((evidence) => {
        settled = true;
        return evidence;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      probe.events.push({ type: 'turn.activity', properties: { activity: clear } });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      reconnect.events.push({ type: 'turn.activity', properties: { activity: clear } });
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({
        sessionId: 'session-sync',
        generationCount: 1,
        sawBash: true,
        terminalClearSeen: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describeTrajectory('Bash finalization failure production Chromium (real API)', () => {
  for (const model of models) {
    it.for([
      { ending: 'timeout', mode: 'production', preserveExpansion: false },
      { ending: 'cancel', mode: 'production', preserveExpansion: false },
      { ending: 'cancel', mode: 'production', preserveExpansion: true },
      { ending: 'cancel', mode: 'development', preserveExpansion: true },
    ] as const)(
      `${model.model} reports cleanup failure after a real Bash $ending ($mode, expanded: $preserveExpansion)`,
      { timeout: 240_000 },
      async ({ ending, mode, preserveExpansion }, context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        if (!model.baseURL) throw new Error('Missing finalization Provider');
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'blade-finalization-gui-'))
        );
        const workspace = path.join(root, 'workspace');
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const startedFile = path.join(root, 'started');
        const scriptPath = path.join(workspace, 'hold.cjs');
        const proxy = await startRecordingProviderProxy(model.baseURL);
        let child: ChildProcess | undefined;
        let identity:
          | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
          | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        let leaseDirectory: string | undefined;
        let leaseFile: string | undefined;
        let toolPid: number | undefined;
        let devChild: ChildProcess | undefined;
        let devIdentity:
          | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
          | undefined;
        let output = '';
        const faults: string[] = [];
        const errors: unknown[] = [];
        try {
          await mkdir(workspace, { recursive: true });
          await writeRuntimeConfig(home, model, proxy.baseUrl);
          await writeFile(
            scriptPath,
            `require('fs').writeFileSync(${JSON.stringify(startedFile)}, String(process.pid));setInterval(()=>{},1000);`
          );
          const port = await reservePort();
          const origin = `http://127.0.0.1:${port}`;
          child = spawn(
            process.execPath,
            [
              cliEntry,
              '--trust-workspace',
              'serve',
              '--hostname',
              '127.0.0.1',
              '--port',
              String(port),
            ],
            {
              cwd: workspace,
              env: childEnvironment(home, storageRoot, model.apiKey),
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          for (const stream of [child.stdout, child.stderr])
            stream?.on('data', (chunk: Buffer) => {
              output = (output + chunk.toString()).slice(-64_000);
            });
          if (!child.pid) throw new Error('Finalization server has no PID');
          identity = await captureForegroundGuiLauncherIdentity(child.pid);
          await waitFor(
            async () => {
              try {
                return (await fetch(`${origin}/health`)).ok;
              } catch {
                return false;
              }
            },
            'Finalization server not ready',
            30_000
          );
          let guiOrigin = origin;
          if (mode === 'development') {
            const webRoot = path.resolve(import.meta.dirname, '../../../web');
            const webPort = await reservePort();
            const dependencyRoot = await realpath(
              path.resolve(webRoot, '../../../node_modules')
            );
            devChild = spawn(
              process.execPath,
              [
                '--input-type=module',
                '--eval',
                'import { createServer, searchForWorkspaceRoot } from "vite";' +
                  `const server = await createServer({server: {host: "127.0.0.1", port: ${webPort}, strictPort: true, fs: {allow: [searchForWorkspaceRoot(process.cwd()), ${JSON.stringify(dependencyRoot)}]}}});` +
                  'await server.listen();',
              ],
              {
                cwd: webRoot,
                env: {
                  ...childEnvironment(home, storageRoot, model.apiKey),
                  VITE_API_TARGET: origin,
                },
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            );
            for (const stream of [devChild.stdout, devChild.stderr])
              stream?.on('data', (chunk: Buffer) => {
                output = (output + chunk.toString()).slice(-64_000);
              });
            if (!devChild.pid)
              throw new Error('Finalization development server has no PID');
            devIdentity = await captureForegroundGuiLauncherIdentity(devChild.pid);
            guiOrigin = `http://127.0.0.1:${webPort}`;
            await waitFor(
              async () => {
                try {
                  return (await fetch(guiOrigin)).ok;
                } catch {
                  return false;
                }
              },
              'Finalization development server not ready',
              30_000
            );
          }
          const created = await fetch(`${origin}/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              projectPath: workspace,
              title: 'BASH FINALIZATION',
            }),
          });
          expect(created.status).toBe(200);
          const session = SessionSchema.parse(await created.json());
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          page.on('pageerror', (error) => faults.push(error.name));
          page.on('console', (message) => {
            if (message.type() === 'error') faults.push(message.text());
          });
          const url = new URL(guiOrigin);
          url.searchParams.set('session', session.sessionId);
          url.searchParams.set('project', workspace);
          await page.goto(url.href, { waitUntil: 'domcontentloaded' });
          const composer = page.locator('textarea[data-blade-composer]');
          await composer.waitFor({ state: 'visible' });
          const permission = page.locator('[data-blade-permission-mode]');
          if (
            (await permission.getAttribute('data-blade-permission-mode')) !== 'yolo'
          ) {
            await permission.click();
            await page.locator('[data-blade-permission-option="yolo"]').click();
            await page.locator('[data-blade-yolo-confirm]').click();
            await page.waitForFunction(
              () =>
                document
                  .querySelector('[data-blade-permission-mode]')
                  ?.getAttribute('data-blade-permission-mode') === 'yolo'
            );
          }
          await composer.fill(
            [
              `Call Bash exactly once before answering. Use command \`node hold.cjs\` and timeout ${ending === 'cancel' ? 30000 : 8000}.`,
              'Do not call other tools or repeat the command.',
              'After the tool returns, report its failure in one short sentence.',
            ].join('\n')
          );
          await page.locator('[data-blade-submit]').click();
          await waitFor(
            async () => {
              try {
                toolPid = Number(await readFile(startedFile, 'utf8'));
                return Number.isSafeInteger(toolPid);
              } catch {
                return false;
              }
            },
            'Real model did not start Bash',
            90_000
          );
          const transcriptPath = findSessionTranscript(storageRoot, session.sessionId);
          const leaseRoot = path.join(
            path.dirname(transcriptPath),
            '.foreground-processes'
          );
          const names = await readdir(leaseRoot, { recursive: true });
          const name = names.find((entry) => entry.endsWith('.json'));
          if (!name) throw new Error('Durable foreground lease missing');
          leaseFile = path.join(leaseRoot, name);
          leaseDirectory = path.dirname(leaseFile);
          const before = await readFile(leaseFile);
          await chmod(leaseDirectory, 0o500);
          if (preserveExpansion) {
            await page.locator('[data-agent-tool-group] > button').first().click();
            const running = page.locator(
              '[data-chat-history] [data-tool-name="Bash"][data-tool-status="running"]'
            );
            await running.waitFor({ state: 'visible' });
            await running.locator('button[data-tool-call-id]').click();
            expect(
              await running
                .locator('button[data-tool-call-id]')
                .getAttribute('aria-expanded')
            ).toBe('true');
          }
          const cancellationHistory =
            ending === 'cancel'
              ? page.waitForResponse(
                  (response) =>
                    response.request().method() === 'GET' &&
                    new URL(response.url()).pathname ===
                      `/sessions/${session.sessionId}/message`
                )
              : undefined;
          if (ending === 'cancel') {
            await page
              .getByRole('button', { name: 'Stop active turn', exact: true })
              .click();
          }
          await waitFor(
            () => {
              const events = readSessionEvents(transcriptPath);
              return (
                events.some(
                  (event) =>
                    event.type ===
                    (ending === 'cancel' ? 'turn_aborted' : 'turn_completed')
                ) &&
                (ending === 'cancel' ||
                  events.some(
                    (event) =>
                      event.type === 'session_updated' &&
                      event.data.taskStatus === 'completed'
                  ))
              );
            },
            'Finalization turn did not complete',
            90_000
          );
          const events = readSessionEvents(transcriptPath);
          const results = events.filter(
            (event) =>
              event.type === 'part_created' && event.data.partType === 'tool_result'
          );
          expect(toolCallNames(events)).toEqual(['Bash']);
          expect(results).toHaveLength(1);
          expect(JSON.stringify(results)).toContain(
            '"execution_host_failure":"finalization"'
          );
          expect(JSON.stringify(results)).toContain('"finalization_failed":true');
          expect(JSON.stringify(results)).toContain(
            ending === 'cancel' ? '"aborted":true' : '"timeout":true'
          );
          expect(JSON.stringify(results)).not.toContain('"type":"timeout_error"');
          expect(proxy.forwardedRequestNumbers).toEqual(
            ending === 'cancel' ? [1] : [1, 2]
          );
          expect(await readFile(leaseFile)).toEqual(before);
          await waitFor(
            () => {
              try {
                process.kill(toolPid!, 0);
                return false;
              } catch {
                return true;
              }
            },
            'Terminated tool remained alive',
            3_000
          );
          await page
            .locator('[data-turn-activity-strip]')
            .waitFor({ state: 'detached' });
          if (cancellationHistory) {
            const response = await cancellationHistory;
            expect(response.ok()).toBe(true);
            expect(await response.finished()).toBeNull();
          }
          const failedGroup = page
            .locator('[data-agent-tool-group] > button')
            .filter({ hasText: 'Executed 1 command · failed' });
          await failedGroup.waitFor({ state: 'visible' });
          if (preserveExpansion) {
            expect(await failedGroup.getAttribute('aria-expanded')).toBe('true');
          } else {
            await failedGroup.click();
          }
          const toolCard = page.locator(
            '[data-tool-name="Bash"][data-tool-status="error"]'
          );
          await toolCard.waitFor({ state: 'visible' });
          if (preserveExpansion) {
            expect(
              await toolCard
                .locator('button[data-tool-call-id]')
                .getAttribute('aria-expanded')
            ).toBe('true');
          } else {
            await toolCard.locator('button[data-tool-call-id]').click();
          }
          expect(await toolCard.locator('[data-tool-output]').innerText()).toContain(
            'Foreground command finalization failed'
          );
          expect(await readFile(leaseFile)).toEqual(before);
          if (ending === 'cancel') {
            await chmod(leaseDirectory, 0o700);
            await composer.fill(
              'If the cancelled Bash failed during finalization, reply exactly CANCEL_FINALIZATION_RECORDED. Otherwise reply UNEXPECTED_RESULT. Do not use tools.'
            );
            await page.locator('[data-blade-submit]').click();
            await page
              .getByText('CANCEL_FINALIZATION_RECORDED', { exact: true })
              .waitFor({ state: 'visible', timeout: 90_000 });
            await waitFor(
              () =>
                readSessionEvents(transcriptPath).some(
                  (event) => event.type === 'turn_completed'
                ),
              'Cancellation follow-up did not complete',
              90_000
            );
            const recovered = readSessionEvents(transcriptPath);
            expect(toolCallNames(recovered)).toEqual(['Bash']);
            expect(
              recovered.filter((event) => event.type === 'turn_aborted')
            ).toHaveLength(1);
            expect(
              recovered.filter((event) => event.type === 'turn_completed')
            ).toHaveLength(1);
            const final = inspectFinalAssistantText(recovered);
            expect(final.state).not.toBe('structural_mismatch');
            if (final.state !== 'structural_mismatch')
              expect(final.text).toBe('CANCEL_FINALIZATION_RECORDED');
          }
          await page.reload({ waitUntil: 'domcontentloaded' });
          await composer.waitFor({ state: 'visible' });
          await page.locator('[data-agent-tool-group] > button').first().click();
          await toolCard.waitFor({ state: 'visible' });
          await toolCard.locator('button[data-tool-call-id]').click();
          expect(await toolCard.locator('[data-tool-output]').innerText()).toContain(
            'Foreground command finalization failed'
          );
          if (ending === 'timeout') {
            expect(await readFile(leaseFile)).toEqual(before);
          }
          expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
          const providerRequest = JSON.parse(proxy.requestBodies[1] ?? '{}') as {
            messages?: Array<{ role?: string; content?: unknown }>;
          };
          expect(
            providerRequest.messages
              ?.filter((message) => message.role === 'tool')
              .map((message) => message.content)
          ).toEqual(['Error: Foreground command finalization failed']);
          expect(proxy.requestBodies[1]).not.toContain(leaseFile);
          expect(proxy.requestBodies[1]).not.toContain('EACCES');
          expect(faults).toEqual([]);
          assertNoSecrets({ output, html: await page.content(), events }, [
            model.apiKey,
          ]);
          console.log(
            `[bash-finalization] ${JSON.stringify({ model: model.model, category: 'finalization', ending, mode, preserveExpansion, leaseRetained: true, toolCalls: 1, providerRequests: proxy.forwardedRequestNumbers, faults })}`
          );
        } catch (error) {
          errors.push(error);
        } finally {
          if (leaseDirectory)
            await chmod(leaseDirectory, 0o700).catch((error: unknown) => {
              errors.push(error);
            });
          const cleanup = await Promise.allSettled([
            browser?.close(),
            child ? stopForegroundGuiLauncher(child, identity) : undefined,
            devChild ? stopForegroundGuiLauncher(devChild, devIdentity) : undefined,
            proxy.close(),
          ]);
          for (const result of cleanup)
            if (result.status === 'rejected') errors.push(result.reason);
          if (cleanup.every((result) => result.status === 'fulfilled'))
            await removeTestDirectory(root);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(errors, 'Bash finalization GUI failed');
      }
    );
  }
});

describeTrajectory('ACP terminal creation cancellation (real API)', () => {
  for (const model of models) {
    it.for(['reject', 'late'] as const)(
      `${model.model} cancels pending terminal creation with %s and recovers`,
      { timeout: 180_000 },
      async (outcome, context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        if (!model.baseURL) throw new Error('Missing ACP cancellation Provider');
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'blade-acp-create-cancel-'))
        );
        const workspace = path.join(root, 'workspace');
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const proxy = await startRecordingProviderProxy(model.baseURL);
        const marker = `ACP_CREATE_${outcome.toUpperCase()}_RECOVERED`;
        try {
          await mkdir(workspace, { recursive: true });
          await writeRuntimeConfig(home, model, proxy.baseUrl);
          await writeFile(
            path.join(workspace, 'hold.cjs'),
            'setInterval(() => {}, 1000);'
          );
          const evidence = await runRunner({
            runner: acpRunner,
            envName: 'BLADE_TURN_ACTIVITY_ACP_INPUT',
            payload: {
              cliEntry,
              workspace,
              home,
              storageRoot,
              marker,
              releaseFile: path.join(root, 'unused-release'),
              secret: model.apiKey,
              prompt:
                'Call Bash exactly once with command `node hold.cjs` and timeout 30000. Wait for its result before answering. Do not call other tools.',
              creationCancellation: outcome,
            },
          });
          expect(evidence).toMatchObject({
            creationCancellation: {
              outcome,
              attempts: 1,
              kills: outcome === 'late' ? 1 : 0,
              activeTerminals: 0,
              resumed: true,
            },
            terminalReleaseCount: outcome === 'late' ? 1 : 0,
          });
          const transcriptPath = findSessionTranscript(storageRoot, evidence.sessionId);
          const events = readSessionEvents(transcriptPath);
          expect(toolCallNames(events)).toEqual(['Bash']);
          const results = events.filter(
            (event) =>
              event.type === 'part_created' && event.data.partType === 'tool_result'
          );
          expect(results).toMatchObject([
            {
              data: {
                payload: {
                  toolName: 'Bash',
                  output: null,
                  error: '任务已被用户中止',
                  metadata: { shouldExitLoop: true },
                },
              },
            },
          ]);
          expect(JSON.stringify(results)).not.toContain(
            '"execution_host_failure":"terminal"'
          );
          expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(
            1
          );
          expect(
            events.filter((event) => event.type === 'turn_completed')
          ).toHaveLength(1);
          const final = inspectFinalAssistantText(events);
          expect(final.state).not.toBe('structural_mismatch');
          if (final.state !== 'structural_mismatch') expect(final.text).toBe(marker);
          expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
          const followup = JSON.parse(proxy.requestBodies[1] ?? '{}') as {
            messages: Array<{ role: string; content: unknown }>;
          };
          expect(
            followup.messages
              .filter((message) => message.role === 'tool')
              .map((message) => message.content)
          ).toEqual(['Error: 任务已被用户中止']);
          assertNoSecrets(
            {
              evidence,
              transcript: await readFile(transcriptPath, 'utf8'),
              requests: proxy.requestBodies,
            },
            [model.apiKey]
          );
          console.log(
            `[acp-creation-cancellation] ${JSON.stringify({ model: model.model, outcome, requests: proxy.forwardedRequestNumbers, terminalCreateCount: 1, recovered: true })}`
          );
        } finally {
          await proxy.close();
          await removeTestDirectory(root);
        }
      }
    );
  }
});

describeTrajectory('ACP terminal cleanup failure (real API)', () => {
  for (const model of models) {
    it.for([
      { failure: 'kill', cancel: false },
      { failure: 'release', cancel: false },
      { failure: 'kill', cancel: true },
      { failure: 'release', cancel: true },
    ] as const)(
      `${model.model} reports failed $failure (cancel: $cancel) without replaying Bash`,
      { timeout: 180_000 },
      async ({ failure, cancel }, context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        if (!model.baseURL) throw new Error('Missing cleanup Provider');
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'blade-acp-cleanup-'))
        );
        const workspace = path.join(root, 'workspace');
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const releaseFile = path.join(root, 'release');
        const proxy = await startRecordingProviderProxy(model.baseURL);
        const marker = `ACP_CLEANUP_${failure.toUpperCase()}_OBSERVED`;
        const command =
          cancel || failure === 'kill' ? 'node hold.cjs' : 'node release.cjs';
        try {
          await mkdir(workspace, { recursive: true });
          await writeRuntimeConfig(home, model, proxy.baseUrl);
          await writeFile(
            path.join(workspace, 'hold.cjs'),
            'setInterval(()=>{},1000);'
          );
          await writeFile(
            path.join(workspace, 'release.cjs'),
            `const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.stdout.write('DONE')}},25);`
          );
          const prompt = [
            `Call Bash exactly once with command \`${command}\` and timeout ${cancel ? 30000 : failure === 'kill' ? 1000 : 10000}.`,
            'Do not call any other tools or repeat the command after an error.',
            `If the tool reports ACP terminal finalization failed, reply exactly ${marker}; otherwise reply UNEXPECTED_RESULT.`,
          ].join('\n');
          const evidence = await runRunner({
            runner: acpRunner,
            envName: 'BLADE_TURN_ACTIVITY_ACP_INPUT',
            payload: {
              cliEntry,
              workspace,
              home,
              storageRoot,
              prompt,
              marker,
              releaseFile,
              secret: model.apiKey,
              cleanupFailure: failure,
              cleanupCancellation: cancel,
            },
          });
          expect(evidence).toMatchObject({
            cleanupFailure: {
              failure,
              killAttempts: cancel || failure === 'kill' ? 1 : 0,
              releaseAttempts: 1,
              failedUpdates: 1,
            },
            terminalReleaseCount: 1,
          });
          const transcriptPath = findSessionTranscript(storageRoot, evidence.sessionId);
          const events = readSessionEvents(transcriptPath);
          expect(toolCallNames(events)).toEqual(['Bash']);
          const results = events.filter(
            (event) =>
              event.type === 'part_created' && event.data.partType === 'tool_result'
          );
          expect(results).toHaveLength(1);
          expect(JSON.stringify(results)).toContain('"finalization_failed":true');
          expect(JSON.stringify(results)).toContain(
            '"execution_host_failure":"finalization"'
          );
          expect(JSON.stringify(results)).toContain('"terminal_transport":"acp"');
          if (cancel) {
            expect(JSON.stringify(results)).toContain('"aborted":true');
            expect(
              events.filter((event) => event.type === 'turn_aborted')
            ).toHaveLength(1);
            expect(
              events.filter((event) => event.type === 'turn_completed')
            ).toHaveLength(1);
          } else if (failure === 'kill')
            expect(JSON.stringify(results)).toContain('"timeout":true');
          expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
          const request = JSON.parse(proxy.requestBodies[1] ?? '{}') as {
            messages: Array<{ role: string; content: unknown }>;
          };
          expect(
            request.messages
              .filter((message) => message.role === 'tool')
              .map((message) => message.content)
          ).toEqual(['Error: ACP terminal finalization failed']);
          expect(proxy.requestBodies[1]).not.toContain('PRIVATE_ACP_');
          const final = inspectFinalAssistantText(events);
          expect(final.state).not.toBe('structural_mismatch');
          if (final.state !== 'structural_mismatch') expect(final.text).toBe(marker);
          assertNoSecrets(
            { evidence, transcript: await readFile(transcriptPath, 'utf8') },
            [model.apiKey]
          );
          console.log(
            `[acp-cleanup-failure] ${JSON.stringify({ model: model.model, failure, cancel, toolCalls: 1, requests: proxy.forwardedRequestNumbers, failedToolVisible: true })}`
          );
        } finally {
          await proxy.close();
          await removeTestDirectory(root);
        }
      }
    );
  }
});

describeTrajectory('empty final without tools (real API)', () => {
  for (const model of models) {
    for (const surface of surfaces) {
      it(`${model.model} fails visibly through ${surface} and accepts a follow-up`, {
        timeout: 240_000,
      }, async (context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        if (!model.baseURL) throw new Error('Missing empty-final Provider');
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'blade-empty-no-tools-'))
        );
        const workspace = path.join(root, 'workspace');
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const marker = `EMPTY_RECOVERED_${surface.toUpperCase()}`;
        const prompt = 'Reply exactly HELLO. Do not use tools.';
        const proxy = await startRecordingProviderProxy(model.baseURL, {
          stopSequenceOnce: {
            requestNumber: 1,
            stop: 'HELLO',
            prompt: 'Reply exactly HELLO',
          },
        });
        let sessionId = `empty-no-tools-${surface}-${Date.now()}`;
        let server: ChildProcess | undefined;
        let identity:
          | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
          | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          await mkdir(workspace, { recursive: true });
          await writeRuntimeConfig(home, model, proxy.baseUrl);
          if (surface === 'acp' || surface === 'pty') {
            const evidence = await runRunner({
              runner: surface === 'acp' ? acpRunner : ptyRunner,
              envName:
                surface === 'acp'
                  ? 'BLADE_TURN_ACTIVITY_ACP_INPUT'
                  : 'BLADE_TURN_ACTIVITY_PTY_INPUT',
              payload: {
                cliEntry,
                workspace,
                home,
                storageRoot,
                sessionId,
                prompt,
                marker,
                secret: model.apiKey,
                releaseFile: path.join(root, 'unused-release'),
                emptyFinalFailure: true,
              },
            });
            if (surface === 'acp') sessionId = evidence.sessionId;
            expect(evidence.sawBash).toBe(false);
          } else if (surface === 'headless') {
            const invoke = async (input: string, resume: boolean) => {
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
                  resume ? '--resume' : '--session-id',
                  sessionId,
                  '--no-verification-agent',
                  input,
                ],
                {
                  cwd: workspace,
                  env: childEnvironment(home, storageRoot, model.apiKey),
                  stdio: ['ignore', 'pipe', 'pipe'],
                }
              );
              let stdout = '';
              let stderr = '';
              child.stdout?.on('data', (chunk) => {
                stdout = (stdout + chunk.toString()).slice(-128_000);
              });
              child.stderr?.on('data', (chunk) => {
                stderr = (stderr + chunk.toString()).slice(-128_000);
              });
              try {
                const exit = await waitForChildExit(child, 120_000);
                assertNoSecrets({ stdout, stderr }, [model.apiKey]);
                return { ...exit, stdout };
              } finally {
                if (child.exitCode === null && child.signalCode === null)
                  child.kill('SIGKILL');
              }
            };
            const failed = await invoke(prompt, false);
            expect(failed.signal).toBeNull();
            expect(failed.code).not.toBe(0);
            expect(failed.stdout).toContain(
              'The model returned an empty final response.'
            );
            const recovered = await invoke(
              `Replace the previous failed request with this request: reply exactly ${marker}. Do not use tools.`,
              true
            );
            expect(recovered.code).toBe(0);
            expect(headlessContent(recovered.stdout)).toBe(marker);
          } else {
            const port = await reservePort();
            const origin = `http://127.0.0.1:${port}`;
            server = spawn(
              process.execPath,
              [
                cliEntry,
                '--trust-workspace',
                'serve',
                '--hostname',
                '127.0.0.1',
                '--port',
                String(port),
              ],
              {
                cwd: workspace,
                env: childEnvironment(home, storageRoot, model.apiKey),
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            );
            server.stdout?.resume();
            server.stderr?.resume();
            if (!server.pid) throw new Error('Empty final Web server has no PID');
            identity = await captureForegroundGuiLauncherIdentity(server.pid);
            await waitFor(
              async () => {
                try {
                  return (await fetch(`${origin}/health`)).ok;
                } catch {
                  return false;
                }
              },
              'Empty final Web server not ready',
              30_000
            );
            const response = await fetch(`${origin}/sessions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ projectPath: workspace, title: 'Empty final' }),
            });
            expect(response.ok).toBe(true);
            sessionId = SessionSchema.parse(await response.json()).sessionId;
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            const faults: string[] = [];
            page.on('pageerror', (error) => faults.push(error.name));
            page.on('console', (message) => {
              if (message.type() === 'error') faults.push(message.text());
            });
            const url = new URL(origin);
            url.searchParams.set('session', sessionId);
            url.searchParams.set('project', workspace);
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            const composer = page.locator('textarea[data-blade-composer]');
            await composer.waitFor({ state: 'visible' });
            await composer.fill(prompt);
            await page.locator('[data-blade-submit]').click();
            await page
              .locator('[data-blade-session-error]')
              .waitFor({ state: 'visible', timeout: 60_000 });
            expect(proxy.forwardedRequestNumbers).toEqual([1]);
            await composer.fill(
              `Replace the previous failed request with this request: reply exactly ${marker}. Do not use tools.`
            );
            await page.locator('[data-blade-submit]').click();
            const transcriptPath = findSessionTranscript(storageRoot, sessionId);
            await waitFor(
              () =>
                readSessionEvents(transcriptPath).some(
                  (event) => event.type === 'turn_completed'
                ),
              'Web follow-up did not settle',
              60_000
            );
            const settledFinal = inspectFinalAssistantText(
              readSessionEvents(transcriptPath)
            );
            expect(
              settledFinal.state !== 'structural_mismatch' &&
                settledFinal.text === marker,
              JSON.stringify({
                finalState: settledFinal.state,
                responses: proxy.responseSummaries,
              })
            ).toBe(true);
            await page
              .getByText(marker, { exact: true })
              .waitFor({ state: 'visible', timeout: 60_000 });
            expect(faults).toEqual([]);
            assertNoSecrets(await page.content(), [model.apiKey]);
          }
          const transcript = findSessionTranscript(storageRoot, sessionId);
          await waitFor(
            () =>
              readSessionEvents(transcript).some(
                (event) => event.type === 'turn_completed'
              ),
            'Empty final follow-up did not commit'
          );
          const events = readSessionEvents(transcript);
          expect(toolCallNames(events)).toEqual([]);
          expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(
            1
          );
          expect(
            events.filter((event) => event.type === 'turn_completed')
          ).toHaveLength(1);
          const final = inspectFinalAssistantText(events);
          expect(
            events.filter(
              (event) =>
                event.type === 'message_created' &&
                event.data.metadata &&
                typeof event.data.metadata === 'object' &&
                !Array.isArray(event.data.metadata) &&
                event.data.metadata.emptyFinalCorrection === true
            )
          ).toHaveLength(0);
          expect(final.state).not.toBe('structural_mismatch');
          if (final.state !== 'structural_mismatch') expect(final.text).toBe(marker);
          expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
          expect(proxy.stopSequenceRequestNumbers).toEqual([1]);
          expect(proxy.injectedRequestNumbers).toEqual([]);
          expect(proxy.responseSummaries[0]).toMatchObject({
            contentChars: 0,
            toolCallDeltas: 0,
            finishReasons: ['stop'],
            done: true,
            parseStatus: 'complete',
          });
          assertNoSecrets({ events, responses: proxy.responseSummaries }, [
            model.apiKey,
          ]);
          console.log(
            `[empty-final-no-tools] ${JSON.stringify({ model: model.model, surface, requests: proxy.forwardedRequestNumbers, tools: 0, failedThenRecovered: true })}`
          );
        } finally {
          await browser?.close();
          if (server) await stopForegroundGuiLauncher(server, identity);
          await proxy.close();
          await removeTestDirectory(root);
        }
      });
    }
  }
});

describeTrajectory('turn activity empty-final recovery (real API)', () => {
  for (const model of models) {
    for (const surface of surfaces) {
      it(`${model.model} corrects one empty final through ${surface} without repeating Bash`, async (context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        if (!model.baseURL) throw new Error('Missing empty-final Provider');
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'blade-empty-final-'))
        );
        const workspace = path.join(root, 'workspace');
        const storageRoot = path.join(root, 'storage');
        const home = path.join(root, 'home');
        const releaseFile = path.join(root, 'release');
        const executionFile = path.join(root, 'executions');
        const marker = `EMPTY_FINAL_${safeSlug(model.model)}_${surface}_${Date.now()}`
          .toUpperCase()
          .replaceAll(/[^A-Z0-9_]+/g, '_');
        const prompt = createTurnActivityPrompt('node hold.cjs', marker);
        const proxy = await startRecordingProviderProxy(model.baseURL, {
          stopSequenceOnce: {
            requestNumber: 2,
            stop: 'HELLO',
            prompt: 'Reply exactly HELLO',
          },
        });
        let sessionId = `empty-final-${surface}-${Date.now()}`;
        try {
          await mkdir(workspace, { recursive: true });
          await writeRuntimeConfig(home, model, proxy.baseUrl);
          await writeFile(
            path.join(workspace, 'hold.cjs'),
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(executionFile)},'run\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.stdout.write('TOOL_DONE')}},25);`
          );
          if (surface === 'headless' || surface === 'pty') {
            const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
            process.env.BLADE_STORAGE_ROOT = storageRoot;
            try {
              await SessionService.createSessionMetadata(sessionId, workspace, {
                reasoningEffort: 'high',
              });
            } finally {
              if (originalStorageRoot === undefined)
                delete process.env.BLADE_STORAGE_ROOT;
              else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
            }
          }
          const input = {
            workspace,
            home,
            storageRoot,
            sessionId,
            prompt,
            marker,
            secret: model.apiKey,
            releaseFile,
            reasoningEffort: 'high' as const,
          };
          let evidence: ActivityEvidence;
          if (surface === 'headless') {
            evidence = await runHeadless(input);
          } else if (surface === 'web') {
            evidence = await runWeb(input);
          } else {
            evidence = await runRunner({
              runner: surface === 'acp' ? acpRunner : ptyRunner,
              envName:
                surface === 'acp'
                  ? 'BLADE_TURN_ACTIVITY_ACP_INPUT'
                  : 'BLADE_TURN_ACTIVITY_PTY_INPUT',
              payload: { ...input, cliEntry },
            });
          }
          if (surface === 'web' || surface === 'acp') sessionId = evidence.sessionId;
          expect(evidence).toMatchObject({
            generationCount: 1,
            sawBash: true,
            terminalClearSeen: true,
          });
          expect(await readFile(executionFile, 'utf8')).toBe('run\n');
          const transcriptPath = findSessionTranscript(storageRoot, sessionId);
          const events = readSessionEvents(transcriptPath);
          expect(toolCallNames(events)).toEqual(['Bash']);
          const corrections = events.filter((event) => {
            if (event.type !== 'message_created' || event.data.role !== 'user')
              return false;
            const metadata = event.data.metadata;
            return (
              metadata &&
              typeof metadata === 'object' &&
              !Array.isArray(metadata) &&
              metadata.clientVisible === false &&
              metadata.emptyFinalCorrection === true
            );
          });
          expect(corrections).toHaveLength(1);
          expect(
            events.filter((event) => event.type === 'turn_completed')
          ).toMatchObject([{ data: { turnsCount: 3, toolCallsCount: 1 } }]);
          const final = inspectFinalAssistantText(events);
          expect(final.state).not.toBe('structural_mismatch');
          if (final.state !== 'structural_mismatch') expect(final.text).toBe(marker);
          expect(proxy.forwardedRequestNumbers).toEqual([1, 2, 3]);
          assertTurnActivityProviderTrajectory(proxy, events);
          const responses = [...proxy.responseSummaries].sort(
            (left, right) => left.requestNumber - right.requestNumber
          );
          expect(responses).toMatchObject([
            {
              requestNumber: 1,
              finishReasons: ['tool_calls'],
              done: true,
              parseStatus: 'complete',
            },
            {
              requestNumber: 2,
              contentChars: 0,
              toolCallDeltas: 0,
              finishReasons: ['stop'],
              done: true,
              parseStatus: 'complete',
            },
            {
              requestNumber: 3,
              toolCallDeltas: 0,
              finishReasons: ['stop'],
              done: true,
              parseStatus: 'complete',
            },
          ]);
          expect(responses[0]?.toolCallDeltas).toBeGreaterThan(0);
          expect(responses[2]?.contentChars).toBeGreaterThan(0);
          expect(proxy.stopSequenceRequestNumbers).toEqual([2]);
          expect(proxy.jsonOnlyRequestNumbers).toEqual([]);
          expect(proxy.injectedRequestNumbers).toEqual([]);
          const requests = summarizeTurnActivityRequests(proxy.requestBodies);
          expect(requests.map((request) => request.duplicateOf)).toEqual([
            null,
            null,
            null,
          ]);
          expect(
            requests.map(
              (request) =>
                request.messages.filter((message) => message.emptyFinalCorrection)
                  .length
            )
          ).toEqual([0, 0, 1]);
          expect(
            proxy.requestLifecycle.filter((entry) => entry.phase === 'headers_received')
          ).toEqual(
            [1, 2, 3].map((requestNumber) => ({
              requestNumber,
              phase: 'headers_received',
              statusClass: 2,
            }))
          );
          assertNoSecrets({ evidence, requests, responses, events }, [model.apiKey]);
          console.log(
            `[empty-final-recovery] ${JSON.stringify({
              model: model.model,
              surface,
              requests: proxy.forwardedRequestNumbers,
              stopSequenceRequests: proxy.stopSequenceRequestNumbers,
              responses,
              executions: 1,
              durableCorrections: corrections.length,
            })}`
          );
        } finally {
          await proxy.close();
          await removeTestDirectory(root);
        }
      }, 240_000);
    }
  }
});

describeTrajectory('turn activity surface matrix (real API)', () => {
  it.skipIf(enabled)('requires the real API release matrix', () => undefined);

  for (const model of models) {
    for (const surface of surfaces) {
      it(`${model.model} projects turn activity through ${surface}`, async (context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        if (!model.baseURL) throw new Error(`Missing base URL for ${model.model}`);
        await access(cliEntry);
        const root = await mkdtemp(
          path.join(
            os.tmpdir(),
            `blade-turn-activity-${safeSlug(model.model)}-${surface}-`
          )
        );
        const workspacePath = path.join(root, 'workspace');
        const storageRoot = path.join(root, 'storage');
        const home = path.join(root, 'home');
        const releaseFile = path.join(root, 'release-tool');
        const holdCommand =
          `node -e 'const fs=require("fs");const p=${JSON.stringify(
            releaseFile
          )};const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t);` +
          `process.stdout.write("TOOL_DONE\\n")}},50)'`;
        const marker = `TURN_ACTIVITY_${safeSlug(model.model)}_${surface}_${Date.now()}`
          .toUpperCase()
          .replaceAll(/[^A-Z0-9_]+/g, '_');
        const prompt = createTurnActivityPrompt(holdCommand, marker);
        if (prompt.includes(marker)) {
          throw new Error('Turn activity final marker contaminated the prompt');
        }
        const proxy = await startRecordingProviderProxy(model.baseURL);
        let sessionId = `turn-activity-${safeSlug(model.model)}-${surface}-${Date.now()}`;
        try {
          await Promise.all([
            mkdir(workspacePath, { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            mkdir(home, { recursive: true }),
          ]);
          const workspace = await realpath(workspacePath);
          await writeFile(path.join(workspace, 'README.md'), '# Turn activity\n');
          await writeRuntimeConfig(home, model, proxy.baseUrl);

          let evidence: ActivityEvidence;
          if (surface === 'headless') {
            evidence = await runHeadless({
              workspace,
              home,
              storageRoot,
              sessionId,
              prompt,
              marker,
              secret: model.apiKey,
              releaseFile,
            });
          } else if (surface === 'acp') {
            evidence = await runRunner({
              runner: acpRunner,
              envName: 'BLADE_TURN_ACTIVITY_ACP_INPUT',
              payload: {
                cliEntry,
                workspace,
                home,
                storageRoot,
                prompt,
                marker,
                secret: model.apiKey,
                releaseFile,
              },
            });
            sessionId = evidence.sessionId;
          } else if (surface === 'pty') {
            evidence = await runRunner({
              runner: ptyRunner,
              envName: 'BLADE_TURN_ACTIVITY_PTY_INPUT',
              payload: {
                cliEntry,
                workspace,
                home,
                storageRoot,
                sessionId,
                prompt,
                marker,
                secret: model.apiKey,
                allowedTools: 'Bash',
                maxTurns: 4,
                releaseFile,
              },
            });
          } else {
            evidence = await runWeb({
              workspace,
              home,
              storageRoot,
              prompt,
              marker,
              secret: model.apiKey,
              releaseFile,
            });
            sessionId = evidence.sessionId;
          }
          if (!evidence.sawBash || !evidence.terminalClearSeen) {
            throw new Error(
              `Incomplete ${surface} activity evidence: ${JSON.stringify({
                phases: evidence.phases,
                generationCount: evidence.generationCount,
                sawBash: evidence.sawBash,
                terminalClearSeen: evidence.terminalClearSeen,
                output: evidence.output?.slice(-8_000),
              })}`
            );
          }
          expect(evidence.generationCount).toBe(1);
          expect(evidence.sawBash).toBe(true);
          expect(evidence.terminalClearSeen).toBe(true);
          expect(evidence.phases).toContain('executing_tools');
          expect(evidence.phases.at(-1)).toBe('clear');
          const transcriptPath = findSessionTranscript(storageRoot, sessionId);
          let transcript = await readFile(transcriptPath, 'utf8');
          let events = readSessionEvents(transcriptPath);
          if (surface !== 'pty') {
            await waitFor(
              async () => {
                transcript = await readFile(transcriptPath, 'utf8');
                events = readSessionEvents(transcriptPath);
                const final = inspectFinalAssistantText(events);
                return final.state !== 'structural_mismatch' && final.text === marker;
              },
              `${surface} turn activity Session did not durably settle`,
              60_000
            );
          }
          expect(toolCallNames(events)).toEqual(['Bash']);
          if (surface === 'pty') {
            expect(transcript).toContain(marker);
          } else {
            const final = inspectFinalAssistantText(events);
            expect(final.state).not.toBe('structural_mismatch');
            if (final.state === 'structural_mismatch') {
              throw new Error('Turn activity transcript is structurally incomplete');
            }
            expect(final.text).toBe(marker);
          }
          assertTurnActivityProviderTrajectory(proxy, events);
          assertNoSecrets(
            { evidence, transcript, responses: proxy.responseSummaries },
            [model.apiKey]
          );
        } finally {
          await proxy.close();
          await removeTestDirectory(root);
        }
      }, 360_000);
    }
  }
});
