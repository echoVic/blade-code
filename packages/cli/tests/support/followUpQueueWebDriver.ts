import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { SessionSchema } from '../../src/api/schemas.js';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';
import { createTuiTaskAttentionSecretScanner } from './tuiTaskAttentionPtyDriver.js';

const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_?KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

export interface FollowUpQueueWebEvidence {
  success: true;
  panelOpened: true;
  reordered: true;
  deleted: true;
  reloadPreservedOrder: true;
  retainedMessagesPromoted: true;
  deletedMessageAbsent: true;
  finalMarkerSeen: true;
  cleanupComplete: true;
  browserFaults: string[];
  serverFaults: string[];
  leakedSecrets: string[];
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
    throw new Error('Unable to reserve follow-up queue Web port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHttp(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Follow-up queue Web server did not become ready');
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function submit(page: Page, text: string): Promise<void> {
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.fill(text);
  await page.locator('[data-blade-submit]').click();
}

async function queueTexts(page: Page): Promise<string[]> {
  return page
    .locator('[data-blade-follow-up-queue] [data-follow-up-id]')
    .evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
}

async function openQueue(page: Page): Promise<void> {
  const panel = page.locator('[data-blade-follow-up-queue]');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const toggle = panel.getByRole('button', { name: /Show follow-up queue/ });
  if ((await toggle.count()) > 0) await toggle.click();
}

function inspectServerFaults(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /\b(error|panic|fatal)\b/i.test(line))
    .slice(-20);
}

export async function runFollowUpQueueWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  primaryPrompt: string;
  firstMarker: string;
  deletedMarker: string;
  movedMarker: string;
  expectedOutput: string;
  providerApiKey: string;
  secrets: readonly string[];
  waitForProviderHold(): Promise<void>;
  releaseProvider(): void;
  timeoutMs?: number;
}): Promise<FollowUpQueueWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 240_000;
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  await access(cliEntry);
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [cliEntry, '--trust-workspace', 'serve', '--port', String(port)],
    {
      cwd: input.workspace,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && !CREDENTIAL_ENV_NAME.test(entry[0])
          )
        ),
        HOME: input.home,
        BLADE_STORAGE_ROOT: input.storageRoot,
        BLADE_AUTO_MEMORY: '0',
        BLADE_TELEMETRY_DISABLED: '1',
        BLADE_API_KEY: input.providerApiKey,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let identity: ProcessIdentity | undefined;
  let serverOutput = '';
  const serverSecretScanner = createTuiTaskAttentionSecretScanner(input.secrets);
  child.stdout?.on('data', (chunk: Buffer | string) => {
    serverSecretScanner.observe(chunk);
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-32_000);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    serverSecretScanner.observe(chunk);
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-32_000);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  const faults: string[] = [];
  const requestState = { refreshing: false, closing: false };
  let released = false;
  try {
    if (!child.pid) throw new Error('Follow-up queue Web server has no PID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin, 20_000);
    const created = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: input.workspace,
        title: 'Follow-up queue qualification',
      }),
    });
    if (!created.ok) throw new Error(`Create Session failed with ${created.status}`);
    const session = SessionSchema.parse(await created.json());

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US' });
    page = await context.newPage();
    page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(`console:${message.text()}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        faults.push(`http:${response.status()}:${response.url()}`);
    });
    page.on('requestfailed', (request) => {
      const failure = {
        url: request.url(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText ?? 'unknown',
        refreshing: requestState.refreshing,
        closing: requestState.closing,
      };
      if (!isExpectedBrowserRequestFailure(failure)) {
        faults.push(`requestfailed:${failure.errorText}:${failure.url}`);
      }
    });
    const navigation = new URL(origin);
    navigation.searchParams.set('session', session.sessionId);
    navigation.searchParams.set('project', input.workspace);
    await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
    await page
      .locator('textarea[data-blade-composer]')
      .waitFor({ state: 'visible', timeout: 30_000 });

    await submit(page, input.primaryPrompt);
    await input.waitForProviderHold();
    const followUps = [input.firstMarker, input.deletedMarker, input.movedMarker];
    for (const [index, marker] of followUps.entries()) {
      await submit(page, marker);
      await waitFor(
        async () =>
          (await page!.locator('[data-blade-follow-up-queue]').textContent())?.includes(
            `${index + 1} queued`
          ) === true,
        `Web did not enqueue ${marker}`,
        15_000
      );
    }
    await openQueue(page);
    await waitFor(
      async () => (await queueTexts(page!)).length === 3,
      'Web queue panel did not render three rows',
      15_000
    );
    const movedRow = page.locator('[data-follow-up-id]', {
      hasText: input.movedMarker,
    });
    await movedRow.getByRole('button', { name: /Move .* up/ }).click();
    await waitFor(
      async () => {
        const texts = await queueTexts(page!);
        return (
          texts[0]?.includes(input.firstMarker) === true &&
          texts[1]?.includes(input.movedMarker) === true &&
          texts[2]?.includes(input.deletedMarker) === true
        );
      },
      'Web queue move did not commit A, C, B',
      15_000
    );
    const deletedRow = page.locator('[data-follow-up-id]', {
      hasText: input.deletedMarker,
    });
    await deletedRow.getByRole('button', { name: /Remove follow-up/ }).click();
    await waitFor(
      async () => (await queueTexts(page!)).length === 2,
      'Web queue delete did not commit',
      15_000
    );

    requestState.refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    requestState.refreshing = false;
    await page
      .locator('textarea[data-blade-composer]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await openQueue(page);
    await waitFor(
      async () => {
        const texts = await queueTexts(page!);
        return (
          texts.length === 2 &&
          texts[0]?.includes(input.firstMarker) === true &&
          texts[1]?.includes(input.movedMarker) === true
        );
      },
      'Web reload did not preserve A, C order',
      30_000
    );

    input.releaseProvider();
    released = true;
    await page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.expectedOutput })
      .last()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await waitFor(
      async () => {
        const users = await page!.locator('[data-chat-role="user"]').allTextContents();
        return (
          users.filter((text) => text.includes(input.firstMarker)).length === 1 &&
          users.filter((text) => text.includes(input.movedMarker)).length === 1 &&
          users.every((text) => !text.includes(input.deletedMarker))
        );
      },
      'Web did not promote retained queue rows exactly once',
      30_000
    );
    await page.waitForTimeout(500);

    const browserText = (await page.locator('body').textContent()) ?? '';
    const serverFaults = inspectServerFaults(serverOutput);
    const leakSources = [browserText, serverOutput, JSON.stringify(faults)];
    const leakedSecrets = [
      ...new Set([
        ...serverSecretScanner.leakedSecretLabels(),
        ...input.secrets.flatMap((secret, index) =>
          secret && leakSources.some((source) => source.includes(secret))
            ? [`secret-${index + 1}`]
            : []
        ),
      ]),
    ];
    if (faults.length > 0) throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
    if (serverFaults.length > 0) {
      throw new Error(`Server faults: ${JSON.stringify(serverFaults)}`);
    }
    if (leakedSecrets.length > 0) throw new Error('Web evidence exposed credentials');
    return {
      success: true,
      panelOpened: true,
      reordered: true,
      deleted: true,
      reloadPreservedOrder: true,
      retainedMessagesPromoted: true,
      deletedMessageAbsent: true,
      finalMarkerSeen: true,
      cleanupComplete: true,
      browserFaults: [],
      serverFaults: [],
      leakedSecrets: [],
    };
  } finally {
    if (!released) input.releaseProvider();
    requestState.closing = true;
    await browser?.close().catch(() => undefined);
    await stopForegroundGuiLauncher(child, identity);
  }
}
