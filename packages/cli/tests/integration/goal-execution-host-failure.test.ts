import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import { GoalStore } from '../../src/goals/GoalStore.js';
import {
  reserveLoopbackPort as reservePort,
  waitForCondition as waitFor,
} from '../support/asyncTestUtils.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from '../support/foregroundBoundedOutputWebDriver.js';
import {
  createGoalExecutionHostFailureFixture,
  type GoalExecutionHostFailureFixture,
  goalExecutionHostFailureEnvironment,
  parseGoalHostJsonl,
} from '../support/goalExecutionHostFailureFixture.js';
import { removeTestDirectory } from '../support/helpers/removeTestDirectory.js';

vi.unmock('node:child_process');

const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../support/goalExecutionHostFailureAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../support/goalExecutionHostFailurePtyRunner.ts'
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
          'Goal host failure child timed out; stdout=' +
            stdout.slice(-8000) +
            '; stderr=' +
            stderr.slice(-8000)
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

beforeAll(async () => {
  await access(cliEntry);
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

afterEach(async () => {
  resetProjectionDbCache();
  await Promise.all(roots.splice(0).map((root) => removeTestDirectory(root)));
});

async function assertBlocked(test: GoalExecutionHostFailureFixture): Promise<void> {
  const previous = process.env.BLADE_STORAGE_ROOT;
  process.env.BLADE_STORAGE_ROOT = test.storageRoot;
  resetProjectionDbCache();
  try {
    await expect(
      new GoalStore(test.workspace, test.sessionId).get()
    ).resolves.toMatchObject({
      status: 'blocked',
      executionHostFailure: { category: 'timeout', consecutiveCount: 3 },
    });
  } finally {
    resetProjectionDbCache();
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }
  expect(test.provider.requestCount()).toBe(6);
}

async function waitForHttp(origin: string): Promise<void> {
  await waitFor(async () => {
    try {
      return (await fetch(origin + '/health')).ok;
    } catch {
      return false;
    }
  }, 'Goal host failure Web server did not become ready');
}

describe.skipIf(process.platform === 'win32')(
  'Goal execution-host failure production surfaces',
  () => {
    it('blocks the Headless Goal after three real Bash timeouts', async () => {
      const test = await createGoalExecutionHostFailureFixture(createHttpServer);
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
            '4',
            '--allowed-tools',
            'Bash',
            '--no-verification-agent',
          ],
          {
            cwd: test.workspace,
            env: goalExecutionHostFailureEnvironment(test),
            timeoutMs: 20_000,
          }
        );
        if (result.signal || result.code !== 0) {
          throw new Error(
            'Headless goal host failure exited ' +
              (result.code ?? result.signal) +
              ': ' +
              result.stderr
          );
        }
        const events = parseGoalHostJsonl(result.stdout);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'goal',
              status: 'active',
              execution_host_failure_category: 'timeout',
              execution_host_failure_count: 1,
            }),
            expect.objectContaining({
              type: 'goal',
              status: 'active',
              execution_host_failure_count: 2,
            }),
            expect.objectContaining({
              type: 'goal',
              status: 'blocked',
              execution_host_failure_count: 3,
            }),
          ])
        );
        expect(result.stdout + '\n' + result.stderr).not.toContain(test.secret);
        await assertBlocked(test);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('projects the durable guard through real ACP stdio', async () => {
      const test = await createGoalExecutionHostFailureFixture(createHttpServer);
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
          env: { ...process.env, BLADE_GOAL_HOST_FAILURE_ACP_INPUT: encoded },
          timeoutMs: 90_000,
        });
        if (result.signal || result.code !== 0) {
          throw new Error(
            'ACP goal host failure exited ' +
              (result.code ?? result.signal) +
              ': ' +
              result.stderr
          );
        }
        expect(JSON.parse(result.stdout)).toMatchObject({
          success: true,
          counts: expect.arrayContaining([1, 2, 3]),
          blocked: true,
          continuations: 3,
          terminalReleaseCount: 3,
        });
        expect([result.stdout, result.stderr].join('')).not.toContain(test.secret);
        await assertBlocked(test);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('renders the durable guard in a raw PTY TUI', async () => {
      const test = await createGoalExecutionHostFailureFixture(createHttpServer);
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
          env: { ...process.env, BLADE_GOAL_HOST_FAILURE_PTY_INPUT: encoded },
          timeoutMs: 45_000,
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
              [evidence, result.stderr].join('')
          );
        }
        expect(JSON.parse(result.stdout)).toMatchObject({
          success: true,
          sawFirst: true,
          sawSecond: true,
          blocked: true,
        });
        expect([result.stdout, result.stderr].join('')).not.toContain(test.secret);
        await assertBlocked(test);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('rehydrates count two and renders blocked in production Chromium', async () => {
      const test = await createGoalExecutionHostFailureFixture(createHttpServer, {
        holdRequestNumber: 5,
      });
      roots.push(test.root);
      const port = await reservePort();
      const server = spawn(
        process.execPath,
        [cliEntry, '--trust-workspace', 'serve', '--port', String(port)],
        {
          cwd: test.workspace,
          env: goalExecutionHostFailureEnvironment(test),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let identity;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let output = '';
      let closing = false;
      const faults: string[] = [];
      server.stdout?.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-64_000);
      });
      server.stderr?.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-64_000);
      });
      try {
        if (!server.pid) throw new Error('Goal host failure Web server has no PID');
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
              refreshing: false,
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
        await page
          .locator(
            '[data-blade-goal-execution-host-failure="timeout"]' +
              '[data-blade-goal-execution-host-failure-count="2"]'
          )
          .waitFor({ state: 'visible', timeout: 60_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page
          .locator('[data-blade-goal-execution-host-failure-count="2"]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        test.provider.releaseHeld();
        await page
          .locator(
            '[data-blade-goal-status="blocked"]' +
              '[data-blade-goal-execution-host-failure-count="3"]'
          )
          .waitFor({ state: 'visible', timeout: 60_000 });
        expect(await page.locator('body').textContent()).not.toContain(test.secret);
        expect(output).not.toContain(test.secret);
        expect(faults).toEqual([]);
        await assertBlocked(test);
      } finally {
        test.provider.releaseHeld();
        closing = true;
        await browser?.close().catch(() => undefined);
        await stopForegroundGuiLauncher(server, identity);
        await test.provider.close();
      }
    }, 150_000);
  }
);
