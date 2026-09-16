import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
  vi,
} from 'vitest';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';
import type { GoalTurnLineage } from '../../../src/goals/types.js';
import {
  reserveLoopbackPort as reservePort,
  waitForCondition as waitFor,
} from '../../support/asyncTestUtils.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import {
  createGoalTurnLineageFixture,
  type GoalTurnLineageFixture,
  goalTurnLineageEnvironment,
} from '../../support/goalTurnLineageFixture.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

vi.unmock('node:child_process');

const enabled = isRealApiTestEnabled();
const releaseMatrixEnabled = process.env.REAL_API_RELEASE_MATRIX === '1' && enabled;
const models = releaseMatrixEnabled ? resolveRequiredDeepSeekQualificationModels() : [];
const surfaces = ['headless', 'acp', 'pty', 'web'] as const;
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
if (releaseMatrixEnabled && matrix.length !== 8) {
  throw new Error(
    `Goal turn lineage matrix must contain 8 cells, got ${matrix.length}`
  );
}

const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../../support/goalTurnLineageAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/goalTurnLineagePtyRunner.ts'
);
const roots: string[] = [];
let createHttpServer: typeof import('node:http').createServer;

function frameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const redact = (value: string): string => {
      const secret = options.env.BLADE_API_KEY;
      return secret ? value.replaceAll(secret, '[redacted]') : value;
    };
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
      reject(
        new Error(
          'Goal turn lineage child timed out; stdout=' +
            redact(stdout.slice(-8000)) +
            '; stderr=' +
            redact(stderr.slice(-8000))
        )
      );
    }, options.timeoutMs ?? 90_000);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-1024 * 1024);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseJsonl(output: string): Array<Record<string, unknown>> {
  return output.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

beforeAll(async () => {
  await access(cliEntry);
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

afterEach(async () => {
  resetProjectionDbCache();
  await Promise.all(roots.splice(0).map((root) => removeTestDirectory(root)));
});

async function assertDurableLineage(
  test: GoalTurnLineageFixture
): Promise<GoalTurnLineage> {
  const previous = process.env.BLADE_STORAGE_ROOT;
  process.env.BLADE_STORAGE_ROOT = test.storageRoot;
  resetProjectionDbCache();
  try {
    const goal = await new GoalStore(test.workspace, test.sessionId).get();
    expect(goal).toMatchObject({
      status: 'blocked',
      continuationCount: 4,
      turnLineage: {
        rootTurnId: test.expectedBeforeResume.rootTurnId,
        parentTurnId: expect.any(String),
        currentTurnId: expect.any(String),
      },
    });
    const lineage = goal?.turnLineage;
    if (!lineage) throw new Error('Final Goal lineage is missing');
    const events =
      (await new PersistentStore(test.workspace).loadEvents(test.sessionId)) ?? [];
    const boundStarts = events.flatMap((event) =>
      event.type === 'turn_started' && event.data.goalLineage
        ? [event.data.goalLineage]
        : []
    );
    expect(boundStarts).toHaveLength(5);
    expect(boundStarts[0]).toEqual({
      goalId: goal.goalId,
      rootTurnId: test.expectedBeforeResume.rootTurnId,
      currentTurnId: test.expectedBeforeResume.parentTurnId,
      parentTurnId: test.expectedBeforeResume.rootTurnId,
    });
    expect(boundStarts[1]).toEqual({
      goalId: goal.goalId,
      rootTurnId: test.expectedBeforeResume.rootTurnId,
      currentTurnId: test.expectedBeforeResume.currentTurnId,
      parentTurnId: test.expectedBeforeResume.parentTurnId,
    });
    for (let index = 2; index < boundStarts.length; index++) {
      expect(boundStarts[index]).toEqual({
        goalId: goal.goalId,
        rootTurnId: test.expectedBeforeResume.rootTurnId,
        currentTurnId: expect.any(String),
        parentTurnId: boundStarts[index - 1]?.currentTurnId,
      });
    }
    expect(boundStarts.at(-1)).toEqual({ goalId: goal.goalId, ...lineage });
    expect(JSON.stringify({ goal, boundStarts })).not.toContain(test.secret);
    expect(test.provider.requestCount()).toBe(6);
    expect(test.provider.forwardedCount()).toBe(3);
    expect(test.provider.requiredToolCallCount()).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(test.provider.requestCount()).toBe(6);
    return lineage;
  } finally {
    resetProjectionDbCache();
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }
}

async function createFixture(model: TestModelConfig): Promise<GoalTurnLineageFixture> {
  if (!model.baseURL) throw new Error(`Missing base URL for ${model.model}`);
  const config = buildRealApiRuntimeConfig(model);
  const fixture = await createGoalTurnLineageFixture(createHttpServer, {
    config,
    apiKey: model.apiKey,
    upstreamBaseUrl: model.baseURL,
  });
  roots.push(fixture.root);
  return fixture;
}

async function waitForHttp(origin: string): Promise<void> {
  await waitFor(async () => {
    try {
      return (await fetch(origin + '/health')).ok;
    } catch {
      return false;
    }
  }, 'Goal turn lineage Web server did not become ready');
}

const describeTrajectory =
  releaseMatrixEnabled && process.platform !== 'win32'
    ? describe.sequential
    : describe.skip;

describeTrajectory('Goal turn lineage surface matrix (real API)', () => {
  it.skipIf(releaseMatrixEnabled)(
    'requires the real API release matrix',
    () => undefined
  );

  for (const { model, surface } of matrix) {
    it(`${model.model} projects exact Goal lineage through ${surface}`, async (context) => {
      expect(frameworkRetryBudget(context)).toBe(0);
      const configured = buildRealApiRuntimeConfig(model).models[0];
      expect(configured?.overrides?.maxRetries ?? 0).toBe(0);
      const test = await createFixture(model);
      const environment = goalTurnLineageEnvironment(test);
      try {
        if (surface === 'headless') {
          const result = await runChild(
            process.execPath,
            [
              cliEntry,
              '--headless',
              '--output-format',
              'jsonl',
              '--resume',
              test.sessionId,
              '--permission-mode',
              'yolo',
              '--max-turns',
              '3',
              '--allowed-tools',
              'Bash,Read,UpdateGoal',
              '--no-verification-agent',
            ],
            {
              cwd: test.workspace,
              env: environment,
              timeoutMs: 240_000,
            }
          );
          if (result.signal || result.code !== 0) {
            throw new Error(
              'Headless goal host failure exited ' +
                (result.code ?? result.signal) +
                ': ' +
                result.stderr.replaceAll(test.secret, '[redacted]')
            );
          }
          const lineage = await assertDurableLineage(test);
          const events = parseJsonl(result.stdout);
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'goal',
                status: 'blocked',
                root_turn_id: lineage.rootTurnId,
                current_turn_id: lineage.currentTurnId,
                parent_turn_id: lineage.parentTurnId,
              }),
            ])
          );
          expect(result.stdout + '\n' + result.stderr).not.toContain(test.secret);
        } else if (surface === 'acp') {
          const encoded = Buffer.from(
            JSON.stringify({
              cliEntry,
              workspace: test.workspace,
              home: test.home,
              storageRoot: test.storageRoot,
              sessionId: test.sessionId,
              secret: test.secret,
            })
          ).toString('base64');
          const result = await runChild('bun', [acpRunner], {
            cwd: path.resolve(import.meta.dirname, '../..'),
            env: {
              ...environment,
              BLADE_GOAL_TURN_LINEAGE_ACP_INPUT: encoded,
            },
            timeoutMs: 240_000,
          });
          if (result.signal || result.code !== 0) {
            const previous = process.env.BLADE_STORAGE_ROOT;
            process.env.BLADE_STORAGE_ROOT = test.storageRoot;
            resetProjectionDbCache();
            const goal = await new GoalStore(test.workspace, test.sessionId).get();
            resetProjectionDbCache();
            if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
            else process.env.BLADE_STORAGE_ROOT = previous;
            throw new Error(
              'ACP goal host failure exited ' +
                (result.code ?? result.signal) +
                ': ' +
                [result.stdout, result.stderr]
                  .join('')
                  .replaceAll(test.secret, '[redacted]') +
                '; diagnostics=' +
                JSON.stringify({
                  requestCount: test.provider.requestCount(),
                  forwardedCount: test.provider.forwardedCount(),
                  requiredToolCallCount: test.provider.requiredToolCallCount(),
                  goalStatus: goal?.status,
                  goalReason: goal?.statusReason,
                })
            );
          }
          const evidence = JSON.parse(result.stdout) as {
            success: boolean;
            continuationLineage: unknown;
            goalLineage: unknown;
          };
          const lineage = await assertDurableLineage(test);
          expect(evidence).toMatchObject({
            success: true,
            continuationLineage: lineage,
            goalLineage: lineage,
          });
          expect([result.stdout, result.stderr].join('')).not.toContain(test.secret);
        } else if (surface === 'pty') {
          const encoded = Buffer.from(
            JSON.stringify({
              cliEntry,
              workspace: test.workspace,
              home: test.home,
              storageRoot: test.storageRoot,
              sessionId: test.sessionId,
              secret: test.secret,
            })
          ).toString('base64');
          const result = await runChild('bun', [ptyRunner], {
            cwd: path.resolve(import.meta.dirname, '../..'),
            env: {
              ...environment,
              BLADE_GOAL_TURN_LINEAGE_PTY_INPUT: encoded,
            },
            timeoutMs: 240_000,
          });
          if (result.signal || result.code !== 0) {
            let evidence = result.stdout;
            try {
              const parsed = JSON.parse(result.stdout) as {
                error?: unknown;
                output?: unknown;
              };
              evidence = JSON.stringify(parsed);
            } catch {
              // Preserve raw runner output for diagnostics.
            }
            throw new Error(
              'PTY goal host failure exited ' +
                (result.code ?? result.signal) +
                ': ' +
                [evidence, result.stderr].join('').replaceAll(test.secret, '[redacted]')
            );
          }
          const evidence = JSON.parse(result.stdout) as {
            success: boolean;
            blocked: boolean;
            fullLineage: boolean;
            lineage: unknown;
          };
          const lineage = await assertDurableLineage(test);
          expect(evidence).toMatchObject({
            success: true,
            blocked: true,
            fullLineage: true,
            lineage,
          });
          expect([result.stdout, result.stderr].join('')).not.toContain(test.secret);
        } else {
          const port = await reservePort();
          const server = spawn(
            process.execPath,
            [cliEntry, '--trust-workspace', 'serve', '--port', String(port)],
            {
              cwd: test.workspace,
              env: environment,
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          let identity;
          let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
          let output = '';
          let closing = false;
          let refreshing = false;
          const faults: string[] = [];
          server.stdout?.on('data', (chunk) => {
            output = (output + chunk.toString()).slice(-64_000);
          });
          server.stderr?.on('data', (chunk) => {
            output = (output + chunk.toString()).slice(-64_000);
          });
          try {
            if (!server.pid) throw new Error('Goal turn lineage Web server has no PID');
            identity = await captureForegroundGuiLauncherIdentity(server.pid);
            const origin = 'http://127.0.0.1:' + port;
            await waitForHttp(origin);
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            page.on('pageerror', (error) => faults.push('pageerror:' + error.message));
            page.on('console', (message) => {
              if (message.type() === 'error') faults.push('console:' + message.text());
            });
            page.on('requestfailed', (request) => {
              if (closing) return;
              const errorText = request.failure()?.errorText ?? 'unknown';
              if (
                !isExpectedBrowserRequestFailure({
                  url: request.url(),
                  resourceType: request.resourceType(),
                  errorText,
                  refreshing,
                  closing,
                })
              ) {
                faults.push('requestfailed:' + errorText + ':' + request.url());
              }
            });
            const url = new URL(origin);
            url.searchParams.set('session', test.sessionId);
            url.searchParams.set('project', test.workspace);
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            const selector =
              '[data-blade-goal-status="blocked"]' +
              '[data-blade-goal-root-turn="' +
              test.expectedBeforeResume.rootTurnId +
              '"]';
            const section = page.locator(selector);
            await section.waitFor({ state: 'visible', timeout: 240_000 });
            const currentTurnId = await section.getAttribute(
              'data-blade-goal-current-turn'
            );
            const parentTurnId = await section.getAttribute(
              'data-blade-goal-parent-turn'
            );
            expect(currentTurnId).toBeTruthy();
            expect(parentTurnId).toBeTruthy();
            refreshing = true;
            await page.reload({ waitUntil: 'domcontentloaded' });
            refreshing = false;
            const restored = page.locator(selector);
            await restored.waitFor({ state: 'visible', timeout: 30_000 });
            expect(await restored.getAttribute('data-blade-goal-current-turn')).toBe(
              currentTurnId
            );
            const lineage = await assertDurableLineage(test);
            expect(currentTurnId).toBe(lineage.currentTurnId);
            expect(parentTurnId).toBe(lineage.parentTurnId);
            expect(await page.locator('body').textContent()).not.toContain(test.secret);
            expect(output).not.toContain(test.secret);
            expect(faults).toEqual([]);
          } finally {
            closing = true;
            await browser?.close().catch(() => undefined);
            await stopForegroundGuiLauncher(server, identity);
          }
        }
      } finally {
        await test.provider.close();
      }
    }, 360_000);
  }
});
