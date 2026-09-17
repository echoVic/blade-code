import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { createProcessModelResources } from '../../../src/agent/resources/WorkspaceModelResources.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { ChildBackedRecordingAcpClient } from '../../support/acp/ChildBackedRecordingAcpClient.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import { createSplitPtyMarkerInstruction } from '../../support/foregroundBoundedOutputPtyDriver.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { OpenAIResponseSummaryCollector } from '../../support/recordingProviderProxy.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const enabled = isRealApiTestEnabled() && process.env.REAL_API_RELEASE_MATRIX === '1';
const models = enabled ? resolveRequiredDeepSeekQualificationModels() : [];
const surfaces = [
  'headless',
  'acp',
  'pty',
  'web-production',
  'web-development',
] as const;
const settlementCases = [
  { settlementState: 'paused', directSchemas: false, skillSchemas: false },
  { settlementState: 'blocked', directSchemas: false, skillSchemas: false },
  { settlementState: 'blocked', directSchemas: true, skillSchemas: false },
  { settlementState: 'blocked', directSchemas: false, skillSchemas: true },
] as const;
if (enabled && models.length * surfaces.length * settlementCases.length !== 40) {
  throw new Error('Goal usage qualification requires forty surface/state/schema cells');
}
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const roots: string[] = [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
const marker = 'GOAL_PAUSED_USAGE_READY';
const blocker = 'Required external credentials are unavailable';
const followUpMarker = 'SKILL_RELEASED_NEXT_TASK';
const followUpPrompt = `The previous Skill task is finished. This is a new ordinary task. Do not use tools. ${createSplitPtyMarkerInstruction(followUpMarker)}`;
type SettlementState = 'paused' | 'blocked';

afterEach(async () => {
  resetProjectionDbCache();
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  await Promise.all(roots.splice(0).map(removeTestDirectory));
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function responseEvidence(text: string): {
  tokens: number;
  content: string;
  toolNames: string[];
} {
  let tokens = 0;
  let content = '';
  const toolNames: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    const payload: unknown = JSON.parse(data);
    if (!payload || typeof payload !== 'object') continue;
    if ('choices' in payload && Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (!choice || typeof choice !== 'object' || !('delta' in choice)) continue;
        const delta: unknown = choice.delta;
        if (
          delta &&
          typeof delta === 'object' &&
          'tool_calls' in delta &&
          Array.isArray(delta.tool_calls)
        ) {
          for (const call of delta.tool_calls) {
            if (!call || typeof call !== 'object' || !('function' in call)) continue;
            const fn: unknown = call.function;
            if (
              fn &&
              typeof fn === 'object' &&
              'name' in fn &&
              typeof fn.name === 'string'
            )
              toolNames.push(fn.name);
          }
        }
        if (
          delta &&
          typeof delta === 'object' &&
          'content' in delta &&
          typeof delta.content === 'string'
        ) {
          content += delta.content;
        }
      }
    }
    const usage = 'usage' in payload ? payload.usage : undefined;
    if (
      usage &&
      typeof usage === 'object' &&
      'total_tokens' in usage &&
      typeof usage.total_tokens === 'number'
    )
      tokens = usage.total_tokens;
  }
  return { tokens, content, toolNames };
}

async function createFixture(
  model: TestModelConfig,
  settlementState: SettlementState,
  directSchemas = false,
  skillSchemas = false
) {
  if (!model.baseURL) throw new Error('Missing real model base URL');
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-paused-usage-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const storageRoot = path.join(root, 'storage');
  const readyFile = path.join(root, 'provider-ready');
  const releaseFile = path.join(root, 'provider-release');
  const followUpReadyFile = path.join(root, 'follow-up-allowed');
  const sessionId = `goal-paused-usage-${randomBytes(6).toString('hex')}`;
  await Promise.all([
    mkdir(workspace),
    mkdir(path.join(home, '.blade'), { recursive: true }),
  ]);
  if (skillSchemas) {
    const skillRoot = path.join(home, '.blade', 'skills', 'goal-boundary');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      [
        '---',
        'name: goal-boundary',
        'description: Report the external prerequisite blocking this Goal',
        'allowed-tools:',
        '  - UpdateGoal',
        '---',
        `Required credentials are unavailable. Call UpdateGoal with status blocked and reason "${blocker}".`,
        'Do not call other tools. Do not request more work or claim completion.',
      ].join('\n')
    );
  }
  let requests = 0;
  let tokens = 0;
  const responseContents: string[] = [];
  let discovered = false;
  let skillActivated = false;
  let blockingToolSeen = false;
  let finalResponseSeen = false;
  let followUpAllowed = false;
  let followUpRequests = 0;
  let followUpCompleted = false;
  let failure: string | undefined;
  const abort = new AbortController();
  const server = createServer((request, response) => {
    void (async () => {
      const followUp =
        followUpAllowed ||
        (skillSchemas &&
          (await access(followUpReadyFile).then(
            () => true,
            () => false
          )));
      if (followUp) {
        followUpRequests++;
        if (followUpRequests !== 1) throw new Error('Follow-up unexpectedly repeated');
      } else {
        requests++;
        const expectedRequests = settlementState === 'blocked' ? 2 : 1;
        if (finalResponseSeen || requests > expectedRequests)
          throw new Error('Stopped Goal unexpectedly requested another response');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (directSchemas || (skillSchemas && requests > 1)) {
        const requestBody: unknown = JSON.parse(body.toString('utf8'));
        if (
          !requestBody ||
          typeof requestBody !== 'object' ||
          !('tools' in requestBody) ||
          !Array.isArray(requestBody.tools)
        ) {
          throw new Error('Direct-schema request has no tool declarations');
        }
        const names = requestBody.tools.flatMap((tool) => {
          if (!tool || typeof tool !== 'object' || !('function' in tool)) return [];
          const fn: unknown = tool.function;
          return fn &&
            typeof fn === 'object' &&
            'name' in fn &&
            typeof fn.name === 'string'
            ? [fn.name]
            : [];
        });
        if (followUp) {
          const messages = 'messages' in requestBody ? requestBody.messages : undefined;
          if (
            !Array.isArray(messages) ||
            !messages.some(
              (message) =>
                message &&
                typeof message === 'object' &&
                'role' in message &&
                message.role === 'user' &&
                'content' in message &&
                message.content === followUpPrompt
            )
          )
            throw new Error('Follow-up request lost the complete user prompt');
          if (!names.includes('Skill') || !names.includes('ToolSearch')) {
            throw new Error(
              `Previous Skill restrictions leaked into the next task: ${names.join(',')}`
            );
          }
        } else if (
          names.toSorted().join(',') !==
          ['ReadPromptArtifact', 'UpdateGoal'].toSorted().join(',')
        ) {
          throw new Error(
            `Unexpected direct-schema tool declarations: ${names.join(',')}`
          );
        }
      }
      const target = new URL(model.baseURL!);
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
      const incomingPath =
        target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
          ? incoming.pathname.slice(3)
          : incoming.pathname;
      target.pathname = `${target.pathname.replace(/\/+$/, '')}/${incomingPath.replace(/^\/+/, '')}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          !['host', 'connection', 'content-length'].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      });
      if (!upstream.ok) throw new Error(`Real Provider returned ${upstream.status}`);
      const text = await upstream.text();
      const summary = new OpenAIResponseSummaryCollector(requests);
      summary.append(Buffer.from(text));
      const observed = summary.finish();
      const evidence = responseEvidence(text);
      if (followUp) {
        if (
          observed.parseStatus !== 'complete' ||
          observed.toolCallDeltas !== 0 ||
          !observed.finishReasons.includes('stop') ||
          evidence.content !== followUpMarker
        ) {
          throw new Error(
            `Unexpected follow-up response: ${JSON.stringify({ observed, content: evidence.content })}`
          );
        }
        followUpCompleted = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(text);
        return;
      }
      responseContents.push(evidence.content);
      tokens += evidence.tokens;
      const skillResponse = skillSchemas && !skillActivated && requests === 1;
      const discoveryResponse =
        !directSchemas &&
        !skillSchemas &&
        settlementState === 'blocked' &&
        !discovered &&
        !blockingToolSeen &&
        requests === 1 &&
        evidence.toolNames.join(',') === 'ToolSearch';
      const blockingResponse =
        settlementState === 'blocked' &&
        !blockingToolSeen &&
        !discoveryResponse &&
        !skillResponse;
      if (
        observed.parseStatus !== 'complete' ||
        evidence.tokens <= 0 ||
        (blockingResponse || discoveryResponse || skillResponse
          ? !observed.finishReasons.includes('tool_calls') ||
            evidence.toolNames.join(',') !==
              (skillResponse
                ? 'Skill'
                : discoveryResponse
                  ? 'ToolSearch'
                  : 'UpdateGoal')
          : !observed.finishReasons.includes('stop') ||
            observed.toolCallDeltas !== 0 ||
            evidence.content !== marker)
      ) {
        throw new Error(
          `Unexpected real Provider response: ${JSON.stringify({ observed, tokens, toolNames: evidence.toolNames, content: evidence.content.slice(0, 256) })}`
        );
      }
      if (blockingResponse || discoveryResponse || skillResponse) {
        discovered ||= discoveryResponse;
        skillActivated ||= skillResponse;
        blockingToolSeen ||= blockingResponse;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(text);
        if (blockingResponse && (discovered || skillActivated))
          await writeFile(readyFile, 'turn-limit');
        return;
      }
      finalResponseSeen = true;
      await writeFile(readyFile, 'ready');
      await waitFor(
        async () =>
          abort.signal.aborted ||
          access(releaseFile).then(
            () => true,
            () => false
          ),
        'Pause barrier was not released',
        30_000
      );
      if (abort.signal.aborted) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(text);
    })().catch((error: unknown) => {
      failure = (error instanceof Error ? error.message : String(error)).replaceAll(
        model.apiKey,
        '[redacted]'
      );
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  const config: RuntimeConfig = buildRealApiRuntimeConfig(model);
  config.models = config.models.map((entry) => ({
    ...entry,
    overrides: {
      ...entry.overrides,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
    },
  }));
  config.permissionMode = PermissionMode.YOLO;
  config.allowedTools = skillSchemas
    ? ['Skill', 'ToolSearch', 'UpdateGoal']
    : directSchemas
      ? ['UpdateGoal']
      : settlementState === 'blocked'
        ? ['ToolSearch', 'UpdateGoal']
        : ['Read'];
  if (directSchemas) config.disallowedTools = ['ToolSearch'];
  config.maxTurns = settlementState === 'blocked' ? 2 : 1;
  config.hooks = { enabled: false };
  config.disableAllHooks = true;
  config.mcpServers = {};
  await writeFile(path.join(home, '.blade', 'config.json'), JSON.stringify(config), {
    mode: 0o600,
  });
  const previousConfig = getState().config.config;
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  resetProjectionDbCache();
  getState().config.actions.setConfig(config);
  try {
    await SessionService.createSessionMetadata(sessionId, workspace, {
      title: 'Paused Goal usage',
      selectedModelId: config.currentModelId,
      permissionMode: PermissionMode.YOLO,
      taskStatus: 'completed',
    });
    const runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot: workspace,
      modelResources: createProcessModelResources(workspace, config),
    });
    try {
      const turn = await runtime.prepareInputTurn(
        'Initialize a paused-usage verification session.'
      );
      if (!turn.accepted) throw new Error('Initial turn not accepted');
      await runtime.finishTurn(turn.handle, {
        outcome: {
          status: 'completed',
          turnsCount: 0,
          toolCallsCount: 0,
          durationMs: 0,
        },
      });
      await runtime.createGoal({
        objective: skillSchemas
          ? 'Call Skill with skill "goal-boundary" first, then follow its instructions to report the external blocker. Do not call UpdateGoal before loading the skill.'
          : settlementState === 'blocked'
            ? `This Goal cannot proceed because required credentials are unavailable and only the user can provide them.\n` +
              `Step 1: You MUST call UpdateGoal with {"status":"blocked","reason":"${blocker}"}. ` +
              `If its schema is deferred, first load it with ToolSearch. Never answer before the UpdateGoal tool succeeds.\n` +
              `Step 2 (only after successful UpdateGoal): concatenate only the values after '=' in PART_A and PART_B. ` +
              `Output exactly 23 ASCII characters. Do not output the labels PART_A, PART_B, equals signs, or whitespace.\n` +
              `PART_A=GOAL_PAUSED_\nPART_B=USAGE_READY\n` +
              `Do not perform other work. The blocking tool call is mandatory; the final response cannot replace it.`
            : createSplitPtyMarkerInstruction(marker),
        tokenBudget: 1,
      });
    } finally {
      await runtime.dispose();
    }
  } finally {
    if (previousConfig) getState().config.actions.setConfig(previousConfig);
  }
  const env = {
    ...process.env,
    HOME: home,
    BLADE_STORAGE_ROOT: storageRoot,
    BLADE_API_KEY: model.apiKey,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_VERSION: '999.0.0',
    TERM: 'xterm-256color',
  };
  return {
    settlementState,
    directSchemas,
    skillSchemas,
    workspace,
    home,
    storageRoot,
    sessionId,
    readyFile,
    releaseFile,
    followUpReadyFile,
    env,
    store: new GoalStore(workspace, sessionId),
    tokens: () => tokens,
    responseContents: () => [...responseContents],
    requests: () => requests,
    discoveryRequests: () => Number(discovered),
    skillActivated: () => skillActivated,
    allowFollowUp: () => {
      followUpAllowed = true;
    },
    followUpCompleted: () => followUpCompleted,
    followUpRequests: () => followUpRequests,
    turnLimitReached: () => (discovered || skillActivated) && blockingToolSeen,
    ready: async () => {
      await waitFor(async () => {
        if (failure) throw new Error(failure);
        if ((discovered || skillActivated) && blockingToolSeen) return true;
        return access(readyFile).then(
          () => true,
          () => false
        );
      }, 'Real response not ready');
    },
    release: () => writeFile(releaseFile, 'release'),
    close: async () => {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function startChild(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-256_000);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-64_000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

async function assertSettlement(test: Fixture) {
  await waitFor(
    async () => (await test.store.get())?.tokensUsed === test.tokens(),
    'Paused Goal usage did not settle'
  );
  const goal = await test.store.get();
  expect(goal).toMatchObject({
    status: test.settlementState,
    statusReason: test.settlementState === 'paused' ? 'paused by user' : blocker,
    tokensUsed: test.tokens(),
    continuationCount: 1,
    turnLineage: { currentTurnId: expect.any(String) },
  });
  const persistence = new PersistentStore(test.workspace);
  if (test.turnLimitReached()) {
    await waitFor(
      async () =>
        (await persistence.loadEvents(test.sessionId))?.some(
          (event) =>
            event.type === 'turn_aborted' &&
            event.data.turnId === goal?.turnLineage?.currentTurnId
        ) === true,
      'Bounded Goal turn did not finish',
      30_000
    );
  }
  const events = await persistence.loadEvents(test.sessionId);
  expect(
    events?.filter((event) => event.type === 'turn_started' && event.data.goalLineage)
  ).toHaveLength(1);
  return goal;
}

async function runWeb(test: Fixture, development: boolean, secret: string) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const host = startChild(
    process.execPath,
    [
      cliEntry,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      ...(test.directSchemas
        ? ['--allowed-tools', 'UpdateGoal', '--disallowed-tools', 'ToolSearch']
        : []),
    ],
    test.workspace,
    test.env
  );
  if (!host.child.pid) throw new Error('Web host has no PID');
  const identity = await captureForegroundGuiLauncherIdentity(host.child.pid);
  let dev: ReturnType<typeof startChild> | undefined;
  let devIdentity:
    | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
    | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let refreshing = false;
  let closing = false;
  try {
    await waitFor(
      () =>
        fetch(`${origin}/health`).then(
          (response) => response.ok,
          () => false
        ),
      'Web host not ready',
      20_000
    );
    let guiOrigin = origin;
    if (development) {
      const webRoot = path.resolve(import.meta.dirname, '../../../web');
      const dependencyRoot = await realpath(
        path.resolve(webRoot, '../../../node_modules')
      );
      const webPort = await reservePort();
      dev = startChild(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          'import {createServer,searchForWorkspaceRoot} from "vite";' +
            `const s=await createServer({server:{host:"127.0.0.1",port:${webPort},strictPort:true,fs:{allow:[searchForWorkspaceRoot(process.cwd()),${JSON.stringify(dependencyRoot)}]}}});await s.listen();`,
        ],
        webRoot,
        { ...test.env, VITE_API_TARGET: origin }
      );
      if (!dev.child.pid) throw new Error('Vite host has no PID');
      devIdentity = await captureForegroundGuiLauncherIdentity(dev.child.pid);
      guiOrigin = `http://127.0.0.1:${webPort}`;
      await waitFor(
        () =>
          fetch(guiOrigin).then(
            (response) => response.ok,
            () => false
          ),
        'Vite host not ready',
        20_000
      );
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const faults: string[] = [];
    page.on('pageerror', (error) => faults.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(message.text());
    });
    page.on('requestfailed', (request) => {
      const errorText = request.failure()?.errorText ?? 'unknown';
      if (
        !isExpectedBrowserRequestFailure({
          url: request.url(),
          resourceType: request.resourceType(),
          errorText,
          refreshing,
          closing,
        })
      )
        faults.push(`${errorText}: ${request.url()}`);
    });
    const url = new URL(guiOrigin);
    url.searchParams.set('session', test.sessionId);
    url.searchParams.set('project', test.workspace);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    try {
      await test.ready();
    } catch (error) {
      throw new Error(
        JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          requests: test.requests(),
          discoveryRequests: test.discoveryRequests(),
          goal: await test.store.get(),
          tools: await page.locator('[data-tool-name]').evaluateAll((elements) =>
            elements.map((element) => ({
              name: element.getAttribute('data-tool-name'),
              status: element.getAttribute('data-tool-status'),
            }))
          ),
        }).replaceAll(secret, '[redacted]')
      );
    }
    if (test.settlementState === 'paused') {
      const section = page.locator('[data-blade-goal-status="active"]');
      await section.getByRole('button', { name: /暂停|Pause/i }).click();
    }
    await page.locator(`[data-blade-goal-status="${test.settlementState}"]`).waitFor();
    if (!test.turnLimitReached()) {
      expect((await test.store.get())?.tokensUsed).toBe(0);
      await test.release();
    }
    const settled = await assertSettlement(test);
    if (test.turnLimitReached()) {
      const persistence = new PersistentStore(test.workspace);
      await waitFor(
        async () =>
          (await persistence.loadEvents(test.sessionId))?.some(
            (event) =>
              (event.type === 'turn_aborted' || event.type === 'turn_completed') &&
              event.data.turnId === settled?.turnLineage?.currentTurnId
          ) === true,
        'Bounded Goal turn did not finish',
        30_000
      );
      const events = await persistence.loadEvents(test.sessionId);
      expect(events?.filter((event) => event.type === 'turn_aborted')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            turnId: settled?.turnLineage?.currentTurnId,
            cause: 'failed',
            turnsCount: 2,
            toolCallsCount: 2,
          }),
        }),
      ]);
    } else {
      await page
        .locator('[data-chat-role="assistant"]')
        .getByText(marker, { exact: true })
        .waitFor({ timeout: 30_000 });
    }
    const tokensText =
      test.tokens() >= 1000
        ? `${(test.tokens() / 1000).toFixed(1)}K`
        : String(test.tokens());
    await waitFor(
      async () =>
        (
          await page
            .locator(`[data-blade-goal-status="${test.settlementState}"]`)
            .textContent()
        )?.includes(`${tokensText}/1`) === true,
      'Web paused usage not rendered'
    );
    await page
      .locator(`[data-blade-goal-status="${test.settlementState}"]`)
      .getByRole('button', { name: /恢复|Resume/i })
      .click();
    await page.locator('[data-blade-goal-status="budget_limited"]').waitFor();
    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await page.locator('[data-blade-goal-status="budget_limited"]').waitFor();
    if (test.skillSchemas) {
      test.allowFollowUp();
      const composer = page.locator('textarea[data-blade-composer]');
      await composer.fill(followUpPrompt);
      await page.locator('[data-blade-submit]').click();
      await page
        .locator('[data-chat-role="assistant"]')
        .getByText(followUpMarker, { exact: true })
        .waitFor({ timeout: 90_000 });
    }
    expect(await page.locator('body').textContent()).not.toContain(secret);
    expect(faults).toEqual([]);
    expect(host.stdout() + host.stderr() + (dev?.stderr() ?? '')).not.toContain(secret);
  } finally {
    closing = true;
    await browser?.close();
    if (dev) await stopForegroundGuiLauncher(dev.child, devIdentity);
    await stopForegroundGuiLauncher(host.child, identity);
  }
}

async function runHeadless(test: Fixture, secret: string) {
  const host = startChild(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--resume',
      test.sessionId,
      '--allowed-tools',
      test.skillSchemas
        ? 'Skill,ToolSearch,UpdateGoal'
        : test.directSchemas
          ? 'UpdateGoal'
          : test.settlementState === 'blocked'
            ? 'ToolSearch,UpdateGoal'
            : 'Read',
      ...(test.directSchemas ? ['--disallowed-tools', 'ToolSearch'] : []),
      '--no-verification-agent',
    ],
    test.workspace,
    test.env
  );
  if (!host.child.pid) throw new Error('Headless host has no PID');
  const identity = await captureForegroundGuiLauncherIdentity(host.child.pid);
  try {
    await test.ready();
    if (test.settlementState === 'paused') await test.store.pause();
    if (!test.turnLimitReached()) {
      await expect(test.store.get()).resolves.toMatchObject({
        status: test.settlementState,
        tokensUsed: 0,
      });
      await test.release();
    }
    expect(await host.exited).toBe(test.turnLimitReached() ? 1 : 0);
    await expect(test.store.get()).resolves.toMatchObject({
      status: test.settlementState,
      tokensUsed: test.tokens(),
    });
    await assertSettlement(test);
    const events: unknown[] = host
      .stdout()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'goal',
        status: test.settlementState,
        current_turn_id: expect.any(String),
      })
    );
    const responseContents: string[] = [];
    let content = '';
    for (const event of events) {
      if (!event || typeof event !== 'object' || !('type' in event)) continue;
      if (
        event.type === 'content_delta' &&
        'delta' in event &&
        typeof event.delta === 'string'
      ) {
        content += event.delta;
      } else if (event.type === 'stream_end') {
        responseContents.push(content);
        content = '';
      }
    }
    expect(content).toBe('');
    expect(responseContents).toEqual(test.responseContents());
    if (test.turnLimitReached()) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('轮次上限'),
        })
      );
    } else {
      expect(responseContents.at(-1)).toBe(marker);
    }
    const reported = events.flatMap((event) =>
      event &&
      typeof event === 'object' &&
      'type' in event &&
      event.type === 'token_usage' &&
      'total_tokens' in event &&
      typeof event.total_tokens === 'number'
        ? [event.total_tokens]
        : []
    );
    expect(reported).toHaveLength(test.settlementState === 'blocked' ? 2 : 1);
    expect(reported.reduce((sum, tokens) => sum + tokens, 0)).toBe(test.tokens());
    expect(host.stdout() + host.stderr()).not.toContain(secret);
    await expect(test.store.resume()).resolves.toMatchObject({
      status: 'budget_limited',
    });
    if (test.skillSchemas) {
      test.allowFollowUp();
      const next = startChild(
        process.execPath,
        [
          cliEntry,
          '--headless',
          '--output-format',
          'jsonl',
          '--resume',
          test.sessionId,
          '--allowed-tools',
          'Skill,ToolSearch,UpdateGoal',
          '--no-verification-agent',
          followUpPrompt,
        ],
        test.workspace,
        test.env
      );
      if (!next.child.pid) throw new Error('Follow-up host has no PID');
      const nextIdentity = await captureForegroundGuiLauncherIdentity(next.child.pid);
      try {
        expect(await next.exited).toBe(0);
        const content = next
          .stdout()
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            const event: unknown = JSON.parse(line);
            return event &&
              typeof event === 'object' &&
              'type' in event &&
              event.type === 'content_delta' &&
              'delta' in event &&
              typeof event.delta === 'string'
              ? [event.delta]
              : [];
          })
          .join('');
        expect(content).toBe(followUpMarker);
      } finally {
        await stopForegroundGuiLauncher(next.child, nextIdentity);
      }
    }
  } finally {
    await stopForegroundGuiLauncher(host.child, identity);
  }
}

async function runAcp(test: Fixture, secret: string) {
  const child: ChildProcess = spawn(process.execPath, [cliEntry, '--acp'], {
    cwd: test.workspace,
    env: test.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.pid || !child.stdin || !child.stdout)
    throw new Error('ACP host stdio missing');
  const identity = await captureForegroundGuiLauncherIdentity(child.pid);
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-256_000);
  });
  const client = new ChildBackedRecordingAcpClient();
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-64_000);
  });
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    await connection.loadSession({
      sessionId: test.sessionId,
      cwd: test.workspace,
      mcpServers: [],
    });
    await test.ready();
    if (test.settlementState === 'paused') await test.store.pause();
    if (!test.turnLimitReached()) {
      await expect(test.store.get()).resolves.toMatchObject({
        status: test.settlementState,
        tokensUsed: 0,
      });
      await test.release();
    }
    await assertSettlement(test);
    await waitFor(
      () =>
        client.sessionUpdates.some((event) => {
          const goal = event.update._meta?.['blade/goal'];
          return (
            goal &&
            typeof goal === 'object' &&
            'status' in goal &&
            goal.status === test.settlementState
          );
        }),
      'ACP paused Goal projection missing'
    );
    await connection.prompt({
      sessionId: test.sessionId,
      prompt: [{ type: 'text', text: '/goal resume' }],
    });
    await waitFor(
      async () => (await test.store.get())?.status === 'budget_limited',
      'ACP resumed over budget'
    );
    if (test.skillSchemas) {
      test.allowFollowUp();
      const start = client.sessionUpdates.length;
      await connection.prompt({
        sessionId: test.sessionId,
        prompt: [{ type: 'text', text: followUpPrompt }],
      });
      const updates = client.sessionUpdates.slice(start);
      const goalBoundary = updates.findIndex(
        ({ update }) =>
          update.sessionUpdate === 'session_info_update' &&
          update._meta?.['blade/goal'] !== undefined
      );
      expect(goalBoundary).toBeGreaterThanOrEqual(0);
      const text = (notifications: readonly acp.SessionNotification[]) =>
        notifications
          .flatMap(({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text'
              ? [update.content.text]
              : []
          )
          .join('');
      expect(text(updates.slice(0, goalBoundary))).toBe(followUpMarker);
      const goal = await test.store.get();
      expect(goal?.status).toBe('budget_limited');
      expect(text(updates.slice(goalBoundary))).toBe(
        `[Goal budget_limited: ${goal?.objective}]\n`
      );
    }
    child.stdin.end();
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      'ACP EOF shutdown did not finish',
      10_000
    );
    await connection.closed;
    expect(child.exitCode).toBe(0);
    expect(stdout).not.toContain('\u001b');
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.stringify(client.sessionUpdates) + stdout + stderr).not.toContain(
      secret
    );
  } finally {
    await stopForegroundGuiLauncher(child, identity);
    await client.close();
  }
}

const suite =
  enabled && process.platform !== 'win32' ? describe.sequential : describe.skip;
suite('Stopped Goal usage surface matrix (real API)', () => {
  it.skipIf(enabled)('requires the real API release matrix', () => undefined);
  for (const model of models) {
    it(`${model.model} settles a Goal created and paused inside the initiating turn`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-create-pause-'));
      roots.push(root);
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      resetProjectionDbCache();
      const previousConfig = getState().config.config;
      const config = buildRealApiRuntimeConfig(model);
      getState().config.actions.setConfig(config);
      const sessionId = `goal-create-pause-${randomBytes(6).toString('hex')}`;
      const runtime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: root,
        modelResources: createProcessModelResources(root, config),
      });
      const agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'CreateGoal'],
      });
      try {
        const context: ChatContext = {
          messages: [],
          userId: 'goal-create-pause-test',
          sessionId,
          workspaceRoot: root,
          permissionMode: PermissionMode.YOLO,
        };
        const events: LoopEvent[] = [];
        let paused = false;
        const result = await drainLoop(
          agent.chatStream(
            'Create a persistent Goal now using CreateGoal, with objective "Inspect the project later". ' +
              'After the tool succeeds, reply exactly GOAL_CREATED. Do not do any other work.',
            context,
            { stream: true }
          ),
          async (event) => {
            events.push(event);
            if (
              event.kind === 'tool_result' &&
              'function' in event.toolCall &&
              event.toolCall.function.name === 'CreateGoal' &&
              event.result.success
            ) {
              await runtime.pauseGoal('paused during initiating turn');
              paused = true;
            }
          }
        );
        expect(paused).toBe(true);
        expect(result.success).toBe(true);
        expect(result.metadata?.tokensUsed).toBeGreaterThan(0);
        await expect(runtime.getGoal()).resolves.toMatchObject({
          status: 'paused',
          statusReason: 'paused during initiating turn',
          tokensUsed: result.metadata?.tokensUsed,
        });
        expect(
          events.filter((event) => event.kind === 'goal_continuation_started')
        ).toHaveLength(0);
      } finally {
        agent.destroy();
        await runtime.dispose();
        if (previousConfig) getState().config.actions.setConfig(previousConfig);
      }
    }, 180_000);
    for (const {
      surface,
      settlementState,
      directSchemas,
      skillSchemas,
    } of surfaces.flatMap((surface) =>
      settlementCases.map((scenario) => ({ surface, ...scenario }))
    )) {
      it(`${model.model} settles ${settlementState} usage through ${surface} without resuming over budget${directSchemas ? ' with direct schemas' : skillSchemas ? ' with Skill schemas' : ''}`, async (context: TestContext) => {
        const retry = context.task.retry;
        expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
        await access(cliEntry);
        const test = await createFixture(
          model,
          settlementState,
          directSchemas,
          skillSchemas
        );
        try {
          if (surface === 'headless') await runHeadless(test, model.apiKey);
          else if (surface === 'acp') await runAcp(test, model.apiKey);
          else if (surface === 'pty') {
            const host = startChild(
              'bun',
              [
                path.resolve(
                  import.meta.dirname,
                  '../../support/goalPausedUsagePtyRunner.ts'
                ),
              ],
              test.workspace,
              {
                ...test.env,
                BLADE_GOAL_PAUSED_USAGE_PTY_INPUT: Buffer.from(
                  JSON.stringify({
                    cliEntry,
                    workspace: test.workspace,
                    home: test.home,
                    storageRoot: test.storageRoot,
                    sessionId: test.sessionId,
                    readyFile: test.readyFile,
                    releaseFile: test.releaseFile,
                    secret: model.apiKey,
                    settlementState,
                    directSchemas,
                    skillSchemas,
                    followUpReadyFile: test.followUpReadyFile,
                    followUpPrompt,
                    followUpMarker,
                  })
                ).toString('base64'),
              }
            );
            if (!host.child.pid) throw new Error('PTY runner has no PID');
            const identity = await captureForegroundGuiLauncherIdentity(host.child.pid);
            try {
              await waitFor(
                () => host.child.exitCode !== null || host.child.signalCode !== null,
                'PTY runner timed out',
                240_000
              );
              const evidence: unknown = JSON.parse(host.stdout());
              expect(evidence, JSON.stringify(evidence)).toMatchObject({
                success: true,
                tokensUsed: test.tokens(),
              });
              expect(await host.exited).toBe(0);
              expect(host.stdout() + host.stderr()).not.toContain(model.apiKey);
            } finally {
              await stopForegroundGuiLauncher(host.child, identity);
            }
          } else await runWeb(test, surface === 'web-development', model.apiKey);
          await expect(test.store.get()).resolves.toMatchObject({
            status: 'budget_limited',
            tokensUsed: test.tokens(),
            continuationCount: 1,
          });
          expect(test.requests()).toBe(settlementState === 'blocked' ? 2 : 1);
          expect(test.tokens()).toBeGreaterThan(1);
          expect(test.skillActivated()).toBe(skillSchemas);
          expect(test.followUpRequests()).toBe(skillSchemas ? 1 : 0);
          expect(test.followUpCompleted()).toBe(skillSchemas);
          console.log(
            'GOAL_PAUSED_USAGE_EVIDENCE',
            JSON.stringify({
              model: model.model,
              surface,
              settlementState,
              directSchemas,
              skillSchemas,
              tokens: test.tokens(),
              requests: test.requests(),
              discoveryRequests: test.discoveryRequests(),
            })
          );
        } finally {
          await test.close();
        }
      }, 300_000);
    }
  }
});
