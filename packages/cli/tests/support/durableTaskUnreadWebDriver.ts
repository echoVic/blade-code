import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';
import {
  CreateTaskResponseSchema,
  SessionCatalogPageSchema,
  SessionSchema,
} from '../../src/api/schemas.js';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';

const UNREAD_TASKS_KEY = 'blade.tasks.unread';
const TERMINAL_READ_LEDGER_KEY = 'blade.tasks.terminal-read-ledger.v1';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

interface SessionRefEvidence {
  projectPath: string;
  sessionId: string;
}

interface UnreadCheckpoint {
  browserUnread: boolean;
  siblingUnread: boolean;
  titleCount: number;
}

export interface DurableTaskUnreadWebEvidence {
  model: string;
  frameworkRetries: 0;
  modelMaxRetries: 0;
  selectedBefore: SessionRefEvidence;
  backgroundTask: SessionRefEvidence;
  statusSequence: string[];
  unreadAfterMissedCompletion: UnreadCheckpoint;
  unreadAfterReload: UnreadCheckpoint;
  titleCountAfterReload: number;
  selectedAfterClick: SessionRefEvidence;
  siblingUnreadPreserved: true;
  browserFaults: string[];
  serverFaults: string[];
  leakedSecrets: string[];
  durationMs: number;
}

interface BrowserFailure {
  url: string;
  resourceType: string;
  errorText: string;
  refreshing: boolean;
  closing: boolean;
}

interface StorageSnapshot {
  ledger: Array<{ key: string; signature: string | null }>;
  unread: string[];
}

function sessionRefKey(ref: SessionRefEvidence): string {
  return JSON.stringify([ref.projectPath, ref.sessionId]);
}

function evidenceRef(ref: SessionRefEvidence, workspace: string): SessionRefEvidence {
  return {
    projectPath:
      ref.projectPath === workspace ? '[fixture]/workspace' : '[fixture]/sibling',
    sessionId: ref.sessionId,
  };
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-16_384);
}

function redacted(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, '[REDACTED]') : result),
    value
  );
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
    throw new Error('Unable to reserve durable unread browser port');
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
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Durable unread Web server did not become ready');
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function readStorage(page: Page): Promise<StorageSnapshot> {
  return page.evaluate(
    ({ ledgerKey, unreadKey }) => {
      const ledgerValue: unknown = JSON.parse(
        localStorage.getItem(ledgerKey) ?? '{"version":1,"entries":[]}'
      );
      const unreadValue: unknown = JSON.parse(localStorage.getItem(unreadKey) ?? '[]');
      const entries =
        ledgerValue &&
        typeof ledgerValue === 'object' &&
        'entries' in ledgerValue &&
        Array.isArray(ledgerValue.entries)
          ? ledgerValue.entries.flatMap((entry: unknown) => {
              if (
                !entry ||
                typeof entry !== 'object' ||
                !('key' in entry) ||
                typeof entry.key !== 'string' ||
                !('signature' in entry) ||
                (entry.signature !== null && typeof entry.signature !== 'string')
              ) {
                return [];
              }
              return [{ key: entry.key, signature: entry.signature }];
            })
          : [];
      return {
        ledger: entries,
        unread: Array.isArray(unreadValue)
          ? unreadValue.filter((value): value is string => typeof value === 'string')
          : [],
      };
    },
    { ledgerKey: TERMINAL_READ_LEDGER_KEY, unreadKey: UNREAD_TASKS_KEY }
  );
}

function parseTitleCount(title: string): number {
  const match = /^\((\d+)\) BladeCode$/.exec(title);
  return match?.[1] ? Number.parseInt(match[1], 10) : title === 'BladeCode' ? 0 : -1;
}

async function checkpoint(
  page: Page,
  browserKey: string,
  siblingKey: string
): Promise<UnreadCheckpoint> {
  const storage = await readStorage(page);
  return {
    browserUnread: storage.unread.includes(browserKey),
    siblingUnread: storage.unread.includes(siblingKey),
    titleCount: parseTitleCount(await page.title()),
  };
}

async function openTaskSwitcher(page: Page): Promise<void> {
  await page.keyboard.press('Control+K');
  await page.getByRole('combobox', { name: /Search tasks|搜索任务/ }).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

function attachFaultCollection(
  page: Page,
  faults: string[],
  state: { refreshing: boolean; closing: boolean }
): void {
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
    const failure: BrowserFailure = {
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText ?? 'unknown',
      refreshing: state.refreshing,
      closing: state.closing,
    };
    if (!isExpectedBrowserRequestFailure(failure)) {
      faults.push(`requestfailed:${failure.errorText}:${failure.url}`);
    }
  });
}

async function waitForCatalogBaseline(page: Page, taskKey: string): Promise<void> {
  await waitForCondition(
    async () => {
      const storage = await readStorage(page);
      return storage.ledger.some(
        (entry) => entry.key === taskKey && entry.signature === null
      );
    },
    'running task null ledger baseline',
    30_000
  );
}

async function waitForTerminalTask(
  origin: string,
  ref: SessionRefEvidence,
  timeoutMs: number
): Promise<ReturnType<typeof SessionSchema.parse>> {
  const url = new URL(`/sessions/${encodeURIComponent(ref.sessionId)}`, origin);
  url.searchParams.set('projectPath', ref.projectPath);
  let lastStatus = 'unknown';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (!response.ok) {
      lastStatus = `http-${response.status}`;
    } else {
      const session = SessionSchema.parse(await response.json());
      lastStatus = session.taskStatus;
      if (TERMINAL_STATUSES.has(session.taskStatus)) return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for real task terminal status (${lastStatus})`);
}

async function waitForCatalogSessions(
  origin: string,
  expected: ReadonlyMap<string, string>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed: string[] = [];
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/sessions/catalog?limit=50`);
    if (response.ok) {
      const page = SessionCatalogPageSchema.parse(await response.json());
      observed = page.sessions.map(
        (session) => `${sessionRefKey(session)}:${session.taskStatus}`
      );
      if (
        [...expected].every(([key, status]) =>
          page.sessions.some(
            (session) => sessionRefKey(session) === key && session.taskStatus === status
          )
        )
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for authoritative catalog: ${JSON.stringify(observed)}`
  );
}

async function createSelectedSession(
  origin: string,
  workspace: string,
  title: string
): Promise<SessionRefEvidence> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: workspace, title }),
  });
  if (!response.ok) {
    throw new Error(`Create selected session failed with HTTP ${response.status}`);
  }
  const session = SessionSchema.parse(await response.json());
  return { sessionId: session.sessionId, projectPath: session.projectPath };
}

async function dispatchBackgroundTask(input: {
  origin: string;
  workspace: string;
  modelId: string;
  marker: string;
  title: string;
}): Promise<SessionRefEvidence> {
  const response = await fetch(`${input.origin}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: [
        'Do not use tools or edit files.',
        `Reply with exactly ${input.marker}`,
        'Do not add punctuation, Markdown, or explanation.',
      ].join(' '),
      title: input.title,
      projectPath: input.workspace,
      modelId: input.modelId,
      isolation: 'local',
      permissionMode: 'yolo',
    }),
  });
  if (response.status !== 202) {
    throw new Error(`Dispatch background task failed with HTTP ${response.status}`);
  }
  const accepted = CreateTaskResponseSchema.parse(await response.json());
  if (accepted.status !== 'running') {
    throw new Error(`Background task was not running: ${accepted.status}`);
  }
  return {
    sessionId: accepted.session.sessionId,
    projectPath: accepted.session.projectPath,
  };
}

function inspectServerFaults(serverOutput: string): string[] {
  return serverOutput
    .split(/\r?\n/)
    .filter((line) => /\b(error|panic|fatal)\b/i.test(line))
    .slice(-20);
}

async function createPage(
  context: BrowserContext,
  faults: string[],
  state: { refreshing: boolean; closing: boolean }
): Promise<Page> {
  const page = await context.newPage();
  attachFaultCollection(page, faults, state);
  return page;
}

export async function runDurableTaskUnreadWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  model: string;
  modelId: string;
  marker: string;
  secret: string;
  seedSibling(ref: SessionRefEvidence): Promise<SessionRefEvidence>;
  releaseProvider(): void;
  waitForProviderHold(timeoutMs: number): Promise<void>;
  timeoutMs?: number;
}): Promise<DurableTaskUnreadWebEvidence> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 240_000;
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  await access(cliEntry);
  const port = await reservePort();
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
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const faults: string[] = [];
  const requestState = { refreshing: false, closing: false };
  const secretCandidates = [input.secret].filter(Boolean);
  const statusSequence = ['running'];
  const origin = `http://127.0.0.1:${port}`;
  try {
    if (!child.pid) throw new Error('Durable unread server has no PID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    await waitForHttp(origin, 20_000);

    const selectedBefore = await createSelectedSession(
      origin,
      input.workspace,
      `Unread foreground ${input.model}`
    );
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ locale: 'en-US' });
    page = await createPage(context, faults, requestState);
    const selectedUrl = new URL(origin);
    selectedUrl.searchParams.set('session', selectedBefore.sessionId);
    selectedUrl.searchParams.set('project', selectedBefore.projectPath);
    await page.goto(selectedUrl.href, { waitUntil: 'domcontentloaded' });
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    const backgroundTask = await dispatchBackgroundTask({
      origin,
      workspace: input.workspace,
      modelId: input.modelId,
      marker: input.marker,
      title: `Unread background ${input.model}`,
    });
    await input.waitForProviderHold(30_000);
    const backgroundKey = sessionRefKey(backgroundTask);
    const siblingRef = await input.seedSibling(backgroundTask);
    if (siblingRef.sessionId !== backgroundTask.sessionId) {
      throw new Error('Sibling fixture did not preserve the shared session ID');
    }
    const siblingKey = sessionRefKey(siblingRef);

    requestState.refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    requestState.refreshing = false;
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await waitForCatalogBaseline(page, backgroundKey);
    const selectedBeforeMiss = new URL(page.url());
    if (
      selectedBeforeMiss.searchParams.get('session') !== selectedBefore.sessionId ||
      selectedBeforeMiss.searchParams.get('project') !== selectedBefore.projectPath
    ) {
      throw new Error('Background running task stole focus before completion');
    }
    await page.evaluate(
      ({ sibling, unreadKey }) => {
        const parsed: unknown = JSON.parse(localStorage.getItem(unreadKey) ?? '[]');
        const unread = Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === 'string')
          : [];
        localStorage.setItem(
          unreadKey,
          JSON.stringify([...new Set([...unread, sibling])])
        );
      },
      { sibling: siblingKey, unreadKey: UNREAD_TASKS_KEY }
    );

    requestState.closing = true;
    await page.close();
    requestState.closing = false;
    page = undefined;
    input.releaseProvider();
    const terminal = await waitForTerminalTask(origin, backgroundTask, timeoutMs);
    statusSequence.push(terminal.taskStatus);
    if (terminal.taskStatus !== 'completed') {
      throw new Error(`Real background task ended ${terminal.taskStatus}`);
    }
    await waitForCatalogSessions(
      origin,
      new Map([
        [backgroundKey, 'completed'],
        [siblingKey, 'completed'],
      ]),
      30_000
    );
    const preservedStorage = await context.storageState();
    await context.close();
    context = await browser.newContext({
      locale: 'en-US',
      storageState: preservedStorage,
    });

    page = await createPage(context, faults, requestState);
    const recoveredPage = page;
    await page.goto(selectedUrl.href, { waitUntil: 'domcontentloaded' });
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await waitForCondition(
      async () => {
        const value = await checkpoint(recoveredPage, backgroundKey, siblingKey);
        return value.browserUnread && value.siblingUnread && value.titleCount === 2;
      },
      'missed completion unread DOM title',
      30_000
    );
    const unreadAfterMissedCompletion = await checkpoint(
      page,
      backgroundKey,
      siblingKey
    );
    const selectedAfterMiss = new URL(page.url());
    if (
      selectedAfterMiss.searchParams.get('session') !== selectedBefore.sessionId ||
      selectedAfterMiss.searchParams.get('project') !== selectedBefore.projectPath
    ) {
      throw new Error('Catalog reconciliation stole focus from selected Session A');
    }

    await openTaskSwitcher(page);
    const result = page.locator(`[data-session-ref='${backgroundKey}']`);
    await result.waitFor({ state: 'visible', timeout: 30_000 });
    if (!/New/.test((await result.textContent()) ?? '')) {
      throw new Error('TaskSwitcher did not render the background unread badge');
    }
    await page.keyboard.press('Escape');

    requestState.refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    requestState.refreshing = false;
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await waitForCondition(
      async () => {
        const value = await checkpoint(recoveredPage, backgroundKey, siblingKey);
        return value.browserUnread && value.siblingUnread && value.titleCount === 2;
      },
      'persistent unread after reload',
      30_000
    );
    const unreadAfterReload = await checkpoint(page, backgroundKey, siblingKey);
    const titleCountAfterReload = unreadAfterReload.titleCount;

    await openTaskSwitcher(page);
    const reloadedResult = page.locator(`[data-session-ref='${backgroundKey}']`);
    await reloadedResult.waitFor({ state: 'visible', timeout: 30_000 });
    if (!/New/.test((await reloadedResult.textContent()) ?? '')) {
      throw new Error('TaskSwitcher unread badge did not survive reload');
    }
    await reloadedResult.getByRole('button', { name: /Select / }).click();
    await page.locator('textarea[data-blade-composer]').waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.marker })
      .last()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await waitForCondition(
      async () => {
        const value = await checkpoint(recoveredPage, backgroundKey, siblingKey);
        return !value.browserUnread && value.siblingUnread && value.titleCount === 1;
      },
      'exact task read acknowledgement',
      30_000
    );
    const selectedUrlAfterClick = new URL(page.url());
    const selectedAfterClick = {
      sessionId: selectedUrlAfterClick.searchParams.get('session') ?? '',
      projectPath: selectedUrlAfterClick.searchParams.get('project') ?? '',
    };
    if (
      selectedAfterClick.sessionId !== backgroundTask.sessionId ||
      selectedAfterClick.projectPath !== backgroundTask.projectPath
    ) {
      throw new Error('TaskSwitcher selected the wrong compound SessionRef');
    }
    const terminalRow = page.getByRole('button', {
      name: `Select Unread background ${input.model}`,
    });
    await terminalRow.waitFor({ state: 'visible', timeout: 30_000 });
    if ((await terminalRow.locator('[title="completed"]').count()) !== 1) {
      throw new Error('Selected background task did not render completed status');
    }

    const finalStorage = await readStorage(page);
    const siblingUnreadPreserved = finalStorage.unread.includes(siblingKey);
    const serverFaults = inspectServerFaults(serverOutput);
    const leakSources = [
      serverOutput,
      ...faults,
      JSON.stringify(finalStorage),
      (await page.locator('body').textContent()) ?? '',
    ];
    const evidence: DurableTaskUnreadWebEvidence = {
      model: input.model,
      frameworkRetries: 0,
      modelMaxRetries: 0,
      selectedBefore: evidenceRef(selectedBefore, input.workspace),
      backgroundTask: evidenceRef(backgroundTask, input.workspace),
      statusSequence,
      unreadAfterMissedCompletion,
      unreadAfterReload,
      titleCountAfterReload,
      selectedAfterClick: evidenceRef(selectedAfterClick, input.workspace),
      siblingUnreadPreserved: siblingUnreadPreserved
        ? true
        : (() => {
            throw new Error('Clicking task B cleared its cross-project sibling unread');
          })(),
      browserFaults: faults.map((fault) => redacted(fault, secretCandidates)),
      serverFaults: serverFaults.map((fault) => redacted(fault, secretCandidates)),
      leakedSecrets: secretCandidates.flatMap((secret, index) =>
        leakSources.some((source) => source.includes(secret))
          ? [`secret-${index + 1}`]
          : []
      ),
      durationMs: Date.now() - startedAt,
    };
    return evidence;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const catalogState = await fetch(`${origin}/sessions/catalog?limit=50`)
      .then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))
      .catch((catalogError) => ({
        catalogError:
          catalogError instanceof Error ? catalogError.message : String(catalogError),
      }));
    const browserState = page
      ? await page
          .evaluate(
            ({ ledgerKey, unreadKey }) => ({
              url: window.location.href,
              title: document.title,
              unread: localStorage.getItem(unreadKey),
              ledger: localStorage.getItem(ledgerKey),
              bodyTail: document.body.textContent?.slice(-4_000),
            }),
            {
              ledgerKey: TERMINAL_READ_LEDGER_KEY,
              unreadKey: UNREAD_TASKS_KEY,
            }
          )
          .catch((stateError) => ({
            stateError:
              stateError instanceof Error ? stateError.message : String(stateError),
          }))
      : { page: 'unavailable' };
    throw new Error(
      redacted(
        `${message}; catalog=${JSON.stringify(catalogState).slice(-8_000)}; ` +
          `browser=${JSON.stringify(browserState).slice(-8_000)}; ` +
          `server=${serverOutput.slice(-4_000)}`,
        secretCandidates
      )
    );
  } finally {
    requestState.closing = true;
    input.releaseProvider();
    await browser?.close().catch(() => undefined);
    await stopForegroundGuiLauncher(child, identity);
  }
}
