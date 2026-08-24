// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendPreviewBrowserHistory,
  BrowserPreview,
  DEFAULT_PREVIEW_BROWSER_URL,
  MAX_PREVIEW_BROWSER_HISTORY,
  normalizePreviewBrowserUrl,
} from '../../../src/components/preview/BrowserPreview';
import { setLocale } from '../../../src/i18n';

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

describe('BrowserPreview', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('navigates, reports load state, and preserves bounded history controls', async () => {
    await act(async () => {
      root.render(<BrowserPreview />);
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

    const back = container.querySelector<HTMLButtonElement>('[aria-label="Go back"]');
    const forward = container.querySelector<HTMLButtonElement>(
      '[aria-label="Go forward"]'
    );
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
      root.render(<BrowserPreview />);
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
      root.render(<BrowserPreview />);
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
});
