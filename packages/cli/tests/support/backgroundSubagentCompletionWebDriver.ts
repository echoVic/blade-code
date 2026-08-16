import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';

export interface BackgroundSubagentCompletionWebEvidence {
  childSessionId: string;
  childVisible: true;
  parentVisible: true;
  noFakeUserMessage: true;
  providerAdmissionVisible: true;
  visibleAfterReload: true;
  sidecarStableAcrossReload: true;
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
    throw new Error('Unable to reserve background completion browser port');
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
  throw new Error('Background completion Web server did not become ready');
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
  throw new Error('Web background completion was not durably acknowledged');
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-16_384);
}

export async function runBackgroundSubagentCompletionWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  childMarker: string;
  secret: string;
  timeoutMs?: number;
}): Promise<BackgroundSubagentCompletionWebEvidence> {
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
  let page: Page | undefined;
  let closing = false;
  let refreshing = false;
  const faults: string[] = [];
  try {
    if (!child.pid) throw new Error('Background completion server has no PID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin, 20_000);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
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
    await page
      .locator('textarea[data-blade-composer]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('Capacity queue', { exact: false }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    const childCard = page.locator('[data-subagent-session-id]').last();
    const parentMessage = page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: `BACKGROUND_PARENT_FINAL:${input.childMarker}` })
      .last();
    await parentMessage.waitFor({ state: 'visible', timeout: timeoutMs });
    await childCard.waitFor({ state: 'visible', timeout: 30_000 });
    const childSessionId = await childCard.getAttribute('data-subagent-session-id');
    if (!childSessionId) {
      throw new Error('Background completion Web card has no durable child ID');
    }
    const liveChildText = (await childCard.textContent()) ?? '';
    await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
    if (
      (await page
        .locator('[data-chat-role="user"]')
        .filter({ hasText: input.childMarker })
        .count()) !== 0
    ) {
      throw new Error('Web rendered the hidden completion as a user message');
    }
    if ((await page.locator('body').textContent())?.includes(input.secret)) {
      throw new Error('Provider credential reached the background completion DOM');
    }
    const sidecarPath = path.join(
      input.storageRoot,
      'agents',
      'sessions',
      `${childSessionId}.json`
    );
    const sidecarBeforeReload = await readFile(sidecarPath, 'utf8');

    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await page
      .locator('textarea[data-blade-composer]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    const reloadedChildCard = page.locator(
      `[data-subagent-session-id="${childSessionId}"]`
    );
    await reloadedChildCard.waitFor({ state: 'visible', timeout: 30_000 });
    const reloadedChildText = (await reloadedChildCard.textContent()) ?? '';
    await parentMessage.waitFor({ state: 'visible', timeout: 30_000 });
    if ((await page.locator('body').textContent())?.includes('Capacity queue')) {
      throw new Error('Web reload restored transient Provider admission state');
    }
    const sidecarAfterReload = await readFile(sidecarPath, 'utf8');
    if (sidecarAfterReload !== sidecarBeforeReload) {
      throw new Error('Web reload mutated the terminal child sidecar');
    }
    if (
      !liveChildText.includes(input.childMarker) ||
      !/(completed|success)/i.test(liveChildText)
    ) {
      throw new Error(
        `Live child card was not terminal: ${JSON.stringify(liveChildText.slice(0, 1_000))}`
      );
    }
    if (
      !reloadedChildText.includes(input.childMarker) ||
      !/(completed|success)/i.test(reloadedChildText)
    ) {
      throw new Error(
        `Reloaded child card was not terminal: ${JSON.stringify(
          reloadedChildText.slice(0, 1_000)
        )}`
      );
    }
    await page.waitForTimeout(500);
    if (faults.length > 0) {
      throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
    }
    return {
      childSessionId,
      childVisible: true,
      parentVisible: true,
      noFakeUserMessage: true,
      providerAdmissionVisible: true,
      visibleAfterReload: true,
      sidecarStableAcrossReload: true,
      browserFaults: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const browserState = page
      ? await page
          .evaluate(
            ({ marker }) => ({
              url: window.location.href,
              childCards: Array.from(
                document.querySelectorAll<HTMLElement>('[data-subagent-session-id]')
              ).map((element) => ({
                sessionId: element.dataset.subagentSessionId,
                text: element.textContent?.slice(0, 1_000),
              })),
              markerPresent: document.body.textContent?.includes(marker) ?? false,
              bodyTail: document.body.textContent?.slice(-4_000),
            }),
            { marker: input.childMarker }
          )
          .catch((stateError) => ({
            stateError:
              stateError instanceof Error ? stateError.message : String(stateError),
          }))
      : { page: 'unavailable' };
    throw new Error(
      `${message.replaceAll(input.secret, '[REDACTED]')}; browser=${JSON.stringify(
        browserState
      )
        .replaceAll(input.secret, '[REDACTED]')
        .slice(-8_000)}; server=${serverOutput
        .replaceAll(input.secret, '[REDACTED]')
        .slice(-2_000)}`
    );
  } finally {
    closing = true;
    await browser?.close().catch(() => undefined);
    await stopForegroundGuiLauncher(child, identity);
  }
}
