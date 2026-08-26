import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserObservation } from '../../src/api/browserSchemas.js';
import { BrowserProcessPool } from '../../src/browser/BrowserProcessPool.js';
import { SessionBrowserRuntime } from '../../src/browser/SessionBrowserRuntime.js';
import { BrowserRoutes } from '../../src/server/routes/browser.js';
import { WebBrowserSessionRegistry } from '../../src/server/WebBrowserSessionRegistry.js';

vi.unmock('http');
vi.unmock('node:http');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Browser API fixture has no TCP address');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function refFor(observation: BrowserObservation, text: string): string {
  const line = observation.snapshot
    .split('\n')
    .find((candidate) => candidate.includes(`"${text}"`));
  const ref = line?.match(/\[ref=([a-z][a-z0-9]*)\]/)?.[1];
  if (!ref) throw new Error(`Missing ref for ${text}\n${observation.snapshot}`);
  return ref;
}

describe('Web Browser Session API with real Chromium', () => {
  const servers: Server[] = [];
  const pools: BrowserProcessPool[] = [];
  const registries: WebBrowserSessionRegistry[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      registries.splice(0).map((registry) => registry.disposeAll())
    );
    await Promise.allSettled(pools.splice(0).map((pool) => pool.dispose()));
    await Promise.allSettled(servers.splice(0).map(closeServer));
    await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('navigates, returns a PNG, interacts through ARIA refs, and resets', async () => {
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <body>
            <label>Name <input aria-label="Name"></label>
            <button onclick="
              document.querySelector('#status').textContent =
                document.querySelector('[aria-label=Name]').value;
              console.log('saved-from-web-browser');
            ">Save</button>
            <div id="status">Idle</div>
          </body>
        </html>`);
    });
    servers.push(fixture);
    const port = await listen(fixture);
    const origin = `http://127.0.0.1:${port}`;
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-web-browser-api-'));
    roots.push(root);
    const pool = new BrowserProcessPool({
      adapter: {
        launch: (options) => chromium.launch(options),
      },
    });
    pools.push(pool);
    const registry = new WebBrowserSessionRegistry({
      createRuntime: (ref) =>
        new SessionBrowserRuntime(ref.projectPath, `web-browser:${ref.sessionId}`, {
          pool,
          storageRoot: root,
          exposeArtifactPaths: false,
        }),
    });
    registries.push(registry);
    const sessionRef = { sessionId: 'session-1', projectPath: '/project' };
    const app = BrowserRoutes({
      withAdmission: (operation) => operation(),
      resolveSessionRef: async () => sessionRef,
      getRuntime: (ref) => registry.get(ref),
      resetRuntime: (ref) => registry.reset(ref),
    });
    const route = (operation: string) =>
      `/session-1/browser/${operation}?projectPath=%2Fproject`;

    const navigate = await app.request(route('navigate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'goto', url: `${origin}/` }),
    });
    expect(navigate.status).toBe(200);
    const first = (await navigate.json()) as BrowserObservation;
    expect(first.snapshot).toContain('textbox "Name"');

    const screenshot = await app.request(
      `${route('inspect')}&target=screenshot&pageId=${first.pageId}&expectedOrigin=${encodeURIComponent(first.origin)}`
    );
    expect(screenshot.status).toBe(200);
    expect(screenshot.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await screenshot.arrayBuffer()).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

    const fill = await app.request(route('interact'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageId: first.pageId,
        snapshotId: first.snapshotId,
        ref: refFor(first, 'Name'),
        expectedOrigin: first.origin,
        action: { kind: 'fill', value: 'Blade' },
      }),
    });
    const filled = (await fill.json()) as {
      outcome: string;
      observation: BrowserObservation;
    };
    expect(filled.outcome).toBe('applied');

    const click = await app.request(route('interact'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageId: filled.observation.pageId,
        snapshotId: filled.observation.snapshotId,
        ref: refFor(filled.observation, 'Save'),
        expectedOrigin: filled.observation.origin,
        action: { kind: 'click' },
      }),
    });
    expect(click.status).toBe(200);

    const inspect = await app.request(
      `${route('inspect')}&target=console&pageId=${first.pageId}&expectedOrigin=${encodeURIComponent(first.origin)}`
    );
    expect(await inspect.json()).toMatchObject({
      target: 'console',
      entries: [expect.objectContaining({ text: 'saved-from-web-browser' })],
    });

    const reset = await app.request(route('reset'), { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(pool.stats().contexts).toBe(0);
  });
});
