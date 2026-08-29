// @vitest-environment jsdom

import type { Key } from 'ink';
import { act, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as composerReady from '../../../../src/ui/input/tuiComposerReady.js';
import { TerminalInputRouterProvider } from '../../../../src/ui/input/TerminalInputRouter.js';

let inputHandler: ((input: string, key: Key) => void) | undefined;

vi.mock('ink', () => ({
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useInput: (handler: (input: string, key: Key) => void) => {
    inputHandler = handler;
  },
}));

vi.mock('../../../../src/ui/utils/imagePaste.js', () => ({
  getImageFromClipboard: vi.fn(async () => null),
  getTextFromClipboard: vi.fn(async () => null),
  isImagePath: vi.fn(() => false),
  processImageFromPath: vi.fn(async () => null),
}));

import { CustomTextInput } from '../../../../src/ui/components/CustomTextInput.js';

const plainKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
} satisfies Key;

describe('CustomTextInput batched terminal input', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let latest = { value: '', cursorPosition: 0 };
  let onPaste: ReturnType<typeof vi.fn<(text: string) => Promise<{ prompt?: string }>>>;
  let emitComposerReadyMarker: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    inputHandler = undefined;
    latest = { value: '', cursorPosition: 0 };
    onPaste = vi.fn(async (_text: string) => ({}));
    emitComposerReadyMarker = vi
      .spyOn(composerReady, 'emitTuiComposerReadyMarker')
      .mockImplementation(() => false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    function Harness() {
      const [state, setState] = useState(latest);
      latest = state;
      return (
        <CustomTextInput
          value={state.value}
          cursorPosition={state.cursorPosition}
          onChange={(value) => setState((current) => ({ ...current, value }))}
          onChangeCursorPosition={(cursorPosition) =>
            setState((current) => ({ ...current, cursorPosition }))
          }
          onPaste={onPaste}
        />
      );
    }

    act(() => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    emitComposerReadyMarker.mockRestore();
    delete process.env.BLADE_TUI_COMPOSER_READY_NONCE;
  });

  it('inserts a complete multi-character stdin chunk', async () => {
    await act(async () => {
      inputHandler?.('! printf TUI_BATCH_OK', plainKey);
      await Promise.resolve();
    });

    expect(latest).toEqual({
      value: '! printf TUI_BATCH_OK',
      cursorPosition: 21,
    });
  });

  it('accumulates rapid character callbacks before React rerenders', async () => {
    await act(async () => {
      for (const character of '! printf RAPID_OK') {
        inputHandler?.(character, plainKey);
      }
      await Promise.resolve();
    });

    expect(latest).toEqual({
      value: '! printf RAPID_OK',
      cursorPosition: 17,
    });
  });

  it('reassembles split bracketed paste and normalizes CRLF', async () => {
    await act(async () => {
      inputHandler?.('[200~', plainKey);
      inputHandler?.('! printf LINE_ONE\r\nLINE_TWO', plainKey);
      inputHandler?.('[201~', plainKey);
      await Promise.resolve();
    });

    expect(latest).toEqual({
      value: '! printf LINE_ONE\nLINE_TWO',
      cursorPosition: 26,
    });
    expect(onPaste).toHaveBeenCalledWith('! printf LINE_ONE\nLINE_TWO');
  });

  it('drops focus reports without dropping surrounding user input', async () => {
    await act(async () => {
      inputHandler?.('before', plainKey);
      inputHandler?.('[I', plainKey);
      inputHandler?.('after', plainKey);
      await Promise.resolve();
    });

    expect(latest).toEqual({
      value: 'beforeafter',
      cursorPosition: 11,
    });
  });

  it('keeps input after an asynchronous paste projection in source order', async () => {
    let resolvePaste: ((value: { prompt?: string }) => void) | undefined;
    onPaste.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePaste = resolve;
        })
    );

    await act(async () => {
      inputHandler?.('[200~first\r\nsecond[201~', plainKey);
      inputHandler?.('after', plainKey);
      await Promise.resolve();
    });
    expect(latest).toEqual({ value: '', cursorPosition: 0 });

    await act(async () => {
      resolvePaste?.({ prompt: '[paste]' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toEqual({
      value: '[paste]after',
      cursorPosition: 12,
    });
  });

  it('emits the nonce-bound ready marker only after terminal input registration', () => {
    const events: string[] = [];
    emitComposerReadyMarker.mockImplementation(() => {
      events.push('marker');
      return true;
    });

    act(() => {
      root.unmount();
    });

    function RegistrationHarness() {
      const [state, setState] = useState({ value: '', cursorPosition: 0 });
      return (
        <TerminalInputRouterProvider>
          <CustomTextInput
            value={state.value}
            cursorPosition={state.cursorPosition}
            onChange={(value) => setState((current) => ({ ...current, value }))}
            onChangeCursorPosition={(cursorPosition) =>
              setState((current) => ({ ...current, cursorPosition }))
            }
            onPaste={onPaste}
          />
        </TerminalInputRouterProvider>
      );
    }

    act(() => {
      process.env.BLADE_TUI_COMPOSER_READY_NONCE = '0123456789abcdef0123456789abcdef';
      root = ReactDOM.createRoot(container);
      root.render(<RegistrationHarness />);
      events.push('rendered');
    });

    expect(events).toEqual(['rendered', 'marker']);
    expect(emitComposerReadyMarker).toHaveBeenCalledTimes(1);
  });
});
