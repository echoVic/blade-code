import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type Browser, chromium, type LaunchOptions } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserProcessPool } from '../../src/browser/BrowserProcessPool.js';
import { MAX_BROWSER_FINGERPRINT_BYTES } from '../../src/browser/constants.js';
import { SessionBrowserRuntime } from '../../src/browser/SessionBrowserRuntime.js';
import type { BrowserObservation } from '../../src/browser/types.js';

vi.unmock('http');
vi.unmock('node:http');

function refFor(observation: BrowserObservation, text: string): string {
  const line = observation.snapshot
    .split('\n')
    .find((candidate) => candidate.includes(`"${text}"`));
  const ref = line?.match(/\[ref=([a-z][a-z0-9]*)\]/)?.[1];
  if (!ref) {
    throw new Error(
      `Missing ref for ${text}\n${observation.url}\n${observation.snapshot}`
    );
  }
  return ref;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server has no TCP address');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

describe('SessionBrowserRuntime with real Chromium', () => {
  const servers: Server[] = [];
  const pools: BrowserProcessPool[] = [];
  const runtimes: SessionBrowserRuntime[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
    await Promise.allSettled(pools.splice(0).map((pool) => pool.dispose()));
    await Promise.allSettled(servers.splice(0).map(closeServer));
    await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('navigates, snapshots, interacts, inspects, manages pages, and blocks origins', async () => {
    let crossOriginRequests = 0;
    const oversizedAccessibleName = 'x'.repeat(MAX_BROWSER_FINGERPRINT_BYTES + 1);
    const other = createServer((request, response) => {
      if (request.url === '/blocked') crossOriginRequests++;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        request.url === '/frame'
          ? '<button>Cross frame</button>'
          : '<h1>Cross origin loaded</h1>'
      );
    });
    servers.push(other);
    const otherPort = await listen(other);

    const fixture = createServer((request, response) => {
      if (request.url === '/same') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<h1>Same origin page</h1>');
        return;
      }
      if (request.url === '/download') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="blocked.txt"',
        });
        response.end('blocked download');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <body>
            <label>Name <input aria-label="Name"></label>
            <label>Password <input type="password" aria-label="Password"></label>
            <span id="oversized-label">${oversizedAccessibleName}</span>
            <input aria-labelledby="oversized-label">
            <select aria-label="Mode">
              <option value="fast">Fast</option>
              <option value="safe">Safe</option>
            </select>
            <label>Enabled <input type="checkbox" aria-label="Enabled"></label>
            <button onclick="
              document.querySelector('#status').textContent =
                'Saved ' + document.querySelector('[aria-label=Name]').value;
              console.log('saved-marker');
            ">Submit</button>
            <button onclick="
              if (confirm('Proceed?')) {
                document.querySelector('#status').textContent = 'Confirmed';
              }
            ">Confirm</button>
            <button onclick="
              if (confirm('First?') && confirm('Second?')) {
                document.querySelector('#status').textContent = 'Both accepted';
              } else {
                document.querySelector('#status').textContent = 'Second dismissed';
              }
            ">Two dialogs</button>
            <a href="/same">Same origin</a>
            <a href="http://127.0.0.1:${otherPort}/blocked">Cross origin</a>
            <a href="/download" download>Download file</a>
            <button onclick="window.open('/same', '_blank')">Same origin popup</button>
            <button onclick="window.open(
              'http://127.0.0.1:${otherPort}/blocked',
              '_blank'
            )">Cross origin popup</button>
            <button onclick="setTimeout(
              () => location.href = 'http://127.0.0.1:${otherPort}/blocked',
              750
            )">Background cross origin</button>
            <iframe srcdoc="<button aria-label='Inherited frame'>Inherited frame</button>"></iframe>
            <iframe sandbox srcdoc="<button aria-label='Opaque frame'>Opaque frame</button>"></iframe>
            <iframe src="http://127.0.0.1:${otherPort}/frame"></iframe>
            <div id="status">Idle</div>
            <script>console.log('fixture-ready')</script>
          </body>
        </html>`);
    });
    servers.push(fixture);
    const fixturePort = await listen(fixture);
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-browser-runtime-'));
    roots.push(root);
    let launchedBrowser: Browser | undefined;
    const runtimeLaunchOptions: LaunchOptions[] = [];
    const pool = new BrowserProcessPool({
      adapter: {
        launch: async (options) => {
          runtimeLaunchOptions.push(options);
          launchedBrowser = await chromium.launch({
            ...options,
            args: ['--enable-automation'],
          });
          return launchedBrowser;
        },
      },
    });
    pools.push(pool);
    const runtime = new SessionBrowserRuntime('integration', 'browser', {
      pool,
      storageRoot: root,
    });
    runtimes.push(runtime);
    const origin = `http://127.0.0.1:${fixturePort}`;

    const first = await runtime.navigate({ url: `${origin}/` });
    expect(first.origin).toBe(origin);
    expect(first.snapshot).toContain('textbox "Name"');
    expect(pool.stats().contexts).toBe(1);
    expect(runtimeLaunchOptions).toEqual([
      expect.objectContaining({ chromiumSandbox: true }),
    ]);
    const browserSession = await launchedBrowser!.newBrowserCDPSession();
    const commandLine = await browserSession.send('Browser.getBrowserCommandLine');
    expect(commandLine.arguments).not.toContain('--no-sandbox');
    await browserSession.detach();
    await expect(
      runtime.navigate({
        action: 'back',
        pageId: first.pageId,
      })
    ).rejects.toMatchObject({ code: 'browser_origin_mismatch' });
    await expect(
      runtime.interact({
        pageId: first.pageId,
        snapshotId: first.snapshotId,
        ref: refFor(first, 'Cross frame'),
        expectedOrigin: origin,
        action: { kind: 'click' },
      })
    ).rejects.toMatchObject({ code: 'browser_cross_origin_frame' });
    await expect(
      runtime.interact({
        pageId: first.pageId,
        snapshotId: first.snapshotId,
        ref: refFor(first, 'Inherited frame'),
        expectedOrigin: origin,
        action: { kind: 'click' },
      })
    ).resolves.toMatchObject({ outcome: 'applied' });
    const afterInheritedFrame = await runtime.snapshot({ pageId: first.pageId });
    await expect(
      runtime.interact({
        pageId: first.pageId,
        snapshotId: afterInheritedFrame.snapshotId,
        ref: refFor(afterInheritedFrame, 'Opaque frame'),
        expectedOrigin: origin,
        action: { kind: 'click' },
      })
    ).rejects.toMatchObject({ code: 'browser_cross_origin_frame' });

    const filled = await runtime.interact({
      pageId: first.pageId,
      snapshotId: afterInheritedFrame.snapshotId,
      ref: refFor(afterInheritedFrame, 'Name'),
      expectedOrigin: origin.toUpperCase(),
      action: { kind: 'fill', value: 'Blade' },
    });
    expect(filled.outcome).toBe('applied');
    if (filled.outcome !== 'applied') throw new Error('Fill did not apply');

    const selectedMode = await runtime.interact({
      pageId: filled.pageId,
      snapshotId: filled.observation.snapshotId,
      ref: refFor(filled.observation, 'Mode'),
      expectedOrigin: origin,
      action: { kind: 'select', values: ['safe'] },
    });
    expect(selectedMode.outcome).toBe('applied');
    if (selectedMode.outcome !== 'applied') {
      throw new Error('Select did not apply');
    }
    const labelSelection = await runtime.interact({
      pageId: selectedMode.pageId,
      snapshotId: selectedMode.observation.snapshotId,
      ref: refFor(selectedMode.observation, 'Mode'),
      expectedOrigin: origin,
      action: { kind: 'select', values: ['Safe'] },
      timeoutMs: 100,
    });
    expect(labelSelection).toMatchObject({
      outcome: 'uncertain',
      errorCode: 'browser_timeout',
    });
    const afterLabelSelection = await runtime.snapshot({ pageId: first.pageId });

    const checked = await runtime.interact({
      pageId: afterLabelSelection.pageId,
      snapshotId: afterLabelSelection.snapshotId,
      ref: refFor(afterLabelSelection, 'Enabled'),
      expectedOrigin: origin,
      action: { kind: 'check' },
    });
    expect(checked.outcome).toBe('applied');
    if (checked.outcome !== 'applied') throw new Error('Check did not apply');

    const submitted = await runtime.interact({
      pageId: checked.pageId,
      snapshotId: checked.observation.snapshotId,
      ref: refFor(checked.observation, 'Submit'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(submitted.outcome).toBe('applied');
    const waited = await runtime.wait({
      pageId: first.pageId,
      expectedOrigin: origin,
      condition: { kind: 'text', text: 'Saved Blade' },
    });
    expect(waited.snapshot).toContain('Saved Blade');
    await expect(
      runtime.wait({
        pageId: waited.pageId,
        expectedOrigin: origin,
        condition: {
          kind: 'ref',
          snapshotId: waited.snapshotId,
          ref: refFor(waited, 'Submit'),
          state: 'visible',
        },
      })
    ).resolves.toMatchObject({ pageId: waited.pageId });

    const found = await runtime.inspect({
      pageId: first.pageId,
      expectedOrigin: origin,
      target: { kind: 'find', text: 'Saved Blade', limit: 5 },
    });
    expect(found.matches).toEqual([expect.stringContaining('Saved Blade')]);
    expect(found.snapshotId).toMatch(/^browser_snapshot_/);

    const beforeDialog = await runtime.snapshot({ pageId: first.pageId });
    const confirmed = await runtime.interact({
      pageId: beforeDialog.pageId,
      snapshotId: beforeDialog.snapshotId,
      ref: refFor(beforeDialog, 'Confirm'),
      expectedOrigin: origin,
      action: { kind: 'click', dialog: { action: 'accept' } },
    });
    expect(confirmed.outcome).toBe('applied');
    if (confirmed.outcome !== 'applied') throw new Error('Dialog was not accepted');
    expect(confirmed.observation.snapshot).toContain('Confirmed');

    const beforeTwoDialogs = await runtime.snapshot({ pageId: first.pageId });
    const twoDialogs = await runtime.interact({
      pageId: beforeTwoDialogs.pageId,
      snapshotId: beforeTwoDialogs.snapshotId,
      ref: refFor(beforeTwoDialogs, 'Two dialogs'),
      expectedOrigin: origin,
      action: { kind: 'click', dialog: { action: 'accept' } },
    });
    expect(twoDialogs.outcome).toBe('applied');
    if (twoDialogs.outcome !== 'applied') {
      throw new Error('Multiple-dialog control did not finish');
    }
    expect(twoDialogs.observation.snapshot).toContain('Second dismissed');

    const scrolled = await runtime.interact({
      pageId: twoDialogs.pageId,
      snapshotId: twoDialogs.observation.snapshotId,
      expectedOrigin: origin,
      action: { kind: 'scroll', direction: 'down', amount: 100 },
    });
    expect(scrolled.outcome).toBe('applied');

    await expect(
      runtime.interact({
        pageId: first.pageId,
        snapshotId: first.snapshotId,
        ref: refFor(first, 'Name'),
        expectedOrigin: origin,
        action: { kind: 'fill', value: 'stale' },
      })
    ).rejects.toMatchObject({ code: 'browser_snapshot_stale' });

    const credentialSnapshot = await runtime.snapshot({ pageId: first.pageId });
    await expect(
      runtime.interact({
        pageId: first.pageId,
        snapshotId: credentialSnapshot.snapshotId,
        ref: refFor(credentialSnapshot, 'Password'),
        expectedOrigin: origin,
        action: { kind: 'fill', value: 'must-not-be-written' },
      })
    ).rejects.toMatchObject({ code: 'browser_unsupported' });
    const oversizedRef = credentialSnapshot.snapshot.match(
      /^\s*- textbox \[ref=([a-z][a-z0-9]*)\]$/m
    )?.[1];
    expect(oversizedRef).toBeDefined();
    await expect(
      runtime.interact({
        pageId: credentialSnapshot.pageId,
        snapshotId: credentialSnapshot.snapshotId,
        ref: oversizedRef!,
        expectedOrigin: origin,
        action: { kind: 'fill', value: 'must-not-be-written' },
      })
    ).rejects.toMatchObject({ code: 'browser_unsupported' });

    const diagnostics = await runtime.inspect({
      pageId: first.pageId,
      expectedOrigin: origin,
      target: { kind: 'console' },
    });
    expect(diagnostics.entries?.some((entry) => entry.text === 'saved-marker')).toBe(
      true
    );
    const network = await runtime.inspect({
      pageId: first.pageId,
      target: { kind: 'network' },
    });
    expect(network.entries?.some((entry) => entry.url?.startsWith(origin))).toBe(true);

    const screenshot = await runtime.inspect({
      pageId: first.pageId,
      target: { kind: 'screenshot' },
    });
    expect(screenshot.artifact?.path).toBeDefined();
    expect((await readFile(screenshot.artifact!.path!)).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

    const beforeDownload = await runtime.snapshot({ pageId: first.pageId });
    await expect(
      runtime.interact({
        pageId: beforeDownload.pageId,
        snapshotId: beforeDownload.snapshotId,
        ref: refFor(beforeDownload, 'Download file'),
        expectedOrigin: origin,
        action: { kind: 'click' },
      })
    ).rejects.toMatchObject({ code: 'browser_download_blocked' });

    const beforeSameOrigin = await runtime.snapshot({ pageId: first.pageId });
    const sameOrigin = await runtime.interact({
      pageId: beforeSameOrigin.pageId,
      snapshotId: beforeSameOrigin.snapshotId,
      ref: refFor(beforeSameOrigin, 'Same origin'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(sameOrigin).toMatchObject({ outcome: 'applied' });
    const back = await runtime.navigate({
      action: 'back',
      pageId: first.pageId,
      expectedOrigin: origin,
    });
    expect(back.snapshot).toContain('textbox "Name"');
    const forward = await runtime.navigate({
      action: 'forward',
      pageId: first.pageId,
      expectedOrigin: origin,
    });
    expect(forward.snapshot).toContain('Same origin page');
    const returned = await runtime.navigate({
      action: 'back',
      pageId: first.pageId,
      expectedOrigin: origin,
    });
    const reloaded = await runtime.navigate({
      action: 'reload',
      pageId: first.pageId,
      expectedOrigin: origin,
    });
    expect(returned.origin).toBe(origin);
    expect(reloaded.origin).toBe(origin);

    const opened = await runtime.page({ action: { kind: 'open' } });
    expect(opened.tabs).toHaveLength(2);
    expect(opened.observation?.origin).toBe('null');
    const secondPageId = opened.selectedPageId!;
    const closed = await runtime.page({
      action: { kind: 'close', pageId: secondPageId },
    });
    expect(closed.tabs).toHaveLength(1);
    expect(closed.selectedPageId).toBe(first.pageId);

    const beforeSamePopup = await runtime.snapshot({ pageId: first.pageId });
    const samePopup = await runtime.interact({
      pageId: beforeSamePopup.pageId,
      snapshotId: beforeSamePopup.snapshotId,
      ref: refFor(beforeSamePopup, 'Same origin popup'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(samePopup).toMatchObject({ outcome: 'applied' });
    if (samePopup.outcome !== 'applied') {
      throw new Error('Same-origin popup was not applied');
    }
    expect(samePopup.observation.tabs).toHaveLength(2);
    const samePopupPage = samePopup.observation.tabs.find(
      (tab) => tab.pageId !== first.pageId
    );
    expect(samePopupPage?.origin).toBe(origin);
    await runtime.page({
      action: { kind: 'close', pageId: samePopupPage!.pageId },
    });

    for (let index = 1; index < 8; index++) {
      await runtime.page({ action: { kind: 'open' } });
    }
    const rootAtCapacity = await runtime.snapshot({ pageId: first.pageId });
    const capacityPopup = await runtime.interact({
      pageId: first.pageId,
      snapshotId: rootAtCapacity.snapshotId,
      ref: refFor(rootAtCapacity, 'Same origin popup'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(capacityPopup).toMatchObject({ outcome: 'applied' });
    const popupDiagnostics = await runtime.inspect({
      pageId: first.pageId,
      target: { kind: 'page-errors' },
    });
    expect(
      popupDiagnostics.entries?.some((entry) => entry.kind === 'popup-capacity')
    ).toBe(true);
    const fullPageList = await runtime.page({ action: { kind: 'list' } });
    for (const tab of fullPageList.tabs.filter((tab) => tab.pageId !== first.pageId)) {
      await runtime.page({ action: { kind: 'close', pageId: tab.pageId } });
    }

    const beforePopup = await runtime.snapshot({ pageId: first.pageId });
    const blockedPopup = await runtime.interact({
      pageId: beforePopup.pageId,
      snapshotId: beforePopup.snapshotId,
      ref: refFor(beforePopup, 'Cross origin popup'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(blockedPopup).toMatchObject({
      outcome: 'uncertain',
      errorCode: 'browser_cross_origin_navigation',
      candidateOrigin: `http://127.0.0.1:${otherPort}`,
    });
    await expect(runtime.page({ action: { kind: 'list' } })).resolves.toMatchObject({
      tabs: [{ pageId: first.pageId }],
    });

    const beforeCross = await runtime.navigate({
      url: `${origin}/`,
      pageId: first.pageId,
    });
    const blocked = await runtime.interact({
      pageId: beforeCross.pageId,
      snapshotId: beforeCross.snapshotId,
      ref: refFor(beforeCross, 'Cross origin'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(blocked).toMatchObject({
      outcome: 'uncertain',
      errorCode: 'browser_cross_origin_navigation',
      candidateOrigin: `http://127.0.0.1:${otherPort}`,
    });
    expect(crossOriginRequests).toBe(0);

    const beforeBackground = await runtime.navigate({
      url: `${origin}/`,
      pageId: first.pageId,
    });
    const scheduledBackground = await runtime.interact({
      pageId: beforeBackground.pageId,
      snapshotId: beforeBackground.snapshotId,
      ref: refFor(beforeBackground, 'Background cross origin'),
      expectedOrigin: origin,
      action: { kind: 'click' },
    });
    expect(scheduledBackground).toMatchObject({ outcome: 'applied' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(runtime.snapshot({ pageId: first.pageId })).rejects.toMatchObject({
      code: 'browser_cross_origin_navigation',
      details: { candidateOrigin: `http://127.0.0.1:${otherPort}` },
    });

    const unavailable = createServer();
    const unavailablePort = await listen(unavailable);
    await closeServer(unavailable);
    await expect(
      runtime.navigate({ url: `http://127.0.0.1:${unavailablePort}/unreachable` })
    ).rejects.toMatchObject({
      code: 'browser_action_uncertain',
      details: { sideEffectsUncertain: true },
    });

    await expect(runtime.page({ action: { kind: 'reset' } })).resolves.toEqual({
      tabs: [],
    });
    expect(pool.stats()).toMatchObject({
      contexts: 0,
      running: false,
    });
    await expect(
      runtime.wait({ condition: { kind: 'time', milliseconds: 0 } })
    ).rejects.toMatchObject({ code: 'browser_page_not_found' });
    await expect(
      runtime.inspect({ target: { kind: 'console' } })
    ).rejects.toMatchObject({ code: 'browser_page_not_found' });
    expect(pool.stats()).toMatchObject({
      contexts: 0,
      running: false,
    });
  });

  it('isolates cookies between Session BrowserContexts', async () => {
    const fixture = createServer((request, response) => {
      if (request.url === '/set') {
        response.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'browser_session=first; Path=/; SameSite=Lax',
        });
        response.end('<h1>Cookie set</h1>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<h1>Cookie ${request.headers.cookie ?? 'none'}</h1>`);
    });
    servers.push(fixture);
    const port = await listen(fixture);
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-browser-isolation-'));
    roots.push(root);
    const pool = new BrowserProcessPool();
    pools.push(pool);
    const first = new SessionBrowserRuntime('project', 'first', {
      pool,
      storageRoot: root,
    });
    const second = new SessionBrowserRuntime('project', 'second', {
      pool,
      storageRoot: root,
    });
    runtimes.push(first, second);
    const origin = `http://127.0.0.1:${port}`;

    await first.navigate({ url: `${origin}/set` });
    const firstEcho = await first.navigate({ url: `${origin}/echo` });
    const secondEcho = await second.navigate({ url: `${origin}/echo` });

    expect(firstEcho.snapshot).toContain('browser_session=first');
    expect(secondEcho.snapshot).toContain('Cookie none');
    expect(pool.stats()).toMatchObject({
      contexts: 2,
      running: true,
    });
  });
});
