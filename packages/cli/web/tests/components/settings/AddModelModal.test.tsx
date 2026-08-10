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
                custom: false,
              },
              {
                id: 'openai-compatible',
                name: 'Custom OpenAI Endpoint',
                modelCount: 0,
                supportsApiKey: true,
                configured: false,
                custom: false,
                factoryWireApi: 'openai-completions',
              },
              {
                id: 'anthropic-compatible',
                name: 'Custom Anthropic Endpoint',
                modelCount: 0,
                supportsApiKey: true,
                configured: false,
                custom: false,
                factoryWireApi: 'anthropic-messages',
              },
            ]
          : url.includes('/providers/openai-compatible/')
            ? []
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

  test('creates an isolated OpenAI-compatible provider channel', async () => {
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

    await selectOption('Provider', 'openai-compatible');
    const channelId = document.querySelector(
      '[aria-label="Channel ID"]'
    ) as HTMLInputElement;
    const channelName = document.querySelector(
      '[aria-label="Channel name"]'
    ) as HTMLInputElement;
    const modelId = document.querySelector(
      '[aria-label="Model ID"]'
    ) as HTMLInputElement;
    const baseUrl = document.querySelector(
      '[aria-label="Base URL"]'
    ) as HTMLInputElement;
    const apiKey = document.querySelector(
      'input[placeholder="Stored separately in auth.json"]'
    ) as HTMLInputElement;
    expect(modelId).toBeTruthy();
    expect(baseUrl).toBeTruthy();
    expect(document.querySelector('[aria-label="Model"]')).toBeNull();

    await setInput(channelId, 'Invalid Channel');
    await setInput(channelName, 'Team Gateway');
    await setInput(modelId, 'vendor-model-2026');
    await setInput(baseUrl, 'https://gateway.example.test/v1');
    await setInput(apiKey, 'test-key');
    await click('Save Model');
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Channel ID must start'
    );

    await setInput(channelId, 'team-gateway');
    await setInput(baseUrl, 'not-a-url');
    await click('Save Model');
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'absolute HTTP(S) URL'
    );

    await setInput(baseUrl, 'https://gateway.example.test/v1');
    await click('Save Model');

    expect(onSave).toHaveBeenCalledWith({
      provider: 'team-gateway',
      model: 'vendor-model-2026',
      displayName: 'vendor-model-2026',
      apiKey: 'test-key',
      modelProvider: {
        id: 'team-gateway',
        name: 'Team Gateway',
        baseUrl: 'https://gateway.example.test/v1',
        wireApi: 'openai-completions',
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('creates an Anthropic Messages channel without appending model paths', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <AddModelModal open onOpenChange={vi.fn()} onSave={onSave} saveError={null} />
      );
      await Promise.resolve();
    });

    await selectOption('Provider', 'anthropic-compatible');
    await setInput(
      document.querySelector('[aria-label="Channel ID"]') as HTMLInputElement,
      'claude-gateway'
    );
    await setInput(
      document.querySelector('[aria-label="Base URL"]') as HTMLInputElement,
      'https://gateway.example.test/v1'
    );
    await setInput(
      document.querySelector('[aria-label="Model ID"]') as HTMLInputElement,
      'claude-opus-4-8'
    );
    await setInput(
      document.querySelector(
        'input[placeholder="Stored separately in auth.json"]'
      ) as HTMLInputElement,
      'test-key'
    );
    await click('Save Model');

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-gateway',
        modelProvider: {
          id: 'claude-gateway',
          name: 'claude-gateway',
          baseUrl: 'https://gateway.example.test/v1',
          wireApi: 'anthropic-messages',
        },
      })
    );
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

  test('consumes Escape inside the dialog before the Settings panel', async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <AddModelModal
          open
          onOpenChange={onOpenChange}
          onSave={vi.fn().mockResolvedValue(true)}
          saveError={null}
        />
      );
      await Promise.resolve();
    });
    const provider = document.querySelector('[aria-label="Provider"]');

    await act(async () => {
      provider?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
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
