// @vitest-environment jsdom

import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '@api/attachmentLimits';
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
  let readAsDataUrl: ReturnType<typeof vi.fn<(file: File) => void>>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    originalFileReader = globalThis.FileReader;
    readAsDataUrl = vi.fn<(file: File) => void>();
    sessionStorage.clear();

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: null | ((this: FileReader, ev: ProgressEvent<FileReader>) => void) = null;
      onerror: null | ((this: FileReader, ev: ProgressEvent<FileReader>) => void) =
        null;

      readAsDataURL(file: File) {
        readAsDataUrl(file);
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
        {
          id: 'model-1',
          displayName: 'Test',
          provider: 'openai',
          model: 'gpt-4',
          contextWindow: 128000,
          reasoning: true,
          supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
          supportedServiceTiers: ['standard', 'fast', 'flex'],
          supportedResponseVerbosities: ['low', 'medium', 'high'],
          input: ['text', 'image'],
        },
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
      sessions: [],
      currentSessionId: null,
      currentSessionRef: null,
      isTemporarySession: true,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxContextTokens: 128000,
        isDefaultMaxTokens: true,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
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

  test('exposes stable selectors for permission mode qualification', async () => {
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-blade-permission-mode="default"]'
    );
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    const yolo = document.querySelector<HTMLButtonElement>(
      '[data-blade-permission-option="yolo"]'
    );
    expect(yolo).toBeTruthy();
    await act(async () => {
      yolo?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-blade-yolo-confirm]')).toBeTruthy();
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
      (button) => button.getAttribute('aria-label') === 'Remove pasted.png'
    );

    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('img')).toBeNull();
  });

  test('rejects oversized images before reading them and keeps the composer usable', async () => {
    const onSend = vi.fn();
    act(() => {
      root.render(<ChatInput onSend={onSend} />);
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const oversized = new File(['x'], 'oversized.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', {
      configurable: true,
      value: Math.ceil((MAX_INLINE_ATTACHMENT_BYTES * 3) / 4),
    });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [oversized],
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(readAsDataUrl).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'must stay under 5.0 MiB total'
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  test('rejects attachment batches above the shared count before reading them', async () => {
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = Array.from(
      { length: MAX_INLINE_ATTACHMENT_COUNT + 1 },
      (_, index) =>
        new File(['x'], `image-${index}.png`, {
          type: 'image/png',
        })
    );

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: files,
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(readAsDataUrl).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      `up to ${MAX_INLINE_ATTACHMENT_COUNT} images`
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  test('rejects pasted images for text-only models before reading them', async () => {
    useConfigStore.setState({
      configuredModels: [
        {
          id: 'model-1',
          displayName: 'Text only',
          provider: 'openai',
          model: 'text-model',
          input: ['text'],
        },
      ],
    });
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const attachmentButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="does not support images"]'
    );
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(attachmentButton?.getAttribute('aria-disabled')).toBe('true');
    expect(attachmentButton?.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      attachmentButton?.focus();
      attachmentButton?.click();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(attachmentButton);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Text only does not support images'
    );

    const image = new File(['image'], 'unsupported.png', {
      type: 'image/png',
    });
    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    }) as Event & {
      clipboardData: {
        items: Array<{ type: string; getAsFile: () => File }>;
      };
    };
    pasteEvent.clipboardData = {
      items: [{ type: 'image/png', getAsFile: () => image }],
    };

    await act(async () => {
      textarea.dispatchEvent(pasteEvent);
      await Promise.resolve();
    });

    expect(readAsDataUrl).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Text only does not support images'
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(textarea.disabled).toBe(false);
  });

  test('opens model choices from an unavailable attachment control when vision is available', async () => {
    useConfigStore.setState({
      configuredModels: [
        {
          id: 'model-1',
          displayName: 'Text only',
          provider: 'openai',
          model: 'text-model',
          input: ['text'],
        },
        {
          id: 'model-2',
          displayName: 'Vision model',
          provider: 'openai',
          model: 'vision-model',
          input: ['text', 'image'],
        },
      ],
    });
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const attachmentButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="does not support images"]'
    );
    await act(async () => {
      attachmentButton?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Text only does not support images'
    );
    expect(document.body.textContent).toContain('Vision model');
    expect(document.body.textContent).toContain('Vision');
  });

  test('preserves attachments but blocks sending when switching to a text-only model', async () => {
    useConfigStore.setState({
      configuredModels: [
        {
          id: 'model-1',
          displayName: 'Vision model',
          provider: 'openai',
          model: 'vision-model',
          input: ['text', 'image'],
        },
        {
          id: 'model-2',
          displayName: 'Text model',
          provider: 'openai',
          model: 'text-model',
          input: ['text'],
        },
      ],
    });
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = new File(['image'], 'kept.png', { type: 'image/png' });
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [image],
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('img[alt="kept.png"]')).toBeTruthy();

    act(() => {
      useConfigStore.setState({ currentModelId: 'model-2' });
    });

    expect(container.querySelector('img[alt="kept.png"]')).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(
      container.querySelector(
        'button[aria-label="Text model does not support images. Choose a vision model or remove the images."]'
      )
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.disabled
    ).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Text model does not support images'
    );

    act(() => {
      useConfigStore.setState({ currentModelId: 'model-1' });
    });

    expect(container.querySelector('img[alt="kept.png"]')).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.disabled
    ).toBe(false);
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
      modelId: 'model-1',
      reasoningEffort: 'high',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
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
      modelId: 'model-1',
      reasoningEffort: 'high',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
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

  test('deduplicates repeated file input events for the same image', async () => {
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['same-image'], 'same.png', { type: 'image/png' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          value: [file],
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
    }

    expect(readAsDataUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.textContent).toContain('1/20 images');
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

  test('keeps the composer available while streaming so users can steer', () => {
    act(() => {
      root.render(
        <ChatInput
          onSend={vi.fn()}
          onAbort={vi.fn()}
          isStreaming
          pendingSteeringCount={2}
          pendingInputDelivery="current_turn"
          recoveredSteeringCount={1}
        />
      );
    });

    const textarea = container.querySelector('textarea');
    expect(textarea?.disabled).toBe(false);
    expect(textarea?.placeholder).toContain('steer the active turn');
    expect(container.textContent).toContain('Guidance accepted · 2 pending');
    expect(container.textContent).toContain(
      'Recovered 1 queued instruction after restart'
    );
    expect(container.querySelector('[title="Stop active turn"]')).toBeTruthy();
    expect(container.querySelector('[title="Steer active turn"]')).toBeTruthy();
    const modelButton = container.querySelector<HTMLButtonElement>(
      'button[title="Wait for the active turn to finish before switching models"]'
    );
    expect(modelButton?.disabled).toBe(true);
  });

  test('distinguishes a next-turn follow-up from current-turn steering', () => {
    act(() => {
      root.render(
        <ChatInput
          onSend={vi.fn()}
          isStreaming
          pendingSteeringCount={1}
          pendingInputDelivery="next_turn"
        />
      );
    });

    expect(container.textContent).toContain(
      'Follow-up accepted · 1 queued for the next turn'
    );
    expect(container.textContent).not.toContain('Active turn is steerable');
  });

  test('shows an exclusive stopping state while preserving the composer', () => {
    act(() => {
      root.render(
        <ChatInput onSend={vi.fn()} onAbort={vi.fn()} isStreaming isStopping />
      );
    });

    const stopButton = container.querySelector(
      'button[aria-label="Stopping active turn"]'
    ) as HTMLButtonElement | null;
    expect(stopButton?.disabled).toBe(true);
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });

  test('keeps drafts editable while readiness blocks submission', () => {
    const onSend = vi.fn();
    act(() => {
      root.render(<ChatInput onSend={onSend} submitDisabled />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    act(() => {
      valueSetter?.call(textarea, 'Draft while configuring');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]'
    );
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('Draft while configuring');
    expect(sendButton?.disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  test('isolates and restores drafts by compound composer key', () => {
    const onSend = vi.fn();
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    const renderComposer = (draftKey: string) => {
      act(() => {
        root.render(<ChatInput key={draftKey} draftKey={draftKey} onSend={onSend} />);
      });
      return container.querySelector('textarea') as HTMLTextAreaElement;
    };

    const workspaceA = renderComposer('session:["/workspace/a","shared"]');
    act(() => {
      valueSetter?.call(workspaceA, 'Draft for workspace A');
      workspaceA.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const workspaceB = renderComposer('session:["/workspace/b","shared"]');
    expect(workspaceB.value).toBe('');
    act(() => {
      valueSetter?.call(workspaceB, 'Draft for workspace B');
      workspaceB.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(renderComposer('session:["/workspace/a","shared"]').value).toBe(
      'Draft for workspace A'
    );
    expect(renderComposer('session:["/workspace/b","shared"]').value).toBe(
      'Draft for workspace B'
    );
  });

  test('clears only the accepted composer draft', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const draftKey = 'session:["/workspace/accepted","task"]';
    act(() => {
      root.render(<ChatInput key={draftKey} draftKey={draftKey} onSend={onSend} />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    act(() => {
      valueSetter?.call(textarea, 'Accepted scoped draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector('button[aria-label="Send message"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    act(() => {
      root.render(<ChatInput key="other" draftKey="other" onSend={onSend} />);
    });
    act(() => {
      root.render(<ChatInput key={draftKey} draftKey={draftKey} onSend={onSend} />);
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  test('retains the draft and prevents duplicate submission until acceptance', async () => {
    let resolveSubmission!: (accepted: boolean) => void;
    const submission = new Promise<boolean>((resolve) => {
      resolveSubmission = resolve;
    });
    const onSend = vi.fn(() => submission);

    act(() => {
      root.render(<ChatInput onSend={onSend} isStreaming />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    act(() => {
      valueSetter?.call(textarea, 'Keep this guidance');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = container.querySelector(
      'button[aria-label="Steer active turn"]'
    );
    act(() => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSend).toHaveBeenCalledOnce();
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe('Keep this guidance');
    expect(
      container.querySelector('button[aria-label="Submitting message"]')
    ).toBeTruthy();

    await act(async () => {
      resolveSubmission(false);
      await submission;
    });

    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('Keep this guidance');
  });

  test('clears the draft only after the message is accepted', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    act(() => {
      root.render(<ChatInput onSend={onSend} />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    act(() => {
      valueSetter?.call(textarea, 'Accepted message');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector('button[aria-label="Send message"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledOnce();
    expect(textarea.value).toBe('');
  });

  test('restores a failed multimodal request into the composer', async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const restoredAttachment = {
      id: 'restored-image',
      name: 'attachment-1',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,restored',
    };

    act(() => {
      root.render(
        <ChatInput
          onSend={onSend}
          draft="Edit this request"
          draftAttachments={[restoredAttachment]}
          draftRevision={1}
        />
      );
    });

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Edit this request'
    );
    expect(container.querySelector('img[alt="attachment-1"]')).toBeTruthy();
    expect(container.textContent).toContain('1/20 images');

    await act(async () => {
      container
        .querySelector('button[aria-label="Send message"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith({
      content: 'Edit this request',
      modelId: 'model-1',
      reasoningEffort: 'high',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
      attachments: [restoredAttachment],
    });
  });

  test('restores and changes an existing session model without mutating the global default', async () => {
    const setCurrentModel = vi.fn().mockResolvedValue(undefined);
    useConfigStore.setState({
      configuredModels: [
        {
          id: 'model-1',
          displayName: 'Global default',
          provider: 'openai',
          model: 'gpt-4',
          contextWindow: 128000,
          input: ['text'],
        },
        {
          id: 'model-2',
          displayName: 'Session model',
          provider: 'openai',
          model: 'gpt-4.1',
          contextWindow: 256000,
          input: ['text'],
        },
      ],
      setCurrentModel,
    });
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'session-model',
          projectPath: '/tmp/project',
          title: 'Model session',
          rootId: 'session-model',
          taskStatus: 'completed',
          selectedModelId: 'model-2',
          messageCount: 1,
          firstMessageTime: '2026-08-07T00:00:00.000Z',
          lastMessageTime: '2026-08-07T00:00:00.000Z',
          hasErrors: false,
        },
      ],
      currentSessionId: 'session-model',
      currentSessionRef: {
        sessionId: 'session-model',
        projectPath: '/tmp/project',
      },
      isTemporarySession: false,
    });
    const onSend = vi.fn().mockResolvedValue(false);

    act(() => {
      root.render(<ChatInput onSend={onSend} />);
    });
    expect(container.textContent).toContain('Session model');
    expect(useSessionStore.getState().tokenUsage.maxContextTokens).toBe(256000);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    act(() => {
      valueSetter?.call(textarea, 'Use the session choice');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector('button[title="Change model"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const globalModelOption = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Global default'
    );
    await act(async () => {
      globalModelOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setCurrentModel).not.toHaveBeenCalled();
    expect(useSessionStore.getState().tokenUsage.maxContextTokens).toBe(128000);
    await act(async () => {
      container
        .querySelector('button[aria-label="Send message"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith({
      content: 'Use the session choice',
      modelId: 'model-1',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
      attachments: [],
    });
  });

  test('uses the configured display name in the model selector', () => {
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    expect(container.textContent).toContain('Test');
    expect(container.textContent).not.toContain('gpt-4');
  });

  test('defaults to a concrete supported effort without exposing auto', async () => {
    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change reasoning effort"]'
    );
    expect(trigger?.textContent).toContain('high');
    expect(trigger?.textContent).not.toContain('off');
    await act(async () => trigger?.click());
    expect(
      document.querySelector('button[aria-label="Use auto reasoning effort"]')
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Use high reasoning effort"]')
    ).toBeInstanceOf(HTMLButtonElement);
  });

  test('selects a model-supported reasoning effort and includes it in submission', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(<ChatInput onSend={onSend} />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Change reasoning effort"]'
        )
        ?.click();
    });
    const high = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Use high reasoning effort"]'
    );
    expect(high).toBeInstanceOf(HTMLButtonElement);
    await act(async () => high?.click());

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, 'Use deliberate reasoning');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith({
      content: 'Use deliberate reasoning',
      modelId: 'model-1',
      reasoningEffort: 'high',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
      attachments: [],
    });
  });

  test('preserves an explicit persisted off reasoning selection', async () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'session-off',
          projectPath: '/tmp/project',
          title: 'Explicit off session',
          rootId: 'session-off',
          taskStatus: 'completed',
          selectedModelId: 'model-1',
          reasoningEffort: 'off',
          messageCount: 1,
          firstMessageTime: '2026-08-21T00:00:00.000Z',
          lastMessageTime: '2026-08-21T00:00:00.000Z',
          hasErrors: false,
        },
      ],
      currentSessionId: 'session-off',
      currentSessionRef: {
        sessionId: 'session-off',
        projectPath: '/tmp/project',
      },
      isTemporarySession: false,
    });

    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Change reasoning effort"]'
      )?.textContent
    ).toContain('off');
  });

  test('resolves a historical persisted auto selection to a concrete effort', () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'session-auto',
          projectPath: '/tmp/project',
          title: 'Historical auto session',
          rootId: 'session-auto',
          taskStatus: 'completed',
          selectedModelId: 'model-1',
          reasoningEffort: 'auto',
          messageCount: 1,
          firstMessageTime: '2026-08-21T00:00:00.000Z',
          lastMessageTime: '2026-08-21T00:00:00.000Z',
          hasErrors: false,
        },
      ],
      currentSessionId: 'session-auto',
      currentSessionRef: {
        sessionId: 'session-auto',
        projectPath: '/tmp/project',
      },
      isTemporarySession: false,
    });

    act(() => {
      root.render(<ChatInput onSend={vi.fn()} />);
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Change reasoning effort"]'
      )?.textContent
    ).toContain('high');
  });

  test('selects a model-supported provider service tier and includes it in submission', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(<ChatInput onSend={onSend} />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Change provider service tier"]'
        )
        ?.click();
    });
    const fast = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Use fast service tier"]'
    );
    expect(fast).toBeInstanceOf(HTMLButtonElement);
    await act(async () => fast?.click());

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, 'Use the priority provider tier');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith({
      content: 'Use the priority provider tier',
      modelId: 'model-1',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
      attachments: [],
    });
  });

  test('selects model-supported response verbosity and includes it in submission', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(<ChatInput onSend={onSend} />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Change response verbosity"]'
        )
        ?.click();
    });
    const high = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Use high response verbosity"]'
    );
    expect(high).toBeInstanceOf(HTMLButtonElement);
    await act(async () => high?.click());

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, 'Use detailed output');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith({
      content: 'Use detailed output',
      modelId: 'model-1',
      reasoningEffort: 'high',
      serviceTier: 'auto',
      responseVerbosity: 'high',
      communicationStyle: 'auto',
      attachments: [],
    });
  });

  test('hides reasoning, service tier, and verbosity controls when the model offers no choice', async () => {
    useConfigStore.setState({
      currentModelId: 'basic-model',
      currentMode: 'autoEdit',
      configuredModels: [
        {
          id: 'basic-model',
          displayName: 'DeepSeek V4 Flash',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          contextWindow: 128000,
          reasoning: false,
          supportedReasoningEfforts: [],
          supportedServiceTiers: ['standard'],
          supportedResponseVerbosities: [],
          input: ['text'],
        },
      ],
      availableModels: [],
      isLoading: false,
      error: null,
      loadModels: vi.fn().mockResolvedValue(undefined),
      setCurrentModel: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
    });

    const onSend = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(<ChatInput onSend={onSend} />);
    });

    expect(
      container.querySelector('button[aria-label="Change reasoning effort"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Change provider service tier"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Change response verbosity"]')
    ).toBeNull();
    // Communication style is a global Settings preference, not a composer control.
    expect(
      container.querySelector('button[aria-label="Change communication style"]')
    ).toBeNull();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, 'Ship it');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
      await Promise.resolve();
    });
    // Model-defaulted dimensions still submit their effective value, even
    // without a visible control.
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Ship it',
        modelId: 'basic-model',
        serviceTier: 'auto',
        responseVerbosity: 'auto',
        communicationStyle: 'auto',
      })
    );
  });

  test('submits a turn-scoped JSON Schema from the structured output control', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(<ChatInput draftKey="schema-draft" onSend={onSend} />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Set structured output schema"]'
        )
        ?.click();
    });
    const schemaEditor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="JSON Schema editor"]'
    );
    expect(schemaEditor).toBeInstanceOf(HTMLTextAreaElement);
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    await act(async () => {
      valueSetter?.call(schemaEditor, JSON.stringify(schema));
      schemaEditor?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const composer = container.querySelector<HTMLTextAreaElement>(
      'textarea[data-blade-composer]'
    );
    await act(async () => {
      valueSetter?.call(composer, 'Return a structured answer');
      composer?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Return a structured answer',
        outputSchema: schema,
      })
    );
    expect(sessionStorage.getItem('blade.composer.draft.schema-draft')).toBeNull();
  });
});
