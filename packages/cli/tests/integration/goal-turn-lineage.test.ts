import { type ChildProcess, spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import { GoalStore } from '../../src/goals/GoalStore.js';
import type { GoalTurnLineage } from '../../src/goals/types.js';
import { reserveLoopbackPort as reservePort } from '../support/asyncTestUtils.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from '../support/foregroundBoundedOutputWebDriver.js';
import {
  createGoalTurnLineageFixture,
  type GoalTurnLineageFixture,
  goalTurnLineageEnvironment,
} from '../support/goalTurnLineageFixture.js';

vi.unmock('node:child_process');

const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../support/goalTurnLineageAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../support/goalTurnLineagePtyRunner.ts'
);
const roots: string[] = [];
let createHttpServer: typeof import('node:http').createServer;

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
            stdout.slice(-8_000) +
            '; stderr=' +
            stderr.slice(-8_000)
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
    expect(lineage.currentTurnId).not.toBe(lineage.parentTurnId);

    const events =
      (await new PersistentStore(test.workspace).loadEvents(test.sessionId)) ?? [];
    const boundStarts = events.flatMap((event) =>
      event.type === 'turn_started' && event.data.goalLineage
        ? [event.data.goalLineage]
        : []
    );
    expect(boundStarts).toHaveLength(5);
    expect(boundStarts[0]).toEqual({
      goalId: goal?.goalId,
      rootTurnId: test.expectedBeforeResume.rootTurnId,
      currentTurnId: test.expectedBeforeResume.parentTurnId,
      parentTurnId: test.expectedBeforeResume.rootTurnId,
    });
    expect(boundStarts[1]).toEqual({
      goalId: goal?.goalId,
      rootTurnId: test.expectedBeforeResume.rootTurnId,
      currentTurnId: test.expectedBeforeResume.currentTurnId,
      parentTurnId: test.expectedBeforeResume.parentTurnId,
    });
    for (let index = 2; index < boundStarts.length; index++) {
      expect(boundStarts[index]).toEqual({
        goalId: goal?.goalId,
        rootTurnId: test.expectedBeforeResume.rootTurnId,
        currentTurnId: expect.any(String),
        parentTurnId: boundStarts[index - 1]?.currentTurnId,
      });
    }
    expect(boundStarts.at(-1)).toEqual({ goalId: goal?.goalId, ...lineage });
    expect(JSON.stringify({ goal, boundStarts })).not.toContain(test.secret);
    expect(test.provider.requestCount()).toBe(6);
    return lineage;
  } finally {
    resetProjectionDbCache();
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }
}

async function waitForHttp(origin: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin + '/health')).ok) return;
    } catch {
      // Production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Goal turn lineage Web server did not become ready');
}

beforeAll(async () => {
  await access(cliEntry);
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

afterEach(async () => {
  resetProjectionDbCache();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe
  .skipIf(process.platform === 'win32')
  .sequential('durable Goal turn lineage production surfaces', () => {
    it('projects the exact chain through Headless JSONL', async () => {
      const test = await createGoalTurnLineageFixture(createHttpServer);
      roots.push(test.root);
      try {
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
            env: goalTurnLineageEnvironment(test),
            timeoutMs: 30_000,
          }
        );
        if (result.signal || result.code !== 0) {
          throw new Error(
            'Headless lineage exited ' +
              (result.code ?? result.signal) +
              ': ' +
              result.stderr
          );
        }
        const lineage = await assertDurableLineage(test);
        expect(parseJsonl(result.stdout)).toEqual(
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
        expect(result.stdout + result.stderr).not.toContain(test.secret);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('projects the exact chain through ACP stdio metadata', async () => {
      const test = await createGoalTurnLineageFixture(createHttpServer);
      roots.push(test.root);
      try {
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
          env: { ...process.env, BLADE_GOAL_TURN_LINEAGE_ACP_INPUT: encoded },
          timeoutMs: 90_000,
        });
        if (result.signal || result.code !== 0) {
          throw new Error(
            'ACP lineage exited ' +
              (result.code ?? result.signal) +
              ': ' +
              result.stderr
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
        expect(result.stdout + result.stderr).not.toContain(test.secret);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('renders bounded and complete lineage through a raw PTY TUI', async () => {
      const test = await createGoalTurnLineageFixture(createHttpServer);
      roots.push(test.root);
      try {
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
          env: { ...process.env, BLADE_GOAL_TURN_LINEAGE_PTY_INPUT: encoded },
          timeoutMs: 90_000,
        });
        if (result.signal || result.code !== 0) {
          throw new Error(
            'PTY lineage exited ' +
              (result.code ?? result.signal) +
              ': ' +
              result.stderr
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
        expect(result.stdout + result.stderr).not.toContain(test.secret);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('rehydrates the exact lineage in production Chromium', async () => {
      const test = await createGoalTurnLineageFixture(createHttpServer);
      roots.push(test.root);
      const port = await reservePort();
      const server = spawn(
        process.execPath,
        [cliEntry, '--trust-workspace', 'serve', '--port', String(port)],
        {
          cwd: test.workspace,
          env: goalTurnLineageEnvironment(test),
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
        if (!server.pid) throw new Error('Goal lineage Web server has no PID');
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
          const failure = {
            url: request.url(),
            resourceType: request.resourceType(),
            errorText: request.failure()?.errorText ?? 'unknown',
            refreshing,
            closing,
          };
          if (!isExpectedBrowserRequestFailure(failure)) {
            faults.push('requestfailed:' + failure.errorText + ':' + failure.url);
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
        await section.waitFor({ state: 'visible', timeout: 60_000 });
        const currentTurnId = await section.getAttribute(
          'data-blade-goal-current-turn'
        );
        const parentTurnId = await section.getAttribute('data-blade-goal-parent-turn');
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
        await test.provider.close();
      }
    }, 150_000);
  });
