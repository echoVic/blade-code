import { describe, expect, it, vi } from 'vitest';
import type { SessionBrowserRuntime } from '../../../src/browser/SessionBrowserRuntime.js';
import { BrowserRuntimeError } from '../../../src/browser/types.js';
import { BrowserRoutes } from '../../../src/server/routes/browser.js';

const ref = { sessionId: 'session-1', projectPath: '/project' };
const observation = {
  pageId: 'browser_page_1',
  snapshotId: 'browser_snapshot_1',
  url: 'https://example.com/',
  origin: 'https://example.com:443',
  title: 'Example',
  tabs: [],
  snapshot: '- button "Save" [ref=e1]',
  truncated: false,
};

function harness(overrides: Partial<SessionBrowserRuntime> = {}) {
  const runtime = {
    navigate: vi.fn().mockResolvedValue(observation),
    snapshot: vi.fn().mockResolvedValue(observation),
    interact: vi.fn().mockResolvedValue({
      outcome: 'applied',
      pageId: observation.pageId,
      actionApplied: true,
      sideEffectsUncertain: false,
      observation,
    }),
    inspect: vi.fn().mockResolvedValue({
      pageId: observation.pageId,
      target: 'console',
      entries: [],
      truncated: false,
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    ...overrides,
  } as unknown as SessionBrowserRuntime;
  const resetRuntime = vi.fn().mockResolvedValue(undefined);
  const resolveSessionRef = vi.fn().mockResolvedValue(ref);
  const app = BrowserRoutes({
    withAdmission: (operation) => operation(),
    resolveSessionRef,
    getRuntime: () => runtime,
    resetRuntime,
  });
  return { app, resetRuntime, resolveSessionRef, runtime };
}

describe('BrowserRoutes', () => {
  it('projects navigation, snapshot, interaction, diagnostics, and reset', async () => {
    const { app, resetRuntime, runtime } = harness();
    const navigation = await app.request(
      '/session-1/browser/navigate?projectPath=%2Fproject',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'goto', url: 'https://example.com/' }),
      }
    );
    expect(navigation.status).toBe(200);
    expect(runtime.navigate).toHaveBeenCalledWith({
      action: 'goto',
      url: 'https://example.com/',
    });

    const snapshot = await app.request(
      '/session-1/browser/snapshot?projectPath=%2Fproject&pageId=browser_page_1&depth=9&includeBoxes=true'
    );
    expect(snapshot.status).toBe(200);
    expect(runtime.snapshot).toHaveBeenCalledWith({
      pageId: 'browser_page_1',
      depth: 9,
      includeBoxes: true,
    });

    const interaction = await app.request(
      '/session-1/browser/interact?projectPath=%2Fproject',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: 'browser_page_1',
          snapshotId: 'browser_snapshot_1',
          ref: 'e1',
          expectedOrigin: 'https://example.com:443',
          action: { kind: 'click' },
        }),
      }
    );
    expect(interaction.status).toBe(200);
    expect(runtime.interact).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'e1', action: { kind: 'click' } })
    );

    const inspect = await app.request(
      '/session-1/browser/inspect?projectPath=%2Fproject&target=network&limit=20'
    );
    expect(inspect.status).toBe(200);
    expect(runtime.inspect).toHaveBeenCalledWith({
      target: { kind: 'network', limit: 20 },
    });

    const reset = await app.request('/session-1/browser/reset?projectPath=%2Fproject', {
      method: 'POST',
    });
    expect(reset.status).toBe(200);
    expect(resetRuntime).toHaveBeenCalledWith(ref);
  });

  it('returns a no-store PNG without exposing artifact paths', async () => {
    const { app, runtime } = harness();
    const response = await app.request(
      '/session-1/browser/inspect?projectPath=%2Fproject&target=screenshot&pageId=browser_page_1&expectedOrigin=https%3A%2F%2Fexample.com%3A443'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('png');
    expect(runtime.screenshot).toHaveBeenCalledWith({
      pageId: 'browser_page_1',
      expectedOrigin: 'https://example.com:443',
    });
  });

  it('rejects malformed input and maps bounded Browser errors', async () => {
    const invalid = harness();
    const invalidResponse = await invalid.app.request(
      '/session-1/browser/navigate?projectPath=%2Fproject',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'goto', url: 'https://example.com/', extra: 1 }),
      }
    );
    expect(invalidResponse.status).toBe(400);

    const unavailable = harness({
      snapshot: vi
        .fn()
        .mockRejectedValue(
          new BrowserRuntimeError(
            'browser_not_installed',
            'Chromium is unavailable or failed to launch.'
          )
        ),
    });
    const unavailableResponse = await unavailable.app.request(
      '/session-1/browser/snapshot?projectPath=%2Fproject'
    );
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toMatchObject({
      error: {
        code: 'BROWSER_NOT_INSTALLED',
        message: 'Chromium is unavailable or failed to launch.',
      },
    });
  });
});
