import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';

export interface GoalFinalizationWebEvidence {
  initialVisible: true;
  completeGoalVisible: true;
  followupVisible: true;
  visibleAfterReload: true;
  browserFaults: [];
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
    throw new Error('Unable to reserve Goal finalization browser port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Goal finalization Web server did not become ready');
}

async function waitForInboxRemoval(
  workspace: string,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  const inboxPath = getSessionInboxFilePath(workspace, sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(inboxPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Web Goal finalization did not acknowledge its durable inbox');
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-16_384);
}

export async function runGoalFinalizationWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  expectedInitial: string;
  followupPrompt: string;
  expectedFollowup: string;
  secret: string;
  timeoutMs?: number;
}): Promise<GoalFinalizationWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const port = await reservePort();
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const child = spawn(
    process.execPath,
    [cliEntry, '--trust-workspace', 'serve', '--port', String(port)],
    {
      cwd: input.workspace,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let identity: ProcessIdentity | undefined;
  let serverOutput = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    serverOutput = appendTail(serverOutput, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    serverOutput = appendTail(serverOutput, chunk);
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closing = false;
  let refreshing = false;
  const faults: string[] = [];
  try {
    if (!child.pid) throw new Error('Goal finalization Web server has no process ID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin, 20_000);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(`console:${message.text()}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        faults.push(`http:${response.status()}:${response.url()}`);
      }
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
        faults.push(`requestfailed:${failure.errorText}:${failure.url}`);
      }
    });

    const navigation = new URL(origin);
    navigation.searchParams.set('session', input.sessionId);
    navigation.searchParams.set('project', input.workspace);
    await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    const initial = page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.expectedInitial })
      .last();
    await initial.waitFor({ state: 'visible', timeout: timeoutMs });
    await page
      .locator('[data-blade-goal-status="complete"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
    if ((await page.locator('body').textContent())?.includes(input.secret)) {
      throw new Error('Provider credential reached the Goal finalization DOM');
    }

    await composer.fill(input.followupPrompt);
    await composer.press('Enter');
    const followup = page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.expectedFollowup })
      .last();
    await followup.waitFor({ state: 'visible', timeout: timeoutMs });

    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await initial.waitFor({ state: 'visible', timeout: 30_000 });
    await followup.waitFor({ state: 'visible', timeout: 30_000 });
    await page
      .locator('[data-blade-goal-status="complete"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(500);
    if (faults.length > 0) {
      throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
    }
    return {
      initialVisible: true,
      completeGoalVisible: true,
      followupVisible: true,
      visibleAfterReload: true,
      browserFaults: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message.replaceAll(input.secret, '[REDACTED]')}; server=${serverOutput
        .replaceAll(input.secret, '[REDACTED]')
        .slice(-2_000)}`
    );
  } finally {
    closing = true;
    await browser?.close().catch(() => undefined);
    await stopForegroundGuiLauncher(child, identity);
  }
}
