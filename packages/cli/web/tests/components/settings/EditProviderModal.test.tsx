// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditProviderModal } from '../../../src/components/settings/EditProviderModal';

describe('EditProviderModal', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('validates endpoint changes and sends a credential separately', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <EditProviderModal
          provider={{
            id: 'team-gateway',
            name: 'Team Gateway',
            modelCount: 1,
            defaultBaseUrl: 'https://old.example.test/v1',
            supportsApiKey: true,
            configured: true,
            custom: true,
            wireApi: 'openai-completions',
            apiKeyEnv: 'TEAM_GATEWAY_API_KEY',
          }}
          onOpenChange={onOpenChange}
          onSave={onSave}
          saveError={null}
        />
      );
      await Promise.resolve();
    });

    await setInput('Provider Base URL', 'not-a-url');
    await click('Save channel');
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('absolute HTTP(S) URL');

    await setInput('Provider Base URL', 'https://new.example.test/v1');
    await setInput('Provider API key', 'replacement-key');
    await selectOption('Wire API', 'anthropic-messages');
    await click('Save channel');

    expect(onSave).toHaveBeenCalledWith('team-gateway', {
      name: 'Team Gateway',
      baseUrl: 'https://new.example.test/v1',
      wireApi: 'anthropic-messages',
      apiKeyEnv: 'TEAM_GATEWAY_API_KEY',
      apiKey: 'replacement-key',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('consumes Escape inside the provider dialog', async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <EditProviderModal
          provider={{
            id: 'team-gateway',
            name: 'Team Gateway',
            modelCount: 0,
            defaultBaseUrl: 'https://old.example.test/v1',
            supportsApiKey: true,
            configured: false,
            custom: true,
            wireApi: 'openai-completions',
          }}
          onOpenChange={onOpenChange}
          onSave={vi.fn().mockResolvedValue(true)}
          saveError={null}
        />
      );
      await Promise.resolve();
    });

    const input = document.querySelector('[aria-label="Channel name"]');
    await act(async () => {
      input?.dispatchEvent(
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

  async function setInput(label: string, value: string) {
    const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
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
    });
  }
});
