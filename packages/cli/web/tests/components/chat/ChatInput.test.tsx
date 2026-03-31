// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChatInput } from '../../../src/components/chat/ChatInput';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { useSessionStore } from '../../../src/store/session';

describe('ChatInput', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let originalFileReader: typeof FileReader;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    originalFileReader = globalThis.FileReader;

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: null | ((this: FileReader, ev: ProgressEvent<FileReader>) => void) = null;
      onerror: null | ((this: FileReader, ev: ProgressEvent<FileReader>) => void) =
        null;

      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,mock-data`;
        this.onload?.call(
          this as unknown as FileReader,
          {} as ProgressEvent<FileReader>
        );
      }
    }

    globalThis.FileReader = MockFileReader as typeof FileReader;

    useConfigStore.setState({
      currentModelId: 'model-1',
      currentMode: 'default',
      configuredModels: [
        { id: 'model-1', name: 'Test', provider: 'openai', model: 'gpt-test' },
      ],
      availableModels: [],
      isLoading: false,
      error: null,
      loadModels: vi.fn().mockResolvedValue(undefined),
      setCurrentModel: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
    });

    useSessionStore.setState((state) => ({
      ...state,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxContextTokens: 128000,
        isDefaultMaxTokens: true,
      },
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    globalThis.FileReader = originalFileReader;
    container.remove();
  });

  test('adds pasted images as attachments and allows removal', async () => {
    const onSend = vi.fn();

    act(() => {
      root.render(<ChatInput onSend={onSend as never} />);
    });

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    const file = new File(['image-bytes'], 'pasted.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    }) as Event & {
      clipboardData: {
        items: Array<{ type: string; getAsFile: () => File | null }>;
      };
    };
    pasteEvent.clipboardData = {
      items: [{ type: 'image/png', getAsFile: () => file }],
    };

    await act(async () => {
      textarea?.dispatchEvent(pasteEvent);
      await Promise.resolve();
    });

    expect(container.querySelector('img')).toBeTruthy();

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.toLowerCase().includes('remove')
    );

    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('img')).toBeNull();
  });

  test('sends image-only messages collected from the paperclip input', async () => {
    const onSend = vi.fn();

    act(() => {
      root.render(<ChatInput onSend={onSend as never} />);
    });

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();

    const file = new File(['image-bytes'], 'picked.png', { type: 'image/png' });

    await act(async () => {
      Object.defineProperty(fileInput!, 'files', {
        configurable: true,
        value: [file],
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const sendButton = buttons[buttons.length - 1];

    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith({
      content: '',
      attachments: [
        expect.objectContaining({
          name: 'picked.png',
          mimeType: 'image/png',
        }),
      ],
    });
  });

  test('collects multiple images from the paperclip input and filters non-image files', async () => {
    const onSend = vi.fn();

    act(() => {
      root.render(<ChatInput onSend={onSend as never} />);
    });

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();

    const png = new File(['image-a'], 'picked-a.png', { type: 'image/png' });
    const jpeg = new File(['image-b'], 'picked-b.jpg', { type: 'image/jpeg' });
    const text = new File(['text'], 'note.txt', { type: 'text/plain' });

    await act(async () => {
      Object.defineProperty(fileInput!, 'files', {
        configurable: true,
        value: [png, text, jpeg],
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelectorAll('img')).toHaveLength(2);

    const buttons = Array.from(container.querySelectorAll('button'));
    const sendButton = buttons[buttons.length - 1];

    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith({
      content: '',
      attachments: [
        expect.objectContaining({
          name: 'picked-a.png',
          mimeType: 'image/png',
        }),
        expect.objectContaining({
          name: 'picked-b.jpg',
          mimeType: 'image/jpeg',
        }),
      ],
    });
  });

  test('ignores non-image clipboard items when pasting', async () => {
    const onSend = vi.fn();

    act(() => {
      root.render(<ChatInput onSend={onSend as never} />);
    });

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    }) as Event & {
      clipboardData: {
        items: Array<{ type: string; getAsFile: () => File | null }>;
      };
    };
    pasteEvent.clipboardData = {
      items: [{ type: 'text/plain', getAsFile: () => null }],
    };

    await act(async () => {
      textarea?.dispatchEvent(pasteEvent);
      await Promise.resolve();
    });

    expect(container.querySelector('img')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});
