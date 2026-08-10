// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditModelModal } from '../../../src/components/settings/EditModelModal';

describe('EditModelModal', () => {
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

  it('validates and persists the stream idle timeout without dropping overrides', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <EditModelModal
          open
          onOpenChange={vi.fn()}
          model={{
            id: 'deepseek-test',
            displayName: 'DeepSeek Test',
            provider: 'deepseek',
            model: 'deepseek-chat',
            overrides: {
              baseUrl: 'https://gateway.example.test/v1',
              temperature: 0.2,
              streamIdleTimeout: 300_000,
            },
          }}
          onSave={onSave}
          saveError={null}
        />
      );
      await Promise.resolve();
    });

    const idleTimeout = document.querySelector<HTMLInputElement>(
      'input[placeholder="300000"]'
    );
    const baseUrl = document.querySelector<HTMLInputElement>(
      'input[placeholder="Leave empty to use default endpoint"]'
    );
    expect(idleTimeout?.value).toBe('300000');

    await setInput(idleTimeout, '999');
    await click('Save');
    expect(document.body.textContent).toContain(
      'Stream idle timeout must be at least 1000ms'
    );
    expect(onSave).not.toHaveBeenCalled();

    await setInput(idleTimeout, '120000');
    await setInput(baseUrl, '');
    await click('Save');
    expect(onSave).toHaveBeenCalledWith('deepseek-test', {
      displayName: 'DeepSeek Test',
      overrides: {
        temperature: 0.2,
        streamIdleTimeout: 120_000,
      },
    });
  });

  it('consumes Escape inside the dialog', async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <EditModelModal
          open
          onOpenChange={onOpenChange}
          model={{
            id: 'deepseek-test',
            provider: 'deepseek',
            model: 'deepseek-chat',
          }}
          onSave={vi.fn().mockResolvedValue(true)}
          saveError={null}
        />
      );
      await Promise.resolve();
    });
    const displayName = document.querySelector('input');

    await act(async () => {
      displayName?.dispatchEvent(
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

  async function setInput(
    input: HTMLInputElement | null,
    value: string
  ): Promise<void> {
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setter?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
});
