import { type ChildProcess, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  captureProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../src/utils/process/ProcessIdentity.js';
import type { ForegroundBoundedOutputFixture } from '../integration/real-api/foregroundBoundedOutputFixture.js';

const GUI_LAUNCHER_IDENTITY_TIMEOUT_MS = 2_000;
const GUI_LAUNCHER_IDENTITY_RETRY_MS = 25;

export interface ForegroundBoundedOutputWebEvidence {
  sessionId: string;
  markerVisible: boolean;
  outputChars: number;
  reloadOutputChars: number;
  reconnectedDuringRun: boolean;
  browserFaults: string[];
}

interface BrowserRequestFailure {
  url: string;
  resourceType: string;
  errorText: string;
  refreshing: boolean;
  closing: boolean;
}

export function isExpectedBrowserRequestFailure(
  failure: BrowserRequestFailure
): boolean {
  if (failure.closing) return true;
  const aborted = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure.errorText);
  if (!aborted) return false;
  if (new URL(failure.url).pathname.endsWith('/events')) return true;
  return failure.refreshing && failure.resourceType === 'document';
}

export function isTerminalForegroundWebRunStatus(status: unknown): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

export function parseForegroundGuiReadyLine(
  line: string
): { ready: true; port: number } | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed.ready === true &&
      typeof parsed.port === 'number' &&
      Number.isSafeInteger(parsed.port) &&
      parsed.port > 0
      ? { ready: true, port: parsed.port }
      : undefined;
  } catch {
    return undefined;
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve browser qualification port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > 16_384 ? next.slice(-16_384) : next;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter(Boolean)
    .reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), value);
}

export async function waitForForegroundGuiLauncherReady(
  child: ChildProcess,
  timeoutMs: number,
  secrets: readonly string[]
): Promise<{
  ready: true;
  port: number;
  output: () => string;
  stopDrain: () => void;
}> {
  let output = '';
  let pending = '';
  let pendingOverflowed = false;
  let readyFound = false;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupReadiness();
      stopDrain();
      reject(
        new Error(
          `GUI launcher ready timeout: ${redact(output.slice(-2_000), secrets)}`
        )
      );
    }, timeoutMs);
    const cleanupReadiness = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const stopDrain = () => child.stdout?.off('data', onStdout);
    const onStdout = (chunk: Buffer | string) => {
      output = appendTail(output, chunk);
      if (readyFound) return;
      const text = chunk.toString();
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset);
        const end = newline >= 0 ? newline : text.length;
        const segment = text.slice(offset, end);
        pendingOverflowed ||= pending.length + segment.length > 16_384;
        pending = appendTail(pending, segment);
        if (newline < 0) return;

        const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        const ready = pendingOverflowed ? undefined : parseForegroundGuiReadyLine(line);
        pending = '';
        pendingOverflowed = false;
        if (ready) {
          readyFound = true;
          cleanupReadiness();
          resolve({ ...ready, output: () => output, stopDrain });
          return;
        }
        offset = newline + 1;
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupReadiness();
      stopDrain();
      reject(
        new Error(
          `GUI launcher exited before ready (${code ?? signal ?? 'unknown'}): ${redact(
            output.slice(-2_000),
            secrets
          )}`
        )
      );
    };
    const onError = (error: Error) => {
      cleanupReadiness();
      stopDrain();
      reject(error);
    };
    child.stdout?.on('data', onStdout);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function captureForegroundGuiLauncherIdentity(
  pid: number,
  options: {
    timeoutMs?: number;
    retryMs?: number;
    capture?: (candidatePid: number) => ProcessIdentity | undefined;
  } = {}
): Promise<ProcessIdentity> {
  const timeoutMs = options.timeoutMs ?? GUI_LAUNCHER_IDENTITY_TIMEOUT_MS;
  const retryMs = options.retryMs ?? GUI_LAUNCHER_IDENTITY_RETRY_MS;
  const capture = options.capture ?? captureProcessIdentity;
  const deadline = Date.now() + timeoutMs;

  do {
    const identity = capture(pid);
    if (identity) return identity;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, remaining)));
  } while (Date.now() <= deadline);

  throw new Error('Unable to capture GUI launcher process identity');
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Blade Web server did not become ready (status ${lastStatus})`);
}

async function waitForAssistantMarker(input: {
  page: Page;
  origin: string;
  sessionId: string;
  workspace: string;
  marker: string;
  timeoutMs: number;
}): Promise<void> {
  const marker = input.page
    .locator('[data-chat-role="assistant"]')
    .filter({ hasText: input.marker })
    .last();
  const deadline = Date.now() + input.timeoutMs;
  let lastStatus: unknown = 'unknown';

  while (Date.now() < deadline) {
    if ((await marker.count()) > 0 && (await marker.isVisible())) return;
    try {
      const statusResponse = await fetch(
        `${input.origin}/sessions/${encodeURIComponent(
          input.sessionId
        )}/status?projectPath=${encodeURIComponent(input.workspace)}`
      );
      if (statusResponse.ok) {
        const status = (await statusResponse.json()) as { status?: unknown };
        lastStatus = status.status;
        if (lastStatus === 'waiting_permission') {
          throw new Error(
            'Web bounded output qualification unexpectedly requested permission'
          );
        }
        if (isTerminalForegroundWebRunStatus(lastStatus)) {
          await input.page.waitForTimeout(500);
          if ((await marker.count()) > 0 && (await marker.isVisible())) return;
          const cards = await input.page
            .locator('[data-tool-name]')
            .evaluateAll((elements) =>
              elements.map((element) => ({
                name: element.getAttribute('data-tool-name'),
                status: element.getAttribute('data-tool-status'),
              }))
            );
          throw new Error(
            `Web run reached ${String(
              lastStatus
            )} without the assistant marker; visibleToolCards=${JSON.stringify(cards)}`
          );
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('Web run reached ') ||
          error.message.includes('unexpectedly requested permission'))
      ) {
        throw error;
      }
    }
    await input.page.waitForTimeout(250);
  }

  const cards = await input.page.locator('[data-tool-name]').evaluateAll((elements) =>
    elements.map((element) => ({
      name: element.getAttribute('data-tool-name'),
      status: element.getAttribute('data-tool-status'),
    }))
  );
  throw new Error(
    `Timed out waiting for assistant marker (run status ${String(
      lastStatus
    )}); visibleToolCards=${JSON.stringify(cards)}`
  );
}

async function waitForActiveWebRun(input: {
  page: Page;
  origin: string;
  sessionId: string;
  workspace: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastStatus: unknown = 'unknown';
  while (Date.now() < deadline) {
    const response = await fetch(
      `${input.origin}/sessions/${encodeURIComponent(
        input.sessionId
      )}/status?projectPath=${encodeURIComponent(input.workspace)}`
    );
    if (response.ok) {
      const status = (await response.json()) as { status?: unknown };
      lastStatus = status.status;
      if (lastStatus === 'running') return;
      if (lastStatus === 'waiting_permission') {
        throw new Error(
          'Web bounded output qualification unexpectedly requested permission'
        );
      }
      if (isTerminalForegroundWebRunStatus(lastStatus)) {
        throw new Error(
          `Web run reached ${String(lastStatus)} before reconnect injection`
        );
      }
    }
    await input.page.waitForTimeout(50);
  }
  throw new Error(
    `Timed out waiting to inject Web reconnect (run status ${String(lastStatus)})`
  );
}

function launcherExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForLauncherExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (launcherExited(child)) return true;
  return await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
    if (launcherExited(child)) {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(true);
    }
  });
}

export async function stopForegroundGuiLauncher(
  child: ChildProcess,
  identity: ProcessIdentity | undefined
): Promise<void> {
  if (launcherExited(child)) return;

  if (!child.pid || !identity) {
    child.kill('SIGTERM');
    if (await waitForLauncherExit(child, 5_000)) return;
    child.kill('SIGKILL');
    if (!(await waitForLauncherExit(child, 5_000))) {
      throw new Error('Unidentified GUI launcher process remained after cleanup');
    }
    return;
  }

  if (!processIdentityMatches(child.pid, identity)) {
    if (launcherExited(child)) return;
    throw new Error('GUI launcher process identity changed before cleanup');
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const graceful = await waitForLauncherExit(child, 5_000);
  if (!graceful && processIdentityMatches(child.pid, identity)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    await waitForLauncherExit(child, 5_000);
  }
  if (!launcherExited(child)) {
    if (processIdentityMatches(child.pid, identity)) {
      throw new Error('GUI launcher process remained after cleanup');
    }
    throw new Error('GUI launcher process identity changed during cleanup');
  }
}

async function expandAndReadBashCard(
  page: Page,
  fixture: ForegroundBoundedOutputFixture,
  timeoutMs: number,
  freshHistorySummary: () => Promise<string>
): Promise<number> {
  const cardSelector = '[data-tool-name="Bash"][data-tool-status="success"]';
  const deadline = Date.now() + timeoutMs;
  let toolCallId: string | undefined;

  while (Date.now() < deadline) {
    const state = await page.evaluate(
      ({ selector, expectedToolCallId }) => {
        for (const groupToggle of Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-agent-tool-group] > button'
          )
        ).reverse()) {
          if (groupToggle.getAttribute('aria-expanded') !== 'true') {
            groupToggle.click();
          }
        }
        const cards = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const card = expectedToolCallId
          ? cards.find((candidate) =>
              Array.from(
                candidate.querySelectorAll<HTMLElement>('[data-tool-call-id]')
              ).some(
                (toggle) =>
                  toggle.getAttribute('data-tool-call-id') === expectedToolCallId
              )
            )
          : cards.at(-1);
        if (!card) return undefined;
        const toggle = card.querySelector<HTMLButtonElement>(
          'button[data-tool-call-id]'
        );
        const observedToolCallId = toggle?.getAttribute('data-tool-call-id');
        if (!toggle || !observedToolCallId) return undefined;
        const truncated = card.getAttribute('data-tool-truncated') === 'true';
        if (toggle.getAttribute('aria-expanded') !== 'true') {
          toggle.click();
          return {
            toolCallId: observedToolCallId,
            truncated,
            expanded: false,
          };
        }
        const output = card.querySelector<HTMLElement>('[data-tool-output]');
        if (!output) {
          return {
            toolCallId: observedToolCallId,
            truncated,
            expanded: true,
          };
        }
        return {
          toolCallId: observedToolCallId,
          truncated,
          expanded: true,
          text: output.textContent ?? '',
          truncationNotices: card.querySelectorAll('[data-tool-truncation-notice]')
            .length,
        };
      },
      { selector: cardSelector, expectedToolCallId: toolCallId }
    );
    toolCallId ??= state?.toolCallId;
    if (state && !state.truncated) {
      throw new Error('Bash browser card did not expose truncation state');
    }
    if (state?.text !== undefined) {
      const text = state.text;
      if (
        !text.includes(fixture.stdoutTail) ||
        !text.includes(fixture.stderrTail) ||
        text.includes(fixture.stdoutPrefixSentinel) ||
        text.includes(fixture.stderrPrefixSentinel)
      ) {
        throw new Error('Bash browser card violated retained output markers');
      }
      if (state.truncationNotices !== 1) {
        throw new Error('Bash browser card truncation notice count is invalid');
      }
      if (text.length > 500) {
        throw new Error(`Bash browser card output exceeded 500 chars: ${text.length}`);
      }
      return text.length;
    }
    await page.waitForTimeout(50);
  }

  const cards = await page.locator('[data-tool-name]').evaluateAll((elements) =>
    elements.map((element) => ({
      name: element.getAttribute('data-tool-name'),
      status: element.getAttribute('data-tool-status'),
    }))
  );
  throw new Error(
    `Timed out reading the durable Bash card; toolCallId=${
      toolCallId ?? 'unresolved'
    }; visibleToolCards=${JSON.stringify(
      cards
    )}; freshHistory=${await freshHistorySummary()}`
  );
}

export async function runForegroundBoundedOutputWebDriver(input: {
  root: string;
  model: string;
  fixture: ForegroundBoundedOutputFixture;
  secrets: readonly string[];
  timeoutMs?: number;
}): Promise<ForegroundBoundedOutputWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const port = await reservePort();
  const launcherScript = path.resolve(
    import.meta.dirname,
    'launch-foreground-bounded-output-gui.ts'
  );
  const child = spawn('bun', [launcherScript, input.root, String(port), input.model], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let identity: ProcessIdentity | undefined;
  let stopStdoutDrain: (() => void) | undefined;
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = appendTail(stderrTail, chunk);
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closing = false;
  let refreshing = false;
  const faults: string[] = [];
  try {
    if (!child.pid) throw new Error('GUI launcher did not expose a process ID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const ready = await waitForForegroundGuiLauncherReady(child, 20_000, input.secrets);
    stopStdoutDrain = ready.stopDrain;
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin, 20_000);
    const workspace = await realpath(path.join(input.root, 'project'));
    const response = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        title: 'Bounded foreground output qualification',
      }),
    });
    if (!response.ok) throw new Error(`Session creation failed: ${response.status}`);
    const created = (await response.json()) as { sessionId?: unknown };
    if (typeof created.sessionId !== 'string') {
      throw new Error('Session creation did not return an ID');
    }
    const sessionId = created.sessionId;
    const freshHistorySummary = async (): Promise<string> => {
      const history = await fetch(
        `${origin}/sessions/${encodeURIComponent(
          sessionId
        )}/message?projectPath=${encodeURIComponent(workspace)}`
      );
      if (!history.ok) return `http-${history.status}`;
      const messages = (await history.json()) as Array<Record<string, unknown>>;
      return JSON.stringify(
        messages.map((message) => ({
          role: message.role,
          name: message.name,
          toolCallId: message.tool_call_id,
          toolCalls: Array.isArray(message.tool_calls)
            ? message.tool_calls.map((toolCall) => {
                const record =
                  toolCall && typeof toolCall === 'object'
                    ? (toolCall as Record<string, unknown>)
                    : {};
                const functionRecord =
                  record.function && typeof record.function === 'object'
                    ? (record.function as Record<string, unknown>)
                    : {};
                return {
                  id: record.id,
                  name: functionRecord.name,
                };
              })
            : [],
          status:
            message.metadata && typeof message.metadata === 'object'
              ? (message.metadata as Record<string, unknown>).status
              : undefined,
        }))
      );
    };

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(`console:${message.text()}`);
    });
    page.on('response', (browserResponse) => {
      if (browserResponse.status() >= 400) {
        faults.push(`http:${browserResponse.status()}:${browserResponse.url()}`);
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
    await composer.fill(input.fixture.localPrompt);
    await composer.press('Enter');
    const marker = `BOUNDED_FOREGROUND_OK_${input.fixture.stdoutTail.replace(
      'STDOUT_RETAINED_TAIL_',
      ''
    )}`;
    await waitForActiveWebRun({
      page,
      origin,
      sessionId,
      workspace,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await composer.waitFor({ state: 'visible' });
    await waitForAssistantMarker({
      page,
      origin,
      sessionId,
      workspace,
      marker,
      timeoutMs,
    });
    const outputChars = await expandAndReadBashCard(
      page,
      input.fixture,
      timeoutMs,
      freshHistorySummary
    );

    refreshing = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    refreshing = false;
    await composer.waitFor({ state: 'visible' });
    const reloadOutputChars = await expandAndReadBashCard(
      page,
      input.fixture,
      timeoutMs,
      freshHistorySummary
    );
    await page.waitForTimeout(1_000);

    if (faults.length > 0) {
      throw new Error(
        `Browser faults: ${redact(JSON.stringify(faults), input.secrets)}`
      );
    }
    return {
      sessionId,
      markerVisible: true,
      outputChars,
      reloadOutputChars,
      reconnectedDuringRun: true,
      browserFaults: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${redact(message, input.secrets)}; launcher=${redact(
        stderrTail.slice(-2_000),
        input.secrets
      )}`
    );
  } finally {
    closing = true;
    await browser?.close().catch(() => undefined);
    try {
      await stopForegroundGuiLauncher(child, identity);
    } finally {
      stopStdoutDrain?.();
    }
  }
}
