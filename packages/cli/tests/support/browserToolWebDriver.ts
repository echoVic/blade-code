import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import type { BrowserToolFixture } from '../integration/real-api/browser-tool-fixture.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';

export interface BrowserToolWebEvidence {
  sessionId: string;
  markerVisible: true;
  markerVisibleAfterReload: true;
  agentBrowserProjected: true;
  toolNames: string[];
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
    throw new Error('Unable to reserve Browser Tool Web port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser Tool Web server did not become ready');
}

async function stop(
  child: ChildProcess,
  identity: ProcessIdentity | undefined
): Promise<void> {
  await stopForegroundGuiLauncher(child, identity);
}

async function waitForMarker(input: {
  page: import('playwright').Page;
  origin: string;
  workspace: string;
  sessionId: string;
  marker: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastStatus: unknown = 'unknown';
  while (Date.now() < deadline) {
    const assistant = input.page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.marker })
      .last();
    const markerVisible =
      (await assistant.count()) > 0 && (await assistant.isVisible());
    const response = await fetch(
      `${input.origin}/sessions/${encodeURIComponent(
        input.sessionId
      )}/status?projectPath=${encodeURIComponent(input.workspace)}`
    );
    if (response.ok) {
      lastStatus = ((await response.json()) as { status?: unknown }).status;
      if (markerVisible && lastStatus === 'completed') return;
      if (
        lastStatus === 'failed' ||
        lastStatus === 'cancelled' ||
        lastStatus === 'interrupted' ||
        lastStatus === 'waiting_permission'
      ) {
        const cards = await input.page
          .locator('[data-tool-name]')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              name: element.getAttribute('data-tool-name'),
              status: element.getAttribute('data-tool-status'),
            }))
          );
        const assistantText = await input.page
          .locator('[data-chat-role="assistant"]')
          .allTextContents();
        throw new Error(
          `Browser Tool Web run reached ${String(
            lastStatus
          )}; cards=${JSON.stringify(cards)}; assistant=${JSON.stringify(
            assistantText.slice(-3).map((text) => text.slice(-1_024))
          )}`
        );
      }
    }
    await input.page.waitForTimeout(250);
  }
  throw new Error(
    `Browser Tool Web marker timed out with status ${String(lastStatus)}`
  );
}

export async function runBrowserToolWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  fixture: BrowserToolFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<BrowserToolWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 240_000;
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
      cwd: input.workspace,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let identity: ProcessIdentity | undefined;
  let serverOutput = '';
  child.stdout?.on('data', (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-16_384);
  });
  child.stderr?.on('data', (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-16_384);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closing = false;
  let refreshing = false;
  const faults: string[] = [];

  try {
    if (!child.pid) throw new Error('Browser Tool Web server has no process ID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`, 20_000);
    const create = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: input.workspace,
        title: 'Browser Tool qualification',
      }),
    });
    if (!create.ok) throw new Error(`Session create failed: ${create.status}`);
    const created = (await create.json()) as { sessionId?: unknown };
    if (typeof created.sessionId !== 'string') {
      throw new Error('Browser Tool Web Session returned no ID');
    }

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(`console:${message.text()}`);
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
    navigation.searchParams.set('session', created.sessionId);
    navigation.searchParams.set('project', input.workspace);
    await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
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
    await composer.fill(input.fixture.prompt);
    await composer.press('Enter');
    const browserPanel = page.locator('[data-browser-panel]');
    await browserPanel.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-browser-panel]');
        return (
          panel?.getAttribute('data-browser-mode') === 'test' &&
          panel.getAttribute('data-browser-test-source') === 'agent'
        );
      },
      undefined,
      { timeout: timeoutMs }
    );
    await page
      .locator('[data-browser-test-screenshot]')
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await page
      .locator('[data-browser-agent-pointer]')
      .waitFor({ state: 'visible', timeout: timeoutMs });
    const browserAddress = page.locator('[data-browser-panel-address]');
    expect(await browserAddress.getAttribute('readonly')).not.toBeNull();
    expect(
      await page.getByRole('button', { name: 'Click selected element' }).isDisabled()
    ).toBe(true);
    await waitForMarker({
      page,
      origin,
      workspace: input.workspace,
      sessionId: created.sessionId,
      marker: input.fixture.finalMarker,
      timeoutMs,
    });

    const toolNames = await page
      .locator('[data-tool-name]')
      .evaluateAll((elements) =>
        elements
          .map((element) => element.getAttribute('data-tool-name'))
          .filter((name): name is string => Boolean(name))
      );
    if ((await page.locator('body').textContent())?.includes(input.secret)) {
      throw new Error('Provider credential reached the Browser Tool Web DOM');
    }

    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.fixture.finalMarker })
      .last()
      .waitFor({ state: 'visible', timeout: 30_000 });
    if (faults.length > 0) {
      throw new Error(`Browser Tool Web faults: ${JSON.stringify(faults)}`);
    }
    return {
      sessionId: created.sessionId,
      markerVisible: true,
      markerVisibleAfterReload: true,
      agentBrowserProjected: true,
      toolNames,
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
    await stop(child, identity);
  }
}
