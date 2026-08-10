// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISABLE_BRACKETED_PASTE,
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_BRACKETED_PASTE,
} from '../../../../../src/ui/input/terminalInput.js';

const write = vi.fn();

vi.mock('ink', () => ({
  useStdout: () => ({
    stdout: {
      isTTY: true,
      write,
    },
  }),
}));

import { useTerminalInputModes } from '../../../../../src/ui/hooks/useTerminalInputModes.js';

describe('useTerminalInputModes', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    write.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('enables bracketed paste and restores terminal modes on unmount', () => {
    function Harness() {
      useTerminalInputModes();
      return null;
    }

    act(() => root.render(<Harness />));
    expect(write.mock.calls.map(([value]) => value)).toEqual([
      ENABLE_BRACKETED_PASTE,
      DISABLE_TERMINAL_FOCUS_REPORTING,
    ]);

    act(() => root.unmount());
    expect(write.mock.calls.map(([value]) => value)).toEqual([
      ENABLE_BRACKETED_PASTE,
      DISABLE_TERMINAL_FOCUS_REPORTING,
      DISABLE_BRACKETED_PASTE,
      DISABLE_TERMINAL_FOCUS_REPORTING,
    ]);
  });
});
