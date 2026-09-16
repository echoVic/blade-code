import { observeBrowserFaults } from './webTestUtils.js';
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import {
  reserveLoopbackPort as reservePort,
  waitForInboxRemoval,
  waitForHttp,
} from './asyncTestUtils.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';

export interface RootTurnAutoResumeWebEvidence {
  attentionVisible: true;
  attentionVisibleAfterReload: true;
  markerVisible: true;
  markerVisibleAfterReload: true;
  composerVisible: true;
  browserFaults: [];
}

const ROOT_TURN_RESPONSE_PREFIX = 'ROOT_TURN_RECOVERED_';

async function waitForExpectedAssistantText(
  page: Page,
  expected: string,
  timeoutMs: number
): Promise<void> {
  const assistant = page.locator('[data-chat-role="assistant"]');
  const deadline = Date.now() + timeoutMs;
  let prefixObservedAt: number | undefined;
  let observedTexts: string[] = [];

  while (Date.now() < deadline) {
    observedTexts = await assistant.allTextContents();
    if (observedTexts.some((text) => text.includes(expected))) return;
    if (observedTexts.some((text) => text.includes(ROOT_TURN_RESPONSE_PREFIX))) {
      prefixObservedAt ??= Date.now();
      if (Date.now() - prefixObservedAt >= 2_000) {
        throw new Error(
          `Root-turn Web response completed without the exact marker; assistant=${JSON.stringify(
            observedTexts.slice(-3).map((text) => text.slice(-1_024))
          )}`
        );
      }
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `Timed out waiting for the root-turn Web response; assistant=${JSON.stringify(
      observedTexts.slice(-3).map((text) => text.slice(-1_024))
    )}`
  );
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-16_384);
}

async function stopServer(
  child: ChildProcess,
  identity: ProcessIdentity | undefined
): Promise<void> {
  await stopForegroundGuiLauncher(child, identity);
}

export async function runRootTurnAutoResumeWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  expected: string;
  secret: string;
  timeoutMs?: number;
}): Promise<RootTurnAutoResumeWebEvidence> {
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
    if (!child.pid) throw new Error('Root-turn Web server has no process ID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin, 20_000);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    observeBrowserFaults(page, faults, () => ({ refreshing, closing }));

    const navigation = new URL(origin);
    navigation.searchParams.set('session', input.sessionId);
    navigation.searchParams.set('project', input.workspace);
    await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const attention = page.getByText(/Recovery needs review|恢复前需要检查/);
    await attention.waitFor({ state: 'visible', timeout: 30_000 });
    if (
      (await page
        .locator('[data-chat-role="assistant"]')
        .filter({ hasText: input.expected })
        .count()) > 0
    ) {
      throw new Error('Root-turn Web recovery replayed before explicit input');
    }
    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await attention.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.fill(
      'I inspected the workspace and external state. Continue safely without ' +
        'repeating any write or other side effect.'
    );
    await composer.press('Enter');
    await waitForExpectedAssistantText(page, input.expected, timeoutMs);
    await attention.waitFor({ state: 'hidden', timeout: 30_000 });
    await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
    if ((await page.locator('body').textContent())?.includes(input.secret)) {
      throw new Error('Provider credential reached the browser DOM');
    }

    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await waitForExpectedAssistantText(page, input.expected, 30_000);
    await page.waitForTimeout(500);
    if (faults.length > 0) {
      throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
    }
    return {
      attentionVisible: true,
      attentionVisibleAfterReload: true,
      markerVisible: true,
      markerVisibleAfterReload: true,
      composerVisible: true,
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
    await stopServer(child, identity);
  }
}
