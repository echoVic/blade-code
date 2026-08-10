import type { SocketReadyState } from 'node:net';
import { PassThrough } from 'node:stream';
import { render, useInput } from 'ink';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomTextInput } from '../../src/ui/components/CustomTextInput.js';
import { useTerminalInputModes } from '../../src/ui/hooks/useTerminalInputModes.js';
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
} from '../../src/ui/input/terminalInput.js';

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
  });

  function startHarness() {
    const stdin = new TestInputStream();
    const stdout = new TestOutputStream();
    const stderr = new TestOutputStream();
    const submitted: string[] = [];

    function Harness() {
      useTerminalInputModes();
      const [value, setValue] = useState('');
      const [cursorPosition, setCursorPosition] = useState(0);
      useInput((_input, key) => {
        if (key.return) submitted.push(value);
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
    return { instance, stdin, stdout, submitted };
  }

  it('submits one complete multi-character stdin chunk', async () => {
    const { stdin, stdout, submitted } = startHarness();

    stdin.write('! printf RAW_BATCH_OK');
    await vi.waitFor(() => {
      expect(stdout.output).toContain('RAW_BATCH_OK');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(submitted).toContain('! printf RAW_BATCH_OK');
    });
  });

  it('submits split bracketed paste without focus CSI leakage', async () => {
    const { stdin, stdout, submitted } = startHarness();

    stdin.write('\u001B[200~');
    stdin.write('! printf RAW_PASTE_OK');
    stdin.write('\u001B[201~');
    stdin.write('\u001B[I');
    await vi.waitFor(() => {
      expect(stdout.output).toContain('RAW_PASTE_OK');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(submitted).toContain('! printf RAW_PASTE_OK');
    });
  });

  it('owns and restores bracketed paste terminal mode', async () => {
    const { instance, stdout } = startHarness();

    await vi.waitFor(() => {
      expect(stdout.output).toContain(ENABLE_BRACKETED_PASTE);
    });
    instance.unmount();
    expect(stdout.output).toContain(DISABLE_BRACKETED_PASTE);
  });
});
