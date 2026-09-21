import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, request as requestHttp, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  type Browser,
  type BrowserContextOptions,
  chromium,
  type Page,
} from 'playwright';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import { reserveLoopbackPort, waitForHttp } from './asyncTestUtils.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';
import { observeBrowserFaults } from './webTestUtils.js';

interface BladeWebServerOptions {
  workspace: string;
  home: string;
  storageRoot: string;
  cliEntry?: string;
  args?: string[];
  autoMemory?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  outputLimit?: number;
  readyTimeoutMs?: number;
  onOutput?(chunk: Buffer | string): void;
}

export interface BladeWebServerHarness {
  child: ChildProcess;
  origin: string;
  readonly output: string;
  close(): Promise<void>;
}

export interface ObservedBrowserHarness {
  browser: Browser;
  page: Page;
  faults: string[];
  state: {
    refreshing: boolean;
    closing: boolean;
  };
  close(): Promise<void>;
}

export interface BladeWebTestHarness {
  server: BladeWebServerHarness;
  browser: ObservedBrowserHarness;
  origin: string;
  page: Page;
  faults: string[];
  state: ObservedBrowserHarness['state'];
}

interface ObservedBrowserOptions {
  context?: BrowserContextOptions;
  includeHttpErrors?: boolean;
}

function definedEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

export async function startBladeWebServer(
  options: BladeWebServerOptions
): Promise<BladeWebServerHarness> {
  const port = await reserveLoopbackPort();
  const cliEntry =
    options.cliEntry ?? path.resolve(import.meta.dirname, '../../dist/blade.js');
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      ...(options.args ?? ['--trust-workspace']),
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: options.workspace,
      env: definedEnvironment({
        ...(options.baseEnv ?? process.env),
        HOME: options.home,
        BLADE_STORAGE_ROOT: options.storageRoot,
        BLADE_AUTO_MEMORY: options.autoMemory ? '1' : '0',
        BLADE_TELEMETRY_DISABLED: '1',
        ...options.env,
      }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let identity: ProcessIdentity | undefined;
  let output = '';
  const observe = (chunk: Buffer | string) => {
    options.onOutput?.(chunk);
    output = `${output}${chunk.toString()}`.slice(-(options.outputLimit ?? 16_384));
  };
  child.stdout?.on('data', observe);
  child.stderr?.on('data', observe);

  try {
    if (!child.pid) throw new Error('Blade Web server has no process ID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`, options.readyTimeoutMs ?? 20_000);
    let closePromise: Promise<void> | undefined;
    return {
      child,
      origin,
      get output() {
        return output;
      },
      close() {
        closePromise ??= stopForegroundGuiLauncher(child, identity);
        return closePromise;
      },
    };
  } catch (error) {
    await stopForegroundGuiLauncher(child, identity);
    throw error;
  }
}

export async function createObservedBrowserHarness(
  options: ObservedBrowserOptions = {}
): Promise<ObservedBrowserHarness> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(options.context);
  const page = await context.newPage();
  const faults: string[] = [];
  const state = { refreshing: false, closing: false };
  observeBrowserFaults(page, faults, () => state, options.includeHttpErrors ?? true);
  return {
    browser,
    page,
    faults,
    state,
    async close() {
      state.closing = true;
      await browser.close().catch(() => undefined);
    },
  };
}

export async function startSessionEventRelay(options: {
  origin: string;
  browserOrigin: string;
  sessionId: string;
}) {
  const connections: URL[] = [];
  const disconnectors = new Set<() => void>();
  const held = new Map<ServerResponse, () => void>();
  const requests = new Set<ReturnType<typeof requestHttp>>();
  let paused = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', options.origin);
    if (url.pathname !== `/sessions/${options.sessionId}/events`) {
      response.writeHead(404).end();
      return;
    }
    connections.push(url);
    const forward = () => {
      held.delete(response);
      if (response.destroyed) return;
      const upstream = requestHttp(url, { headers: request.headers }, (source) => {
        response.writeHead(source.statusCode ?? 502, {
          ...source.headers,
          'access-control-allow-origin': options.browserOrigin,
        });
        source.once('error', () => response.destroy());
        source.pipe(response);
        const disconnect = () => {
          source.unpipe(response);
          response.end();
          source.destroy();
          upstream.destroy();
        };
        disconnectors.add(disconnect);
        response.once('close', () => {
          disconnectors.delete(disconnect);
          source.destroy();
          upstream.destroy();
        });
      });
      requests.add(upstream);
      upstream.once('close', () => requests.delete(upstream));
      upstream.once('error', () => response.destroy());
      response.once('close', () => upstream.destroy());
      upstream.end();
    };
    if (paused) {
      held.set(response, forward);
      response.once('close', () => held.delete(response));
    } else forward();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing SSE relay port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    connections,
    get heldCount() {
      return held.size;
    },
    disconnectAndHold() {
      paused = true;
      for (const disconnect of disconnectors) disconnect();
    },
    release() {
      paused = false;
      for (const forward of held.values()) forward();
    },
    async close() {
      for (const response of held.keys()) response.destroy();
      for (const request of requests) request.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

export async function withBladeWebTest<T>(
  serverOptions: BladeWebServerOptions,
  browserOptions: ObservedBrowserOptions,
  run: (harness: BladeWebTestHarness) => Promise<T>
): Promise<T> {
  const server = await startBladeWebServer(serverOptions);
  let browser: ObservedBrowserHarness | undefined;
  try {
    browser = await createObservedBrowserHarness(browserOptions);
    return await run({
      server,
      browser,
      origin: server.origin,
      page: browser.page,
      faults: browser.faults,
      state: browser.state,
    });
  } finally {
    await browser?.close();
    await server.close();
  }
}
