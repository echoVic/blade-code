import type { SocketReadyState } from 'node:net';
import { PassThrough } from 'node:stream';
import { Box, render, useInput } from 'ink';
import { act, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusId } from '../../src/store/types.js';
import { getState } from '../../src/store/vanilla.js';
import { CustomTextInput } from '../../src/ui/components/CustomTextInput.js';
import { InputArea } from '../../src/ui/components/InputArea.js';
import { TranscriptPager } from '../../src/ui/components/TranscriptPager.js';
import { useInputBuffer } from '../../src/ui/hooks/useInputBuffer.js';
import { useTerminalInputModes } from '../../src/ui/hooks/useTerminalInputModes.js';
import {
  TerminalInputRouterProvider,
  useTerminalInput,
} from '../../src/ui/input/TerminalInputRouter.js';
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
} from '../../src/ui/input/terminalInput.js';

const RAW_INPUT_WAIT_OPTIONS = {
  interval: 20,
  timeout: 10_000,
} as const;

class TestInputStream extends PassThrough {
  public isTTY = true;
  public isRaw = false;
  public isRawMode = false;
  public bytesRead = 0;
  public bytesWritten = 0;
  public connecting = false;
  public destroyed = false;
  public pending = false;
  public bufferSize = 0;
  public readyState: SocketReadyState = 'open';

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.isRawMode = mode;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

class TestOutputStream extends PassThrough {
  public columns = 120;
  public rows = 40;
  public isTTY = true;
  public output = '';
  public bytesRead = 0;
  public bytesWritten = 0;
  public connecting = false;
  public destroyed = false;
  public pending = false;
  public bufferSize = 0;
  public readyState: SocketReadyState = 'open';

  constructor() {
    super();
    this.on('data', (chunk: string | Buffer) => {
      this.output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
  }

  clearLine(_direction: -1 | 0 | 1, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  clearScreenDown(callback?: () => void): boolean {
    callback?.();
    return true;
  }

  cursorTo(_x: number, _y?: number | (() => void), callback?: () => void): boolean {
    if (typeof _y === 'function') _y();
    else callback?.();
    return true;
  }

  moveCursor(_dx: number, _dy: number, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
}

describe('TUI batched input integration', () => {
  const activeRenders: Array<{ unmount: () => void }> = [];

  afterEach(() => {
    for (const instance of activeRenders.splice(0)) instance.unmount();
    getState().session.actions.resetSession();
    getState().focus.actions.setFocus(FocusId.MAIN_INPUT);
  });

  function startHarness() {
    const stdin = new TestInputStream();
    const stdout = new TestOutputStream();
    const stderr = new TestOutputStream();
    const submitted: string[] = [];
    let currentValue = '';

    function Harness() {
      useTerminalInputModes();
      const [value, setValue] = useState('');
      const [cursorPosition, setCursorPosition] = useState(0);
      currentValue = value;
      useInput((_input, key) => {
        if (key.return) submitted.push(currentValue);
      });
      return (
        <CustomTextInput
          value={value}
          cursorPosition={cursorPosition}
          onChange={setValue}
          onChangeCursorPosition={setCursorPosition}
          onPaste={async () => ({})}
          disabledKeys={['return']}
        />
      );
    }

    const instance = render(<Harness />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    activeRenders.push(instance);
    return {
      instance,
      stdin,
      stdout,
      submitted,
      readValue: () => currentValue,
    };
  }

  function startPagerHarness() {
    const stdin = new TestInputStream();
    const stdout = new TestOutputStream();
    const stderr = new TestOutputStream();
    let setPagerOpenExternal: ((open: boolean) => void) | null = null;
    let snapshot = {
      pagerOpen: false,
      value: '',
      cursorPosition: 0,
      pasteMappingCount: 0,
    };

    getState().session.actions.restoreSession(
      'pager-pty-session',
      [
        {
          id: 'oldest-message',
          role: 'user',
          content: 'oldest structured message',
          timestamp: 1,
        },
        {
          id: 'latest-message',
          role: 'assistant',
          content: Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join(
            '\n'
          ),
          timestamp: 2,
        },
      ],
      undefined,
      process.cwd()
    );
    getState().focus.actions.setFocus(FocusId.MAIN_INPUT);

    function PagerHarness() {
      useTerminalInputModes();
      const buffer = useInputBuffer('', 0);
      const [pagerOpen, setPagerOpen] = useState(false);
      setPagerOpenExternal = setPagerOpen;
      snapshot = {
        pagerOpen,
        value: buffer.value,
        cursorPosition: buffer.cursorPosition,
        pasteMappingCount: buffer.pasteMap.size,
      };
      useEffect(() => {
        getState().focus.actions.setFocus(
          pagerOpen ? FocusId.TRANSCRIPT_PAGER : FocusId.MAIN_INPUT
        );
      }, [pagerOpen]);
      useTerminalInput(
        (input, key) => {
          if ((key.ctrl || key.meta) && input.toLowerCase() === 'o') {
            setPagerOpen((open) => !open);
            return true;
          }
          return false;
        },
        { priority: 90 }
      );

      return (
        <Box flexDirection="column">
          <Box display={pagerOpen ? 'none' : 'flex'}>
            <InputArea
              input={buffer.value}
              cursorPosition={buffer.cursorPosition}
              onChange={buffer.setValue}
              onChangeCursorPosition={buffer.setCursorPosition}
              onAddPasteMapping={buffer.addPasteMapping}
              onAddImagePasteMapping={buffer.addImagePasteMapping}
            />
          </Box>
          <Box display={pagerOpen ? 'flex' : 'none'}>
            <TranscriptPager isOpen={pagerOpen} onClose={() => setPagerOpen(false)} />
          </Box>
        </Box>
      );
    }

    const instance = render(
      <TerminalInputRouterProvider>
        <PagerHarness />
      </TerminalInputRouterProvider>,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      }
    );
    activeRenders.push(instance);
    return {
      stdin,
      stdout,
      readSnapshot: () => snapshot,
      closePager: () => setPagerOpenExternal?.(false),
    };
  }

  async function waitForInputReady(stdin: TestInputStream): Promise<void> {
    await vi.waitFor(() => {
      expect(stdin.isRawMode).toBe(true);
    }, RAW_INPUT_WAIT_OPTIONS);
  }

  it('submits one complete multi-character stdin chunk', async () => {
    const { stdin, submitted, readValue } = startHarness();

    await waitForInputReady(stdin);
    stdin.write('! printf RAW_BATCH_OK');
    await vi.waitFor(() => {
      expect(readValue()).toBe('! printf RAW_BATCH_OK');
    }, RAW_INPUT_WAIT_OPTIONS);
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(submitted).toContain('! printf RAW_BATCH_OK');
    }, RAW_INPUT_WAIT_OPTIONS);
  });

  it('submits split bracketed paste without focus CSI leakage', async () => {
    const { stdin, submitted, readValue } = startHarness();

    await waitForInputReady(stdin);
    stdin.write('\u001B[200~');
    stdin.write('! printf RAW_PASTE_OK');
    stdin.write('\u001B[201~');
    stdin.write('\u001B[I');
    await vi.waitFor(() => {
      expect(readValue()).toBe('! printf RAW_PASTE_OK');
    }, RAW_INPUT_WAIT_OPTIONS);
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(submitted).toContain('! printf RAW_PASTE_OK');
    }, RAW_INPUT_WAIT_OPTIONS);
  });

  it('owns and restores bracketed paste terminal mode', async () => {
    const { instance, stdout } = startHarness();

    await vi.waitFor(() => {
      expect(stdout.output).toContain(ENABLE_BRACKETED_PASTE);
    }, RAW_INPUT_WAIT_OPTIONS);
    instance.unmount();
    expect(stdout.output).toContain(DISABLE_BRACKETED_PASTE);
  });

  it('preserves the complete composer while browsing the transcript pager', async () => {
    const { stdin, stdout, readSnapshot, closePager } = startPagerHarness();
    await waitForInputReady(stdin);

    const pasted = `${'draft '.repeat(100)}\nsecond line`;
    stdin.write('\u001B[200~');
    stdin.write(pasted);
    stdin.write('\u001B[201~');
    await vi.waitFor(() => {
      expect(readSnapshot().pasteMappingCount).toBe(1);
    }, RAW_INPUT_WAIT_OPTIONS);
    const beforePager = {
      value: readSnapshot().value,
      cursorPosition: readSnapshot().cursorPosition,
      pasteMappingCount: readSnapshot().pasteMappingCount,
    };

    act(() => {
      stdin.write('\x0f');
    });
    await vi.waitFor(() => {
      expect(readSnapshot().pagerOpen).toBe(true);
      expect(stdout.output).toContain('Transcript');
    }, RAW_INPUT_WAIT_OPTIONS);
    stdin.write('g');
    await vi.waitFor(() => {
      expect(stdout.output).toContain('oldest structured message');
    }, RAW_INPUT_WAIT_OPTIONS);

    act(() => closePager());
    await vi.waitFor(() => {
      expect(readSnapshot().pagerOpen).toBe(false);
    }, RAW_INPUT_WAIT_OPTIONS);
    expect(readSnapshot()).toMatchObject(beforePager);
  });
});
