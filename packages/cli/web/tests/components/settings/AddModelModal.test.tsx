// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AddModelModal } from '../../../src/components/settings/AddModelModal';

describe('AddModelModal', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const data =
        url === '/providers'
          ? [
              {
                id: 'deepseek',
                name: 'DeepSeek',
                modelCount: 2,
                supportsApiKey: true,
                configured: false,
              },
            ]
          : [
              {
                id: 'deepseek-v4-pro',
                name: 'DeepSeek V4 Pro',
                contextWindow: 128000,
                reasoning: true,
                input: ['text'],
              },
            ];
      return Promise.resolve({ ok: true, json: async () => data } as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('submits a pi provider/model reference with a separate credential', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <AddModelModal
          open
          onOpenChange={onOpenChange}
          onSave={onSave}
          saveError={null}
        />
      );
      await Promise.resolve();
    });

    await selectOption('Provider', 'deepseek');
    await act(async () => await Promise.resolve());
    await selectOption('Model', 'deepseek-v4-pro');

    const saveButton = [...document.querySelectorAll('button')].find((entry) =>
      entry.textContent?.includes('Save Model')
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const apiKey = document.querySelector(
      'input[placeholder="Stored separately in auth.json"]'
    ) as HTMLInputElement;
    await setInput(apiKey, 'test-key');
    expect(saveButton.disabled).toBe(false);
    await click('Save Model');

    expect(onSave).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      apiKey: 'test-key',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('resets stale provider state when reopened', async () => {
    const props = {
      onOpenChange: vi.fn(),
      onSave: vi.fn().mockResolvedValue(true),
      saveError: null,
    };
    await act(async () => {
      root.render(<AddModelModal open {...props} />);
      await Promise.resolve();
    });
    await selectOption('Provider', 'deepseek');
    expect(
      document.querySelector('input[placeholder="Stored separately in auth.json"]')
    ).not.toBeNull();

    await act(async () => {
      root.render(<AddModelModal open={false} {...props} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<AddModelModal open {...props} />);
      await Promise.resolve();
    });

    expect(
      (document.querySelector('[aria-label="Provider"]') as HTMLSelectElement).value
    ).toBe('');
    expect(
      document.querySelector('input[placeholder="Stored separately in auth.json"]')
    ).toBeNull();
  });

  async function click(text: string) {
    const button = [...document.querySelectorAll('button')].find((entry) =>
      entry.textContent?.includes(text)
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function setInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value'
    )?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function selectOption(label: string, value: string) {
    const select = document.querySelector(
      `[aria-label="${label}"]`
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setter?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
  }
});
