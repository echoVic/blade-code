import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
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
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionSchema } from '../../../src/api/schemas.js';
import { runHeadless } from '../../../src/commands/headless.js';
import {
  createBenchmarkWorkspace,
  DEFAULT_REAL_REPO_BENCHMARK_CASES,
  verifyBenchmarkWorkspace,
} from '../../../src/commands/headlessBenchmark.js';
import {
  type HeadlessJsonlEvent,
  HeadlessJsonlEventSchema,
} from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { createSplitPtyMarkerInstruction } from '../../support/foregroundBoundedOutputPtyDriver.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { createTuiTaskAttentionRunnerEnvironment } from '../../support/tuiTaskAttentionPtyDriver.js';
import {
  assertNoSecrets,
  extractDurableToolTrace,
  findSessionTranscript,
  inspectFinalAssistantText,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const modelConfigs = isRealApiTestEnabled()
  ? process.env.REAL_API_RELEASE_MATRIX === '1'
    ? resolveRequiredDeepSeekQualificationModels()
    : expandDeepSeekModelMatrix(
        getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
      )
  : [];
const enabled = modelConfigs.length > 0;
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');

async function reserveCodingPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Coding server port unavailable');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitForCoding(
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

function codingResultEvents(events: readonly SessionEvent[]): HeadlessJsonlEvent[] {
  const trace = new Map(
    extractDurableToolTrace(events).map((call) => [call.toolCallId, call])
  );
  return events.flatMap((event): HeadlessJsonlEvent[] => {
    if (event.type !== 'part_created' || event.data.partType !== 'tool_result')
      return [];
    const payload = event.data.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.toolCallId !== 'string'
    )
      throw new Error('Invalid coding tool result');
    const call = trace.get(payload.toolCallId);
    if (!call) throw new Error('Coding tool result has no matching call');
    const args =
      call.input && typeof call.input === 'object'
        ? (call.input as Record<string, unknown>)
        : {};
    const target =
      call.toolName === 'Bash' ? args.command : (args.file_path ?? args.path);
    return [
      {
        event_version: 1,
        type: 'tool_result',
        tool_name: call.toolName,
        summary: call.toolName,
        success: call.error === null && call.output !== null,
        ...(typeof target === 'string' ? { target } : {}),
      },
    ];
  });
}

const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe('coding result commit ordering', () => {
  it('uses completion order rather than invocation order for verification', () => {
    const part = (
      id: string,
      kind: 'tool_call' | 'tool_result',
      toolCallId: string,
      toolName: string
    ): SessionEvent => ({
      id,
      type: 'part_created',
      sessionId: 'coding',
      timestamp: '2026-09-14T00:00:00.000Z',
      cwd: '/workspace',
      version: '1',
      data: {
        partId: id,
        messageId: 'assistant',
        partType: kind,
        createdAt: '2026-09-14T00:00:00.000Z',
        payload: {
          toolCallId,
          toolName,
          ...(kind === 'tool_call'
            ? {
                input:
                  toolName === 'Bash'
                    ? { command: 'npm test' }
                    : { file_path: 'src/discount.js' },
              }
            : { output: 'done', error: null }),
        },
      },
    });
    const events = [
      part('call-edit', 'tool_call', 'edit', 'Edit'),
      part('call-test', 'tool_call', 'test', 'Bash'),
      part('result-test', 'tool_result', 'test', 'Bash'),
      part('result-edit', 'tool_result', 'edit', 'Edit'),
    ];
    expect(
      codingResultEvents(events).map((event) =>
        event.type === 'tool_result' ? event.tool_name : ''
      )
    ).toEqual(['Bash', 'Edit']);
  });
});

describe.skipIf(!enabled || process.platform === 'win32')(
  'cross-surface coding workflow (real API)',
  () => {
    for (const model of modelConfigs)
      for (const surface of [
        'web-production',
        'web-development',
        'pty',
        'acp',
      ] as const) {
        it(`${model.model} migrates both modules through ${surface}`, {
          timeout: 300_000,
        }, async (context) => {
          const retry = context.task.retry;
          expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
          if (!model.baseURL) throw new Error('Missing coding Provider');
          const root = await realpath(
            await mkdtemp(path.join(os.tmpdir(), 'blade-coding-surface-'))
          );
          const workspace = path.join(root, 'workspace');
          const home = path.join(root, 'home');
          const storageRoot = path.join(root, 'storage');
          const before = await createBenchmarkWorkspace(workspace, 'cross_module_fix');
          const proxy = await startRecordingProviderProxy(model.baseURL);
          const marker = `MIGRATION_DONE_${surface.replaceAll('-', '_').toUpperCase()}`;
          const task = DEFAULT_REAL_REPO_BENCHMARK_CASES.find(
            (entry) => entry.id === 'cross_module_fix'
          );
          if (!task) throw new Error('Missing migration task');
          const prompt = `${task.prompt}\nUse Edit or Write to update each source file. Reserve Bash for verification, not file reads or mutations. Bash already starts in the project directory. Its verification command must be exactly npm test: no cd prefix, shell wrapper, redirection, or extra flags.\n${createSplitPtyMarkerInstruction(marker)}`;
          const config = buildRealApiRuntimeConfig({
            ...model,
            baseURL: proxy.baseUrl,
          });
          const children: Array<{
            child: ChildProcess;
            identity?: Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>;
          }> = [];
          let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
          let acpToolUpdates: Array<{ id: string; status?: string | null }> | undefined;
          let sessionId = `coding-${surface}-${Date.now()}`;
          const errors: unknown[] = [];
          try {
            await mkdir(path.join(home, '.blade'), { recursive: true, mode: 0o700 });
            await writeFile(
              path.join(home, '.blade', 'config.json'),
              JSON.stringify({
                currentModelId: config.currentModelId,
                models: config.models.map((entry) => ({
                  ...entry,
                  overrides: { ...entry.overrides, maxRetries: 1 },
                })),
                modelProviders: config.modelProviders,
                permissionMode: 'yolo',
                maxTurns: 16,
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {},
                lspServers: {},
              }),
              { mode: 0o600 }
            );
            if (surface === 'pty' || surface === 'acp') {
              const envName =
                surface === 'pty'
                  ? 'BLADE_TURN_ACTIVITY_PTY_INPUT'
                  : 'BLADE_TURN_ACTIVITY_ACP_INPUT';
              const result = await execFileAsync(
                'bun',
                [
                  path.resolve(
                    import.meta.dirname,
                    `../../support/${surface === 'pty' ? 'turnActivityPtyRunner.ts' : 'turnActivityAcpRunner.ts'}`
                  ),
                ],
                {
                  cwd: path.resolve(import.meta.dirname, '../../..'),
                  timeout: 240_000,
                  maxBuffer: 1024 * 1024,
                  env: createTuiTaskAttentionRunnerEnvironment(process.env, {
                    [envName]: Buffer.from(
                      JSON.stringify({
                        cliEntry,
                        workspace,
                        home,
                        storageRoot,
                        sessionId,
                        prompt,
                        marker,
                        secret: model.apiKey,
                        codingTask: true,
                        maxTurns: 16,
                        allowedTools: 'Read,Glob,Grep,Edit,Write,Bash',
                        releaseFile: path.join(root, 'unused'),
                      })
                    ).toString('base64'),
                  }),
                }
              );
              const evidence = JSON.parse(result.stdout) as {
                success: boolean;
                sessionId?: string;
                activeTerminals?: number;
                toolUpdates?: Array<{ id: string; status?: string | null }>;
              };
              expect(evidence.success).toBe(true);
              if (surface === 'acp') {
                expect(evidence.activeTerminals).toBe(0);
                if (!evidence.sessionId) throw new Error('Missing ACP coding Session');
                sessionId = evidence.sessionId;
                expect(evidence.toolUpdates).toBeDefined();
                acpToolUpdates = evidence.toolUpdates;
              }
              assertNoSecrets({ evidence, stderr: result.stderr }, [model.apiKey]);
            } else {
              const launch = async (
                args: string[],
                cwd: string,
                extra: NodeJS.ProcessEnv = {}
              ) => {
                const child = spawn(process.execPath, args, {
                  cwd,
                  env: {
                    ...createTuiTaskAttentionRunnerEnvironment(process.env, {
                      HOME: home,
                      BLADE_STORAGE_ROOT: storageRoot,
                      BLADE_AUTO_MEMORY: '0',
                      BLADE_TELEMETRY_DISABLED: '1',
                    }),
                    BLADE_API_KEY: model.apiKey,
                    ...extra,
                  },
                  detached: true,
                  stdio: ['ignore', 'pipe', 'pipe'],
                });
                const owned: (typeof children)[number] = { child };
                children.push(owned);
                child.stdout?.resume();
                child.stderr?.resume();
                if (!child.pid) throw new Error('Coding server did not start');
                owned.identity = await captureForegroundGuiLauncherIdentity(child.pid);
              };
              const port = await reserveCodingPort();
              const origin = `http://127.0.0.1:${port}`;
              await launch(
                [
                  cliEntry,
                  '--trust-workspace',
                  'serve',
                  '--hostname',
                  '127.0.0.1',
                  '--port',
                  String(port),
                ],
                workspace
              );
              const ready = async (url: string) =>
                waitForCoding(
                  async () => {
                    try {
                      return (await fetch(url)).ok;
                    } catch {
                      return false;
                    }
                  },
                  'Coding server not ready',
                  30_000
                );
              await ready(`${origin}/health`);
              let guiOrigin = origin;
              if (surface === 'web-development') {
                const webRoot = path.resolve(import.meta.dirname, '../../../web');
                const webPort = await reserveCodingPort();
                const dependencyRoot = await realpath(
                  path.resolve(webRoot, '../../../node_modules')
                );
                await launch(
                  [
                    '--input-type=module',
                    '--eval',
                    'import {createServer,searchForWorkspaceRoot} from "vite";' +
                      `const server=await createServer({server:{host:"127.0.0.1",port:${webPort},strictPort:true,fs:{allow:[searchForWorkspaceRoot(process.cwd()),${JSON.stringify(dependencyRoot)}]}}});await server.listen();`,
                  ],
                  webRoot,
                  { VITE_API_TARGET: origin }
                );
                guiOrigin = `http://127.0.0.1:${webPort}`;
                await ready(guiOrigin);
              }
              const response = await fetch(`${origin}/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  projectPath: workspace,
                  title: 'Cross-module migration',
                }),
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
              const url = new URL(guiOrigin);
              url.searchParams.set('session', sessionId);
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
              }
              const terminalHistory = page.waitForResponse(
                async (response) => {
                  if (
                    response.request().method() !== 'GET' ||
                    new URL(response.url()).pathname !==
                      `/sessions/${sessionId}/message` ||
                    !response.ok()
                  )
                    return false;
                  return (await response.text()).includes(marker);
                },
                { timeout: 180_000 }
              );
              await composer.fill(prompt);
              await page.locator('[data-blade-submit]').click();
              const [historyResponse] = await Promise.all([
                terminalHistory,
                page
                  .getByText(marker, { exact: true })
                  .waitFor({ state: 'visible', timeout: 180_000 }),
              ]);
              await page
                .locator('[data-turn-activity-strip]')
                .waitFor({ state: 'detached' });
              expect(await historyResponse.finished()).toBeNull();
              const collapsedGroups = page.locator(
                '[data-agent-tool-group] > button[aria-expanded="false"]'
              );
              const expansionDeadline = Date.now() + 30_000;
              while (await collapsedGroups.count()) {
                if (Date.now() >= expansionDeadline)
                  throw new Error('Coding tool groups did not settle');
                await collapsedGroups.first().click();
              }
              const durableTools = extractDurableToolTrace(
                readSessionEvents(findSessionTranscript(storageRoot, sessionId))
              );
              for (const tool of durableTools) {
                const toolId = await page.evaluate(
                  (value) => CSS.escape(value),
                  tool.toolCallId
                );
                const card = page
                  .locator(
                    `[data-tool-status="${tool.error === null ? 'success' : 'error'}"]`
                  )
                  .filter({
                    has: page.locator(`button[data-tool-call-id="${toolId}"]`),
                  });
                await card.waitFor({ state: 'visible' });
              }
              const toolEvidence = {
                durable: durableTools.map((tool) => ({
                  name: tool.toolName,
                  succeeded: tool.error === null && tool.output !== null,
                })),
                cards: await page.locator('[data-tool-status]').evaluateAll((cards) =>
                  cards.map((card) => ({
                    name: card.getAttribute('data-tool-name'),
                    status: card.getAttribute('data-tool-status'),
                  }))
                ),
              };
              console.log(
                `[coding-tool-evidence] ${JSON.stringify({ model: model.model, surface, ...toolEvidence })}`
              );
              expect(
                await page
                  .locator('[data-tool-status="success"][data-tool-name="Bash"]')
                  .count()
              ).toBeGreaterThan(0);
              expect(
                await page
                  .locator(
                    '[data-tool-status="success"][data-tool-name="Edit"], [data-tool-status="success"][data-tool-name="Write"]'
                  )
                  .count()
              ).toBeGreaterThanOrEqual(2);
              expect(faults).toEqual([]);
              assertNoSecrets(await page.content(), [model.apiKey]);
            }
            const transcript = findSessionTranscript(storageRoot, sessionId);
            await waitForCoding(
              () =>
                inspectFinalAssistantText(readSessionEvents(transcript)).state ===
                'ready',
              'Coding task did not commit'
            );
            const events = readSessionEvents(transcript);
            const final = inspectFinalAssistantText(events);
            expect(final.state !== 'structural_mismatch' && final.text === marker).toBe(
              true
            );
            expect(
              events.filter((event) => event.type === 'turn_completed')
            ).toHaveLength(1);
            expect(
              events.filter((event) => event.type === 'turn_aborted')
            ).toHaveLength(0);
            if (acpToolUpdates) {
              const completed = acpToolUpdates.filter(
                (update) => update.status === 'completed' || update.status === 'failed'
              );
              const trace = extractDurableToolTrace(events);
              expect(completed).toHaveLength(trace.length);
              for (const tool of trace)
                expect(completed).toContainEqual({
                  id: tool.toolCallId,
                  status: tool.error === null ? 'completed' : 'failed',
                });
            }
            const resultEvents = codingResultEvents(events);
            const verification = await verifyBenchmarkWorkspace({
              caseId: 'cross_module_fix',
              workspace,
              before,
              events: resultEvents,
            });
            expect(
              verification.passed,
              JSON.stringify({ verification, tools: resultEvents })
            ).toBe(true);
            expect(proxy.forwardedRequestNumbers.length).toBeGreaterThan(1);
            expect(proxy.injectedRequestNumbers).toEqual([]);
            expect(proxy.stopSequenceRequestNumbers).toEqual([]);
            expect(proxy.jsonOnlyRequestNumbers).toEqual([]);
            assertNoSecrets({ events, verification }, [model.apiKey]);
            console.log(
              `[cross-surface-coding] ${JSON.stringify({ model: model.model, surface, verification, requests: proxy.forwardedRequestNumbers.length })}`
            );
          } catch (error) {
            errors.push(error);
          } finally {
            const cleanup = await Promise.allSettled([
              browser?.close(),
              ...children.map((owned) =>
                stopForegroundGuiLauncher(owned.child, owned.identity)
              ),
              proxy.close(),
            ]);
            const failed = cleanup.filter((result) => result.status === 'rejected');
            errors.push(...failed.map((result) => result.reason));
            if (failed.length === 0) {
              await rm(root, { recursive: true, force: true }).catch((error) => {
                errors.push(error);
              });
            }
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length)
            throw new AggregateError(
              errors,
              'Coding surface execution or cleanup failed'
            );
        });
      }
  }
);

describe.skipIf(!enabled)('release coding trajectory (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} passes controlled benchmark host verification without touching the caller workspace`, {
      timeout: 900_000,
    }, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-benchmark-real-'));
      const caller = path.join(root, 'caller');
      const home = path.join(root, 'home');
      const historyPath = path.join(root, 'history.json');
      try {
        await mkdir(caller, { recursive: true });
        await mkdir(path.join(home, '.blade'), { recursive: true, mode: 0o700 });
        const sentinel = path.join(caller, 'untouched.txt');
        await writeFile(sentinel, 'CALLER_MUST_NOT_CHANGE\n');
        const config = buildRealApiRuntimeConfig(modelConfig);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          JSON.stringify({
            currentModelId: config.currentModelId,
            models: config.models,
            modelProviders: config.modelProviders,
          }),
          { mode: 0o600 }
        );
        const result = await execFileAsync(
          'bun',
          [
            path.resolve(
              import.meta.dirname,
              '../../../scripts/run-real-repo-benchmark.ts'
            ),
            '--model',
            config.currentModelId,
            '--history-path',
            historyPath,
          ],
          {
            cwd: caller,
            timeout: 840_000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              BLADE_STORAGE_ROOT: path.join(home, '.blade'),
              BLADE_API_KEY: modelConfig.apiKey,
            },
          }
        );
        const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
          version: number;
          runs: Array<{
            suite: string;
            summary: { successRate: number };
            results: Array<{
              caseId: string;
              success: boolean;
              verification: { passed: boolean; changedPaths: string[] };
            }>;
          }>;
        };
        expect(history.version).toBe(2);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0].suite).toBe('controlled-coding-v2');
        expect(
          history.runs[0].summary.successRate,
          JSON.stringify(history.runs[0].results)
        ).toBe(1);
        expect(
          history.runs[0].results.map((entry) => entry.verification.changedPaths)
        ).toEqual([[], ['src/math.js'], ['src/checkout.js', 'src/discount.js']]);
        expect(
          history.runs[0].results.every(
            (entry) => entry.success && entry.verification.passed
          )
        ).toBe(true);
        expect(await readdir(caller)).toEqual(['untouched.txt']);
        expect(await readFile(sentinel, 'utf8')).toBe('CALLER_MUST_NOT_CHANGE\n');
        expect(JSON.stringify(history) + result.stdout + result.stderr).not.toContain(
          modelConfig.apiKey
        );
        console.log(
          `[controlled-benchmark] ${JSON.stringify({ model: modelConfig.model, summary: history.runs[0].summary, results: history.runs[0].results })}`
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`${modelConfig.model} fixes and verifies a production Headless task`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-release-coding-'));
      let output = '';
      let errorOutput = '';

      try {
        process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
        getState().config.actions.setConfig({
          ...buildRealApiRuntimeConfig(modelConfig),
          permissionMode: PermissionMode.YOLO,
          maxQueuedTaskBytes: 64 * 1024,
        });
        await mkdir(path.join(workspace, 'src'), { recursive: true });
        await mkdir(path.join(workspace, 'test'), { recursive: true });
        await writeFile(
          path.join(workspace, 'package.json'),
          `${JSON.stringify({
            name: 'blade-release-coding-fixture',
            private: true,
            type: 'module',
            scripts: { test: 'node --test' },
          })}\n`
        );
        await writeFile(
          path.join(workspace, 'src', 'add.js'),
          [
            'export function add(left, right) {',
            '  return left - right;',
            '}',
            '',
          ].join('\n')
        );
        const originalTest = [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/add.js';",
          '',
          "test('adds two numbers', () => {",
          '  assert.equal(add(4, 3), 7);',
          '});',
          '',
        ].join('\n');
        await writeFile(path.join(workspace, 'test', 'add.test.js'), originalTest);

        const exitCode = await runWithCwdOverride(workspace, () =>
          runHeadless(
            {
              headless: true,
              outputFormat: 'jsonl',
              maxTurns: 12,
              taskIsolation: 'local',
              allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
              appendSystemPrompt:
                'After the source edit, call Bash with exactly "npm test". ' +
                'Do not finish before that command succeeds.',
              message:
                'Read src/add.js and test/add.test.js. Fix only src/add.js so ' +
                'add(4, 3) returns 7, then call Bash with exactly "npm test".',
            },
            {
              stdout: {
                write(chunk: string) {
                  output += chunk;
                  return true;
                },
              },
              stderr: {
                write(chunk: string) {
                  errorOutput += chunk;
                  return true;
                },
              },
            }
          )
        );
        const events = output
          .split('\n')
          .filter(Boolean)
          .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
        const toolNames = events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);

        expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
          0
        );
        expect(toolNames).toContain('Read');
        expect(toolNames.some((name) => name === 'Edit' || name === 'Write')).toBe(
          true
        );
        expect(toolNames).toContain('Bash');
        expect(await readFile(path.join(workspace, 'src', 'add.js'), 'utf8')).toContain(
          'return left + right;'
        );
        expect(
          await readFile(path.join(workspace, 'test', 'add.test.js'), 'utf8')
        ).toBe(originalTest);
        const verification = await execFileAsync(process.execPath, ['--test'], {
          cwd: workspace,
          timeout: 30_000,
        });
        expect(verification.stdout).toContain('pass 1');
        expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
