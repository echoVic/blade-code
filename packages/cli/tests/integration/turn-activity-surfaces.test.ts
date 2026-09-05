import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionSchema } from '../../src/api/schemas.js';

vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../support/turnActivityPtyRunner.ts'
);
const roots: string[] = [];
let createHttpServer: typeof import('node:http').createServer;

beforeAll(async () => {
  await access(cliEntry);
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

async function startProvider(marker: string) {
  let requests = 0;
  const server: Server = createHttpServer((_request, response) => {
    void (async () => {
      for await (const _chunk of _request) {
        // Drain the request body before responding.
      }
      requests++;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      if (requests === 1) {
        response.write(
          `data: ${JSON.stringify({
            id: 'activity-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'activity-bash',
                      type: 'function',
                      function: {
                        name: 'Bash',
                        arguments: JSON.stringify({
                          command: 'node -e "setTimeout(() => process.exit(7), 8000)"',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            id: 'activity-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          })}\n\n`
        );
      } else {
        response.write(
          `data: ${JSON.stringify({
            id: 'activity-final',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: marker },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            id: 'activity-final',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          })}\n\n`
        );
      }
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitForHttp(origin: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Turn activity Web server did not become ready');
}

async function openEventProbe(origin: string, sessionId: string, projectPath: string) {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error('Turn activity SSE unavailable');
  const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const reading = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const event = JSON.parse(data) as {
            type?: unknown;
            properties?: unknown;
          };
          if (
            typeof event.type === 'string' &&
            event.properties &&
            typeof event.properties === 'object' &&
            !Array.isArray(event.properties)
          ) {
            events.push({
              type: event.type,
              properties: event.properties as Record<string, unknown>,
            });
          }
        }
      }
    } catch {
      // Abort closes the diagnostic reader.
    }
  })();
  return {
    events,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-turn-activity-'));
  roots.push(root);
  const workspace = await realpath(
    await mkdir(path.join(root, 'workspace'), { recursive: true }).then(() =>
      path.join(root, 'workspace')
    )
  );
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const marker = `TURN_ACTIVITY_DONE_${Date.now()}`;
  const secret = `turn-activity-secret-${Date.now()}`;
  const provider = await startProvider(marker);
  await Promise.all([
    mkdir(storageRoot, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
  ]);
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: 'activity-fixture',
        models: [
          {
            id: 'activity-fixture',
            displayName: 'Activity fixture',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            overrides: { baseUrl: provider.baseUrl, maxRetries: 0, timeout: 30_000 },
          },
        ],
        permissionMode: 'yolo',
        maxTurns: 4,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return { root, workspace, storageRoot, home, marker, secret, provider };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')(
  'turn activity production surfaces',
  () => {
    it('renders the activity lifecycle in the production raw TUI', async () => {
      const test = await fixture();
      try {
        const encoded = Buffer.from(
          JSON.stringify({
            cliEntry,
            workspace: test.workspace,
            home: test.home,
            storageRoot: test.storageRoot,
            sessionId: `activity-tui-${Date.now()}`,
            prompt: 'Use Bash exactly once and then answer with the requested marker.',
            marker: test.marker,
            secret: test.secret,
          })
        ).toString('base64');
        const result = await execFileAsync('bun', [ptyRunner], {
          cwd: path.resolve(import.meta.dirname, '../..'),
          env: { ...process.env, BLADE_TURN_ACTIVITY_PTY_INPUT: encoded },
          timeout: 90_000,
          maxBuffer: 256 * 1024,
          killSignal: 'SIGKILL',
        });
        const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(evidence).toMatchObject({
          success: true,
          sawThinking: true,
          sawTool: true,
          finalMarkerSeen: true,
          cleanupComplete: true,
          leakedSecrets: [],
        });
        expect(test.provider.requestCount()).toBe(2);
        expect(JSON.stringify(evidence)).not.toContain(test.secret);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('rehydrates activity in the production Web UI while a tool is running', async () => {
      const test = await fixture();
      const port = await reservePort();
      const server = spawn(
        process.execPath,
        [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
        {
          cwd: test.workspace,
          env: {
            ...process.env,
            HOME: test.home,
            BLADE_STORAGE_ROOT: test.storageRoot,
            BLADE_AUTO_MEMORY: '0',
            BLADE_TELEMETRY_DISABLED: '1',
            BLADE_API_KEY: test.secret,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let probe: Awaited<ReturnType<typeof openEventProbe>> | undefined;
      let output = '';
      server.stdout?.on('data', (chunk) => {
        output += chunk.toString();
      });
      server.stderr?.on('data', (chunk) => {
        output += chunk.toString();
      });
      try {
        const origin = `http://127.0.0.1:${port}`;
        await waitForHttp(origin);
        const createdResponse = await fetch(`${origin}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath: test.workspace, title: 'Turn activity' }),
        });
        const created = SessionSchema.parse(await createdResponse.json());
        probe = await openEventProbe(origin, created.sessionId, test.workspace);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const faults: string[] = [];
        page.on('pageerror', (error) => faults.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') faults.push(message.text());
        });
        const url = new URL(origin);
        url.searchParams.set('session', created.sessionId);
        url.searchParams.set('project', test.workspace);
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        const composer = page.locator('textarea[data-blade-composer]');
        await composer.waitFor({ state: 'visible' });
        const mode = page.locator('[data-blade-permission-mode]');
        if ((await mode.getAttribute('data-blade-permission-mode')) !== 'yolo') {
          await mode.click();
          await page.locator('[data-blade-permission-option="yolo"]').click();
          await page.locator('[data-blade-yolo-confirm]').click();
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-blade-permission-mode]')
                ?.getAttribute('data-blade-permission-mode') === 'yolo'
          );
        }
        await composer.fill('Use Bash exactly once and then answer with the marker.');
        await page.locator('[data-blade-submit]').click();
        const activeToolObserved = () =>
          probe.events.some((event) => {
            if (event.type !== 'turn.activity') return false;
            const activity = event.properties.activity;
            return (
              activity !== null &&
              typeof activity === 'object' &&
              !Array.isArray(activity) &&
              JSON.stringify(activity).includes('executing_tools') &&
              JSON.stringify(activity).includes('Bash')
            );
          });
        const deadline = Date.now() + 20_000;
        while (!activeToolObserved() && Date.now() < deadline) {
          await page.waitForTimeout(50);
        }
        expect(activeToolObserved()).toBe(true);
        await page.waitForFunction(
          () => {
            const strip = document.querySelector('[data-turn-activity-strip]');
            return (
              strip?.textContent?.includes('Running 1 tools') === true &&
              strip.textContent.includes('Bash')
            );
          },
          undefined,
          { timeout: 20_000 }
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page
          .locator('[data-turn-activity-strip]')
          .waitFor({ state: 'visible', timeout: 10_000 });
        expect(
          await page.locator('[data-turn-activity-strip]').textContent()
        ).toContain('Bash');
        await page
          .getByText(test.marker, { exact: true })
          .waitFor({ state: 'visible', timeout: 60_000 });
        await page
          .locator('[data-turn-activity-strip]')
          .waitFor({ state: 'detached', timeout: 10_000 });
        expect(faults).toEqual([]);
        expect(test.provider.requestCount()).toBe(2);
        expect(`${await page.content()}\n${output}`).not.toContain(test.secret);
      } finally {
        await probe?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
        server.kill('SIGTERM');
        await test.provider.close();
      }
    }, 120_000);
  }
);
