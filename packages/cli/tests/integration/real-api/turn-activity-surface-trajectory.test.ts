import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it, type TestContext } from 'vitest';
import { SessionSchema } from '../../../src/api/schemas.js';
import { TurnActivityProjectionSchema } from '../../../src/api/turnActivitySchemas.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
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
    await writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    reconnectProbe = await openEventProbe(origin, created.sessionId, input.workspace);
    expect(reconnectProbe.events[0]).toMatchObject({
      type: 'connected',
      properties: {
        turnActivity: expect.objectContaining({
          snapshot: expect.objectContaining({ phase: 'executing_tools' }),
        }),
      },
    });
    await page.getByText(input.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 180_000,
    });
    await page
      .locator('[data-turn-activity-strip]')
      .waitFor({ state: 'detached', timeout: 20_000 });
    expect(faults).toEqual([]);
    const values = [...probe.events, ...reconnectProbe.events]
      .filter((event) => event.type === 'turn.activity')
      .map((event) => event.properties.activity);
    const evidence = activityEvidence(values, created.sessionId);
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
          expect(proxy.requestBodies).toHaveLength(2);
          expect(proxy.forwardedRequestNumbers).toHaveLength(2);
          assertNoSecrets({ evidence, transcript }, [model.apiKey]);
        } finally {
          await proxy.close();
          await removeTestDirectory(root);
        }
      }, 360_000);
    }
  }
});
