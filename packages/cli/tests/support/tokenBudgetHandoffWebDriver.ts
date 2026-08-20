import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { isValidSessionId } from '../../src/context/storage/pathUtils.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import { processIdentityMatches } from '../../src/utils/process/ProcessIdentity.js';
import { assertNoSecrets } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import type { TokenBudgetHandoffFixture } from '../integration/real-api/tokenBudgetHandoffFixture.js';
import type { TokenBudgetHandoffSurfaceEvidence } from '../integration/real-api/tokenBudgetHandoffHarness.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
  waitForForegroundGuiLauncherReady,
} from './foregroundBoundedOutputWebDriver.js';
import type { TokenBudgetProxyEvidence } from './tokenBudgetHandoffProxy.js';

declare global {
  interface Window {
    __bladeTokenBudgetEvents: string[];
    __bladeTokenBudgetEventOverflowed: boolean;
    __bladeTokenBudgetHiddenSeen: boolean;
    __bladeTokenBudgetObserveSse: (payload: string) => Promise<void>;
    __bladeTokenBudgetPendingScans: Promise<void>[];
    __bladeTokenBudgetCloseEventSources: () => void;
  }
}

const MAX_EVIDENCE_CHARS = 64_000;
const FINAL_MARKER_PATTERN = /^FINAL_OK_[A-Za-z0-9_]{16,64}$/;
const WEB_FAILURE_STAGES = [
  'launcher_identity',
  'launcher_ready',
  'server_ready',
  'session_create',
  'browser_launch',
  'page_ready',
  'task_start',
  'first_reload',
  'completion',
  'privacy',
  'recovery_reload',
  'browser_cleanup',
  'launcher_cleanup',
  'privacy_cleanup',
  'port_cleanup',
] as const;

type WebFailureStage = (typeof WEB_FAILURE_STAGES)[number];

type WebRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'idle'
  | 'queued'
  | 'waiting_permission'
  | 'error'
  | 'unknown';

class TokenBudgetWebFinalTimeoutError extends Error {
  constructor(readonly diagnostic: string) {
    super('Token-budget Web final marker timed out');
  }
}

export function formatTokenBudgetWebFinalDiagnostic(input: {
  status: unknown;
  providerRequests: number;
  publicFinalSeen: boolean;
  domFinalSeen: boolean;
}): string {
  const statuses = new Set<WebRunStatus>([
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'idle',
    'queued',
    'waiting_permission',
    'error',
  ]);
  const status: WebRunStatus =
    typeof input.status === 'string' && statuses.has(input.status as WebRunStatus)
      ? (input.status as WebRunStatus)
      : 'unknown';
  const requests = !Number.isSafeInteger(input.providerRequests)
    ? 'invalid'
    : input.providerRequests < 0
      ? 'invalid'
      : input.providerRequests <= 5
        ? String(input.providerRequests)
        : 'overflow';
  return (
    `status_${status}:requests_${requests}:` +
    `history_${input.publicFinalSeen ? 1 : 0}:dom_${input.domFinalSeen ? 1 : 0}`
  );
}

export function formatTokenBudgetWebProxyDiagnostic(
  evidence: TokenBudgetProxyEvidence
): string {
  const first = evidence.requests[0];
  const kind = first?.kind ?? 'none';
  const status =
    first?.upstreamStatus !== undefined &&
    Number.isSafeInteger(first.upstreamStatus) &&
    first.upstreamStatus >= 100 &&
    first.upstreamStatus <= 599
      ? String(first.upstreamStatus)
      : first?.upstreamStatus === undefined
        ? '0'
        : 'invalid';
  const responseKind = first?.responseKind ?? 'unknown';
  const usageShape = first?.usageShape ?? 'unknown';
  const inFlight =
    !Number.isSafeInteger(evidence.maxInFlight) || evidence.maxInFlight < 0
      ? 'invalid'
      : evidence.maxInFlight <= 8
        ? String(evidence.maxInFlight)
        : 'overflow';
  return (
    `first_${kind}:s${status}:${responseKind}:${usageShape}:` +
    `rewritten_${first?.usageRewritten === true ? 1 : 0}:inflight_${inFlight}`
  );
}

function launcherReadyFailureCode(error: unknown, child: ChildProcess): string {
  if (child.signalCode !== null) return 'child_signal';
  if (child.exitCode !== null) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('Cannot find module')) return 'module_missing';
    if (message.includes('DeepSeek') || message.includes('model')) {
      return 'model_config';
    }
    if (message.includes('EADDRINUSE')) return 'port_in_use';
    if (message.includes('readiness timed out')) return 'server_ready_timeout';
    if (message.includes('exited before readiness')) return 'server_exit';
    return 'child_exit_nonzero';
  }
  return 'ready_timeout';
}

function remainingStageBudget(deadline: number, maximumMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Token-budget Web surface deadline exhausted');
  }
  return Math.max(1, Math.min(remaining, maximumMs));
}
const FORBIDDEN = [
  '<token-budget-handoff version="1">',
  'token_budget_handoff_recorded',
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  'Context rollover is approaching',
] as const;

export interface TokenBudgetHandoffWebEvidence
  extends TokenBudgetHandoffSurfaceEvidence {
  success: true;
  httpHistoryClean: true;
  sseClean: true;
  domClean: true;
  htmlClean: true;
  reloadCompleted: true;
  launcherGone: true;
  portReusable: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function assertSafe(value: unknown, secrets: readonly string[]): void {
  try {
    assertNoSecrets(value, secrets);
  } catch (error) {
    throw new Error('Token-budget Web evidence contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(value, FORBIDDEN);
  } catch (error) {
    throw new Error('Token-budget Web evidence contains a hidden marker', {
      cause: error,
    });
  }
}

export function parseTokenBudgetHandoffWebEvidence(
  stdout: string,
  secrets: readonly string[] = []
): TokenBudgetHandoffWebEvidence {
  if (stdout.length > MAX_EVIDENCE_CHARS) {
    throw new Error('Token-budget Web evidence exceeded its serialized budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget Web evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== stdout) {
    throw new Error('Token-budget Web evidence must use canonical JSON');
  }
  assertSafe(parsed, secrets);
  const recovery = isRecord(parsed) && isRecord(parsed.recovery) ? parsed.recovery : {};
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, [
      'domClean',
      'faults',
      'finalMarkerSeen',
      'hiddenMarkerSeen',
      'htmlClean',
      'httpHistoryClean',
      'launcherGone',
      'portReusable',
      'recovery',
      'reloadCompleted',
      'sessionId',
      'sseClean',
      'success',
      'surface',
    ]) ||
    !exactKeys(recovery, [
      'completed',
      'kind',
      'providerRequestsAfter',
      'providerRequestsBefore',
    ]) ||
    parsed.success !== true ||
    parsed.surface !== 'web' ||
    typeof parsed.sessionId !== 'string' ||
    !isValidSessionId(parsed.sessionId) ||
    parsed.finalMarkerSeen !== true ||
    parsed.hiddenMarkerSeen !== false ||
    parsed.httpHistoryClean !== true ||
    parsed.sseClean !== true ||
    parsed.domClean !== true ||
    parsed.htmlClean !== true ||
    parsed.reloadCompleted !== true ||
    parsed.launcherGone !== true ||
    parsed.portReusable !== true ||
    !Array.isArray(parsed.faults) ||
    parsed.faults.length !== 0 ||
    recovery.kind !== 'web_reload' ||
    recovery.completed !== true ||
    !isNonNegativeSafeInteger(recovery.providerRequestsBefore) ||
    !isNonNegativeSafeInteger(recovery.providerRequestsAfter) ||
    recovery.providerRequestsBefore !== recovery.providerRequestsAfter
  ) {
    throw new Error('Token-budget Web evidence is incomplete');
  }
  return {
    success: true,
    surface: 'web',
    sessionId: parsed.sessionId,
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    recovery: {
      kind: 'web_reload',
      completed: true,
      providerRequestsBefore: recovery.providerRequestsBefore,
      providerRequestsAfter: recovery.providerRequestsAfter,
    },
    faults: [],
    httpHistoryClean: true,
    sseClean: true,
    domClean: true,
    htmlClean: true,
    reloadCompleted: true,
    launcherGone: true,
    portReusable: true,
  };
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
    throw new Error('Token-budget Web port reservation failed');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function assertPortReusable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForHttp(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The production server has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Token-budget Web server readiness timed out');
}

async function waitForActiveRun(input: {
  page: Page;
  origin: string;
  sessionId: string;
  workspace: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${input.origin}/sessions/${encodeURIComponent(
        input.sessionId
      )}/status?projectPath=${encodeURIComponent(input.workspace)}`
    );
    if (response.ok) {
      const value: unknown = await response.json();
      if (isRecord(value) && value.status === 'running') return;
      if (
        isRecord(value) &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          String(value.status)
        )
      ) {
        throw new Error('Token-budget Web run completed before reload injection');
      }
    }
    await input.page.waitForTimeout(50);
  }
  throw new Error('Token-budget Web active run was not observed');
}

async function waitForCompletedRun(input: {
  page: Page;
  origin: string;
  sessionId: string;
  workspace: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${input.origin}/sessions/${encodeURIComponent(
        input.sessionId
      )}/status?projectPath=${encodeURIComponent(input.workspace)}`
    );
    if (response.ok) {
      const value: unknown = await response.json();
      if (isRecord(value) && value.status === 'completed') return;
      if (
        isRecord(value) &&
        ['failed', 'cancelled', 'interrupted'].includes(String(value.status))
      ) {
        throw new Error('Token-budget Web run ended unsuccessfully');
      }
    }
    await input.page.waitForTimeout(100);
  }
  throw new Error('Token-budget Web completion was not observed');
}

async function history(input: {
  origin: string;
  sessionId: string;
  workspace: string;
}): Promise<unknown> {
  const response = await fetch(
    `${input.origin}/sessions/${encodeURIComponent(
      input.sessionId
    )}/message?projectPath=${encodeURIComponent(input.workspace)}`
  );
  if (!response.ok) {
    throw new Error(`Token-budget Web history failed with ${response.status}`);
  }
  return await response.json();
}

async function waitForFinal(input: {
  page: Page;
  origin: string;
  sessionId: string;
  workspace: string;
  marker: string;
  timeoutMs: number;
  providerRequestCount: () => number;
  providerEvidence: () => TokenBudgetProxyEvidence;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let status: unknown = 'unknown';
  let publicFinalSeen = false;
  let domFinalSeen = false;
  while (Date.now() < deadline) {
    const messages = await history(input);
    publicFinalSeen =
      Array.isArray(messages) &&
      messages.some(
        (message) =>
          isRecord(message) &&
          message.role === 'assistant' &&
          message.content === input.marker
      );
    if (publicFinalSeen) {
      const assistant = input.page
        .locator('[data-chat-role="assistant"]')
        .filter({ hasText: input.marker });
      domFinalSeen = (await assistant.count()) > 0;
      if (domFinalSeen) return;
    }
    const statusResponse = await fetch(
      `${input.origin}/sessions/${encodeURIComponent(
        input.sessionId
      )}/status?projectPath=${encodeURIComponent(input.workspace)}`
    );
    if (statusResponse.ok) {
      const value: unknown = await statusResponse.json();
      status = isRecord(value) ? value.status : 'unknown';
      if (
        typeof status === 'string' &&
        [
          'completed',
          'failed',
          'cancelled',
          'interrupted',
          'idle',
          'waiting_permission',
          'error',
        ].includes(status)
      ) {
        break;
      }
    }
    await input.page.waitForTimeout(250);
  }
  let providerRequests = Number.NaN;
  try {
    providerRequests = input.providerRequestCount();
  } catch {
    // The diagnostic formatter maps this to the fixed invalid bucket.
  }
  let proxyDiagnostic = 'first_none:s0:unknown:unknown:rewritten_0:inflight_invalid';
  try {
    proxyDiagnostic = formatTokenBudgetWebProxyDiagnostic(input.providerEvidence());
  } catch {
    // Keep the fixed invalid diagnostic if the evidence callback fails.
  }
  const finalDiagnostic = formatTokenBudgetWebFinalDiagnostic({
    status,
    providerRequests,
    publicFinalSeen,
    domFinalSeen,
  });
  throw new TokenBudgetWebFinalTimeoutError(
    `${finalDiagnostic}:proxy_${proxyDiagnostic}`
  );
}

async function collectEvents(
  page: Page,
  aggregate: string[]
): Promise<{ hiddenSeen: boolean; overflowed: boolean }> {
  await page.evaluate(async () => {
    window.__bladeTokenBudgetCloseEventSources();
    await Promise.allSettled(window.__bladeTokenBudgetPendingScans.splice(0));
  });
  const pageEvidence = await page.evaluate(() => ({
    events: window.__bladeTokenBudgetEvents.splice(0),
    hiddenSeen: window.__bladeTokenBudgetHiddenSeen,
    overflowed: window.__bladeTokenBudgetEventOverflowed,
  }));
  aggregate.push(...pageEvidence.events);
  if (aggregate.length > 512) {
    throw new Error('Token-budget Web SSE aggregate exceeded its budget');
  }
  return {
    hiddenSeen: pageEvidence.hiddenSeen,
    overflowed: pageEvidence.overflowed,
  };
}

function scanChunks(
  child: ChildProcess,
  secrets: readonly string[]
): { hidden: () => boolean; stop: () => void } {
  let hidden = false;
  let tail = '';
  const needles = [...FORBIDDEN, ...secrets.filter(Boolean)];
  const maxNeedle = Math.max(1, ...needles.map((value) => value.length));
  const onChunk = (chunk: Buffer | string): void => {
    const scan = `${tail}${chunk.toString()}`;
    hidden ||= needles.some((value) => value && scan.includes(value));
    tail = scan.slice(-(maxNeedle - 1));
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  return {
    hidden: () => hidden,
    stop: () => {
      child.stdout?.off('data', onChunk);
      child.stderr?.off('data', onChunk);
    },
  };
}

export async function runTokenBudgetHandoffWebDriver(input: {
  root: string;
  model: string;
  proxyBaseURL: string;
  fixture: TokenBudgetHandoffFixture;
  providerRequestCount: () => number;
  providerEvidence: () => TokenBudgetProxyEvidence;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<TokenBudgetHandoffWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 300_000;
  if (
    !path.isAbsolute(input.root) ||
    !path.isAbsolute(input.fixture.workspace) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !FINAL_MARKER_PATTERN.test(input.fixture.finalMarker) ||
    input.fixture.prompt.includes(input.fixture.finalMarker)
  ) {
    throw new Error('Token-budget Web input contract is invalid');
  }
  const root = path.resolve(input.root);
  const deadline = Date.now() + timeoutMs - 10_000;
  const workspace = path.resolve(input.fixture.workspace);
  const home = path.join(root, 'home');
  const storageRoot = path.join(root, 'storage');
  const secrets = input.secrets ?? [];
  const port = await reservePort();
  const launcher = path.resolve(
    import.meta.dirname,
    'launch-token-budget-handoff-gui.ts'
  );
  const encoded = Buffer.from(
    JSON.stringify({
      root,
      workspace,
      home,
      storageRoot,
      port,
      model: input.model,
      proxyBaseURL: input.proxyBaseURL,
    }),
    'utf8'
  ).toString('base64');
  const child = spawn('bun', [launcher], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, BLADE_TOKEN_BUDGET_WEB_INPUT: encoded },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunkScan = scanChunks(child, secrets);
  let identity:
    | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
    | undefined;
  let stopStdoutDrain: (() => void) | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let sessionId = '';
  let refreshing = false;
  let closing = false;
  const faults: string[] = [];
  const recordedSse: string[] = [];
  let reloadCompleted = false;
  let before = 0;
  let after = 0;
  let runError: unknown;
  let failureStage: WebFailureStage = 'launcher_identity';
  let failureCode = 'stage_failed';
  let launcherGone = false;
  let portReusable = false;
  try {
    if (!child.pid) throw new Error('Token-budget GUI launcher PID is missing');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    failureStage = 'launcher_ready';
    const ready = await waitForForegroundGuiLauncherReady(
      child,
      remainingStageBudget(deadline, 20_000),
      secrets
    );
    stopStdoutDrain = ready.stopDrain;
    const origin = `http://127.0.0.1:${port}`;
    failureStage = 'server_ready';
    await waitForHttp(origin, remainingStageBudget(deadline, 20_000));
    failureStage = 'session_create';
    const create = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: workspace, title: 'Token budget handoff' }),
    });
    if (!create.ok) throw new Error('Token-budget Web session creation failed');
    const created: unknown = await create.json();
    if (!isRecord(created) || typeof created.sessionId !== 'string') {
      throw new Error('Token-budget Web session identity is missing');
    }
    sessionId = created.sessionId;
    if (!isValidSessionId(sessionId)) {
      throw new Error('Token-budget Web session identity is invalid');
    }

    failureStage = 'browser_launch';
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let sseSecretSeen = false;
    await context.exposeBinding(
      '__bladeTokenBudgetObserveSse',
      (_source, payload: string) => {
        sseSecretSeen ||= secrets.some((secret) => secret && payload.includes(secret));
      }
    );
    await context.addInitScript(
      ({ forbidden }) => {
        const NativeEventSource = window.EventSource;
        const recorded: string[] = [];
        const pendingScans: Promise<void>[] = [];
        const sources: EventSource[] = [];
        let overflowed = false;
        let hiddenSeen = false;
        class RecordingEventSource extends NativeEventSource {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            sources.push(this);
            this.addEventListener('message', (event) => {
              const text = String((event as MessageEvent).data);
              hiddenSeen ||= forbidden.some((value) => text.includes(value));
              pendingScans.push(window.__bladeTokenBudgetObserveSse(text));
              recorded.push(text.length <= 8_192 ? text : text.slice(-8_192));
              if (recorded.length > 256) {
                overflowed = true;
                recorded.shift();
              }
            });
          }
        }
        Object.defineProperty(window, 'EventSource', { value: RecordingEventSource });
        Object.defineProperty(window, '__bladeTokenBudgetEvents', {
          value: recorded,
          writable: false,
        });
        Object.defineProperty(window, '__bladeTokenBudgetEventOverflowed', {
          get: () => overflowed,
        });
        Object.defineProperty(window, '__bladeTokenBudgetHiddenSeen', {
          get: () => hiddenSeen,
        });
        Object.defineProperty(window, '__bladeTokenBudgetPendingScans', {
          value: pendingScans,
          writable: false,
        });
        Object.defineProperty(window, '__bladeTokenBudgetCloseEventSources', {
          value: () => {
            for (const source of sources.splice(0)) source.close();
          },
          writable: false,
        });
      },
      { forbidden: [...FORBIDDEN] }
    );
    failureStage = 'page_ready';
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
    navigation.searchParams.set('session', sessionId);
    navigation.searchParams.set('project', workspace);
    await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible' });
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
    failureStage = 'task_start';
    await composer.fill(input.fixture.prompt);
    await composer.press('Enter');
    await waitForActiveRun({
      page,
      origin,
      sessionId,
      workspace,
      timeoutMs: remainingStageBudget(deadline, 30_000),
    });
    const firstPage = await collectEvents(page, recordedSse);
    if (firstPage.hiddenSeen || firstPage.overflowed) {
      throw new Error('Token-budget Web first-page SSE evidence was unsafe');
    }
    failureStage = 'first_reload';
    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await composer.waitFor({ state: 'visible' });
    await waitForFinal({
      page,
      origin,
      sessionId,
      workspace,
      marker: input.fixture.finalMarker,
      timeoutMs: remainingStageBudget(deadline, timeoutMs),
      providerRequestCount: input.providerRequestCount,
      providerEvidence: input.providerEvidence,
    });
    failureStage = 'completion';
    await waitForCompletedRun({
      page,
      origin,
      sessionId,
      workspace,
      timeoutMs: remainingStageBudget(deadline, 30_000),
    });

    const count = (): number => {
      try {
        const value = input.providerRequestCount();
        if (!isNonNegativeSafeInteger(value)) throw new Error('invalid');
        return value;
      } catch {
        throw new Error('Token-budget Web Provider request count failed');
      }
    };
    const runningPage = await collectEvents(page, recordedSse);
    if (runningPage.hiddenSeen || runningPage.overflowed) {
      throw new Error('Token-budget Web running-page SSE evidence was unsafe');
    }
    before = count();
    failureStage = 'recovery_reload';
    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await composer.waitFor({ state: 'visible' });
    await waitForFinal({
      page,
      origin,
      sessionId,
      workspace,
      marker: input.fixture.finalMarker,
      timeoutMs: remainingStageBudget(deadline, 30_000),
      providerRequestCount: input.providerRequestCount,
      providerEvidence: input.providerEvidence,
    });
    const finalPage = await collectEvents(page, recordedSse);
    if (finalPage.hiddenSeen || finalPage.overflowed) {
      throw new Error('Token-budget Web final-page SSE evidence was unsafe');
    }
    const publicHistory = await history({ origin, sessionId, workspace });
    const domText = await page.locator('body').innerText();
    const html = await page.content();
    failureStage = 'privacy';
    assertSafe({ publicHistory, recordedSse, domText, html, faults }, secrets);
    if (faults.length !== 0 || chunkScan.hidden() || sseSecretSeen) {
      throw new Error('Token-budget Web surface recorded faults or hidden output');
    }
    after = count();
    if (before !== after) {
      throw new Error('Token-budget Web reload issued a Provider request');
    }
    reloadCompleted = true;
  } catch (error) {
    if (failureStage === 'launcher_ready') {
      failureCode = launcherReadyFailureCode(error, child);
    } else if (error instanceof TokenBudgetWebFinalTimeoutError) {
      failureCode = error.diagnostic;
    }
    runError = error;
  } finally {
    closing = true;
    await browser?.close().catch((error) => {
      if (!runError) failureStage = 'browser_cleanup';
      runError ??= error;
    });
    await stopForegroundGuiLauncher(child, identity).catch((error) => {
      if (!runError) failureStage = 'launcher_cleanup';
      runError ??= error;
    });
    if (chunkScan.hidden()) {
      if (!runError) failureStage = 'privacy_cleanup';
      runError ??= new Error('Token-budget GUI teardown exposed hidden material');
    }
    stopStdoutDrain?.();
    chunkScan.stop();
    launcherGone =
      child.pid !== undefined &&
      identity !== undefined &&
      !processIdentityMatches(child.pid, identity);
    if (!launcherGone && !runError) {
      failureStage = 'launcher_cleanup';
      failureCode = 'cleanup_incomplete';
      runError = new Error('Token-budget GUI launcher remained alive');
    }
    await assertPortReusable(port)
      .then(() => {
        portReusable = true;
      })
      .catch((error) => {
        if (!runError) failureStage = 'port_cleanup';
        runError ??= error;
      });
  }
  if (runError || !launcherGone || !portReusable || !reloadCompleted) {
    throw new Error(
      `Token-budget Web production driver failed at ${failureStage}:${failureCode}`
    );
  }
  return parseTokenBudgetHandoffWebEvidence(
    JSON.stringify({
      success: true,
      surface: 'web',
      sessionId,
      finalMarkerSeen: true,
      hiddenMarkerSeen: false,
      recovery: {
        kind: 'web_reload',
        completed: true,
        providerRequestsBefore: before,
        providerRequestsAfter: after,
      },
      faults: [],
      httpHistoryClean: true,
      sseClean: true,
      domClean: true,
      htmlClean: true,
      reloadCompleted: true,
      launcherGone: true,
      portReusable: true,
    }),
    secrets
  );
}
