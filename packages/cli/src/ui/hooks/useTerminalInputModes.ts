import { useStdout } from 'ink';
import { useEffect } from 'react';
import {
  DISABLE_BRACKETED_PASTE,
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_BRACKETED_PASTE,
} from '../input/terminalInput.js';

export function useTerminalInputModes(): void {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdout.isTTY) return;

    stdout.write(ENABLE_BRACKETED_PASTE);
    stdout.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    return () => {
      stdout.write(DISABLE_BRACKETED_PASTE);
      stdout.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    };
  }, [stdout]);
}
