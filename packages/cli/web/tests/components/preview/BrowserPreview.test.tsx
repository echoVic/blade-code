// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPanel } from '../../../src/components/preview/BrowserPanel';
import {
  appendPreviewBrowserHistory,
  DEFAULT_PREVIEW_BROWSER_URL,
  MAX_PREVIEW_BROWSER_HISTORY,
  normalizePreviewBrowserUrl,
} from '../../../src/components/preview/browserPanelModel';
import { setLocale } from '../../../src/i18n';
import { useBrowserActivityStore } from '../../../src/store/BrowserActivityStore';

const browserService = vi.hoisted(() => ({
  navigate: vi.fn(),
  snapshot: vi.fn(),
  interact: vi.fn(),
  inspect: vi.fn(),
  screenshot: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@/services/webBrowserService', () => ({
  webBrowserService: browserService,
}));

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('preview browser URL boundary', () => {
  it.each([
    ['localhost:5173/app', 'http://localhost:5173/app'],
    ['127.0.0.1:4173', 'http://127.0.0.1:4173/'],
    ['192.168.1.20:8080', 'http://192.168.1.20:8080/'],
    ['app.local:3000/status', 'http://app.local:3000/status'],
    ['example.com/docs', 'https://example.com/docs'],
    ['//example.com/path', 'https://example.com/path'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizePreviewBrowserUrl(input, 'http://localhost:4097')).toEqual({
      ok: true,
      url: expected,
    });
  });

  it.each([
    ['', 'empty'],
    ['not a host', 'invalid'],
    ['javascript:alert(1)', 'protocol'],
    ['file:///tmp/demo.html', 'protocol'],
    ['https://user:secret@example.com', 'credentials'],
    ['http://localhost:4097/tasks', 'same_origin'],
  ] as const)('rejects %s as %s', (input, reason) => {
    expect(normalizePreviewBrowserUrl(input, 'http://localhost:4097')).toEqual({
      ok: false,
      reason,
    });
  });

  it('bounds history and replaces the forward branch after back navigation', () => {
    let state = { entries: [] as string[], index: -1 };
    for (let index = 0; index < MAX_PREVIEW_BROWSER_HISTORY + 4; index += 1) {
      state = appendPreviewBrowserHistory(state, `https://example.com/${index}`);
    }
    expect(state.entries).toHaveLength(MAX_PREVIEW_BROWSER_HISTORY);
    expect(state.entries[0]).toBe('https://example.com/4');

    state = appendPreviewBrowserHistory(
      { entries: state.entries, index: 20 },
      'https://example.com/replaced'
    );
    expect(state.index).toBe(21);
    expect(state.entries.at(-1)).toBe('https://example.com/replaced');
    expect(state.entries).not.toContain('https://example.com/53');
  });
});

describe('BrowserPanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    vi.clearAllMocks();
    useBrowserActivityStore.getState().clearAgentActivity();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:browser-frame'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    useBrowserActivityStore.getState().clearAgentActivity();
    container.remove();
    vi.restoreAllMocks();
  });

  it('navigates, reports load state, and preserves bounded history controls', async () => {
    await act(async () => {
      root.render(<BrowserPanel />);
    });

    const address = container.querySelector<HTMLInputElement>(
      '[data-preview-browser-address]'
    );
    const form = address?.closest('form');
    expect(address?.value).toBe(DEFAULT_PREVIEW_BROWSER_URL);
    expect(container.querySelector('[data-preview-browser-frame]')).toBeNull();
    expect(
      container.querySelector('[data-preview-browser-status]')?.textContent
    ).toContain('Idle');

    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'localhost:4173/one');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    let frame = container.querySelector<HTMLIFrameElement>(
      '[data-preview-browser-frame]'
    );
    expect(frame?.getAttribute('src')).toBe('http://localhost:4173/one');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(
      container.querySelector('[data-preview-browser-status]')?.textContent
    ).toContain('Loading');

    await act(async () => {
      frame?.dispatchEvent(new Event('load'));
    });
    expect(
      container.querySelector('[data-preview-browser-status]')?.textContent
    ).toContain('Ready');

    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'https://example.com/two');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(
      container
        .querySelector<HTMLIFrameElement>('[data-preview-browser-frame]')
        ?.getAttribute('src')
    ).toBe('https://example.com/two');
    expect(
      container
        .querySelector('[data-browser-panel]')
        ?.getAttribute('data-browser-history-count')
    ).toBe('2');
    expect(
      container
        .querySelector('[data-browser-panel]')
        ?.getAttribute('data-browser-history-index')
    ).toBe('1');

    const back = container.querySelector<HTMLButtonElement>('[aria-label="Go back"]');
    const forward = container.querySelector<HTMLButtonElement>(
      '[aria-label="Go forward"]'
    );
    expect(back?.disabled).toBe(false);
    await act(async () => back?.click());
    expect(address?.value).toBe('http://localhost:4173/one');
    expect(back?.disabled).toBe(true);
    expect(forward?.disabled).toBe(false);

    await act(async () => forward?.click());
    expect(address?.value).toBe('https://example.com/two');

    frame = container.querySelector<HTMLIFrameElement>('[data-preview-browser-frame]');
    const previousFrame = frame;
    const reload = container.querySelector<HTMLButtonElement>(
      '[aria-label="Reload page"]'
    );
    await act(async () => reload?.click());
    frame = container.querySelector<HTMLIFrameElement>('[data-preview-browser-frame]');
    expect(frame).not.toBe(previousFrame);
  });

  it('keeps the current page when a rejected URL is submitted', async () => {
    await act(async () => {
      root.render(<BrowserPanel />);
    });
    const address = container.querySelector<HTMLInputElement>(
      '[data-preview-browser-address]'
    );
    const form = address?.closest('form');

    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'https://example.com/valid');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'javascript:alert(1)');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Only HTTP and HTTPS URLs are supported.'
    );
    expect(
      container
        .querySelector<HTMLIFrameElement>('[data-preview-browser-frame]')
        ?.getAttribute('src')
    ).toBe('https://example.com/valid');
  });

  it('opens only the validated current URL from an explicit user gesture', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await act(async () => {
      root.render(<BrowserPanel />);
    });
    const external = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open in system browser"]'
    );
    expect(external?.disabled).toBe(true);
    expect(open).not.toHaveBeenCalled();

    const address = container.querySelector<HTMLInputElement>(
      '[data-preview-browser-address]'
    );
    const form = address?.closest('form');
    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'example.com');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => external?.click());

    expect(open).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('drives an isolated Test browser from DOM refs and diagnostics', async () => {
    const observation = {
      pageId: 'browser_page_1',
      snapshotId: 'browser_snapshot_1',
      url: 'https://example.com/form',
      origin: 'https://example.com:443',
      title: 'Example form',
      tabs: [],
      snapshot: '- textbox "Name" [ref=e1]\n- button "Save" [ref=e2]',
      truncated: false,
    };
    browserService.navigate.mockResolvedValue(observation);
    browserService.screenshot.mockResolvedValue(
      new Blob(['png'], { type: 'image/png' })
    );
    browserService.interact.mockResolvedValue({
      outcome: 'applied',
      pageId: observation.pageId,
      actionApplied: true,
      sideEffectsUncertain: false,
      observation: {
        ...observation,
        snapshotId: 'browser_snapshot_2',
      },
    });
    browserService.inspect.mockResolvedValue({
      pageId: observation.pageId,
      target: 'console',
      entries: [
        {
          sequence: 1,
          pageId: observation.pageId,
          kind: 'console',
          level: 'info',
          text: 'ready',
        },
      ],
      truncated: false,
    });
    browserService.reset.mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <BrowserPanel
          sessionRef={{ sessionId: 'session-1', projectPath: '/project' }}
        />
      );
    });
    const testTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((button) => button.textContent?.includes('Test'));
    await act(async () => testTab?.click());

    const address = container.querySelector<HTMLInputElement>(
      '[data-browser-panel-address]'
    );
    const form = address?.closest('form');
    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'example.com/form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => {
      expect(browserService.navigate).toHaveBeenCalledWith(
        { sessionId: 'session-1', projectPath: '/project' },
        { action: 'goto', url: 'https://example.com/form' }
      );
      expect(container.querySelector('[data-browser-test-screenshot]')).not.toBeNull();
    });

    const ref = container.querySelector<HTMLButtonElement>('[data-browser-ref="e2"]');
    await act(async () => ref?.click());
    const click = container.querySelector<HTMLButtonElement>(
      '[aria-label="Click selected element"]'
    );
    await act(async () => click?.click());
    await vi.waitFor(() =>
      expect(browserService.interact).toHaveBeenCalledWith(
        { sessionId: 'session-1', projectPath: '/project' },
        expect.objectContaining({
          pageId: 'browser_page_1',
          snapshotId: 'browser_snapshot_1',
          ref: 'e2',
          action: { kind: 'click' },
        })
      )
    );

    const consoleTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((button) => button.textContent?.includes('Console'));
    await act(async () => consoleTab?.click());
    await vi.waitFor(() => expect(browserService.inspect).toHaveBeenCalled());
    expect(container.textContent).toContain('ready');

    const reset = container.querySelector<HTMLButtonElement>(
      '[aria-label="Reset Test browser"]'
    );
    await act(async () => reset?.click());
    await vi.waitFor(() => expect(browserService.reset).toHaveBeenCalled());
  });

  it('switches to the read-only Agent browser and renders its pointer activity', async () => {
    browserService.screenshot.mockResolvedValue(
      new Blob(['agent-png'], { type: 'image/png' })
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 500,
      width: 800,
      height: 500,
      toJSON: () => ({}),
    });

    const sessionRef = {
      sessionId: 'session-1',
      projectPath: '/project',
    };
    await act(async () => {
      root.render(<BrowserPanel sessionRef={sessionRef} />);
    });
    await act(async () => {
      useBrowserActivityStore.getState().completeAgentActivity(sessionRef, {
        toolCallId: 'browser-tool-1',
        toolName: 'BrowserInteract',
        success: true,
        metadata: {
          browser: {
            action: 'BrowserInteract',
            status: 'ok',
            pageId: 'browser_page_1',
            origin: 'https://example.com:443',
            url: 'https://example.com/form',
            interaction: {
              action: 'click',
              ref: 'e2',
              viewport: { width: 1440, height: 900 },
              targetBox: { x: 680, y: 430, width: 80, height: 40 },
            },
          },
        },
      });
    });

    await vi.waitFor(() => {
      expect(
        container
          .querySelector('[data-browser-panel]')
          ?.getAttribute('data-browser-mode')
      ).toBe('test');
      expect(
        container
          .querySelector('[data-browser-panel]')
          ?.getAttribute('data-browser-test-source')
      ).toBe('agent');
      expect(browserService.screenshot).toHaveBeenCalledWith(sessionRef, {
        source: 'agent',
        pageId: 'browser_page_1',
        expectedOrigin: 'https://example.com:443',
      });
      expect(container.querySelector('[data-browser-agent-pointer]')).not.toBeNull();
    });

    const address = container.querySelector<HTMLInputElement>(
      '[data-browser-panel-address]'
    );
    expect(address?.readOnly).toBe(true);
    expect(address?.value).toBe('https://example.com/form');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Click selected element"]'
      )?.disabled
    ).toBe(true);

    await act(async () => {
      useBrowserActivityStore.getState().completeAgentActivity(sessionRef, {
        toolCallId: 'browser-tool-2',
        toolName: 'BrowserPage',
        success: true,
        metadata: {
          browser: {
            action: 'BrowserPage',
            status: 'ok',
            pageId: 'browser_page_2',
            origin: 'null',
            url: 'about:blank',
          },
        },
      });
    });
    expect(browserService.screenshot).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale Test snapshot before the next user action', async () => {
    const first = {
      pageId: 'browser_page_1',
      snapshotId: 'browser_snapshot_1',
      url: 'https://example.com/',
      origin: 'https://example.com:443',
      title: 'Example',
      tabs: [],
      snapshot: '- button "Save" [ref=e1]',
      truncated: false,
    };
    const refreshed = {
      ...first,
      snapshotId: 'browser_snapshot_2',
      snapshot: '- button "Save now" [ref=e2]',
    };
    browserService.navigate.mockResolvedValue(first);
    browserService.screenshot.mockResolvedValue(
      new Blob(['png'], { type: 'image/png' })
    );
    browserService.interact.mockRejectedValue(
      new Error('Browser snapshot is stale; capture a new snapshot before interacting')
    );
    browserService.snapshot.mockResolvedValue(refreshed);

    await act(async () => {
      root.render(
        <BrowserPanel
          sessionRef={{ sessionId: 'session-1', projectPath: '/project' }}
        />
      );
    });
    const testTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((button) => button.textContent?.includes('Test'));
    await act(async () => testTab?.click());
    const address = container.querySelector<HTMLInputElement>(
      '[data-browser-panel-address]'
    );
    const form = address?.closest('form');
    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      setInputValue(address, 'example.com');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-browser-ref="e1"]')).not.toBeNull()
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-browser-ref="e1"]')?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Click selected element"]')
        ?.click();
    });

    await vi.waitFor(() => {
      expect(browserService.snapshot).toHaveBeenCalledWith(
        { sessionId: 'session-1', projectPath: '/project' },
        { pageId: 'browser_page_1' }
      );
      expect(container.textContent).toContain(
        'Snapshot refreshed; select the element again.'
      );
      expect(container.querySelector('[data-browser-ref="e2"]')).not.toBeNull();
    });
  });
});
