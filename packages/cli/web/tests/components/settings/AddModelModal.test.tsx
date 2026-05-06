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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const prototype = Object.getPrototypeOf(input) as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  test('keeps manual model id input available for providers with built-in model lists', async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/providers') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 'deepseek',
              name: 'DeepSeek',
              icon: '',
              description: '2 个模型',
              envVars: [],
              defaultBaseUrl: 'https://api.deepseek.com/v1',
              bladeProvider: 'openai-compatible',
            },
          ],
        } as Response);
      }

      if (url === '/providers/deepseek/models') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
          ],
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    await act(async () => {
      root.render(
        <AddModelModal
          open
          onOpenChange={vi.fn()}
          onSave={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const providerButton = buttons.find((button) =>
      button.textContent?.includes('Custom (OpenAI Compatible)')
    );

    expect(providerButton).toBeTruthy();

    await act(async () => {
      providerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const deepseekOption = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('DeepSeek')
    );

    expect(deepseekOption).toBeTruthy();

    await act(async () => {
      deepseekOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Select model');

    const modelInputs = Array.from(document.body.querySelectorAll('input')).filter(
      (input) => (input as HTMLInputElement).placeholder === 'gpt-4o, claude-3-opus, deepseek-chat, etc.'
    );

    expect(modelInputs).toHaveLength(1);
  });

  test('submits a manually entered model id for DeepSeek', async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/providers') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 'deepseek',
              name: 'DeepSeek',
              icon: '',
              description: '2 个模型',
              envVars: [],
              defaultBaseUrl: 'https://api.deepseek.com/v1',
              bladeProvider: 'openai-compatible',
            },
          ],
        } as Response);
      }

      if (url === '/providers/deepseek/models') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
          ],
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const onSave = vi.fn();

    await act(async () => {
      root.render(
        <AddModelModal
          open
          onOpenChange={vi.fn()}
          onSave={onSave}
        />
      );
      await Promise.resolve();
    });

    const providerButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Custom (OpenAI Compatible)')
    );

    await act(async () => {
      providerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const deepseekOption = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('DeepSeek')
    );

    await act(async () => {
      deepseekOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const apiKeyInput = Array.from(document.body.querySelectorAll('input')).find(
      (input) => (input as HTMLInputElement).placeholder === 'sk-........................'
    ) as HTMLInputElement | undefined;

    const modelIdInput = Array.from(document.body.querySelectorAll('input')).find(
      (input) => (input as HTMLInputElement).placeholder === 'gpt-4o, claude-3-opus, deepseek-chat, etc.'
    ) as HTMLInputElement | undefined;

    expect(apiKeyInput).toBeTruthy();
    expect(modelIdInput).toBeTruthy();

    await act(async () => {
      setInputValue(apiKeyInput!, 'sk-test');
      setInputValue(modelIdInput!, 'deepseek-v4-pro');
      await Promise.resolve();
    });

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save Model')
    ) as HTMLButtonElement | undefined;

    expect(saveButton).toBeTruthy();
    expect(saveButton?.disabled).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith({
      bladeProvider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-pro',
      name: 'deepseek-v4-pro',
    });
  });
});
