// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HistoryEntry,
  useCommandHistory,
} from '../../../../../src/ui/hooks/useCommandHistory.js';

describe('useCommandHistory', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let history: ReturnType<typeof useCommandHistory> | undefined;

  function Harness() {
    history = useCommandHistory();
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('navigates consecutive history entries within one input batch', () => {
    act(() => {
      history!.addToHistory('first');
      history!.addToHistory('second');
    });

    const entries: Array<HistoryEntry | null> = [];
    act(() => {
      entries.push(history!.getPreviousCommand(), history!.getPreviousCommand());
    });

    expect(entries[0]?.display).toBe('second');
    expect(entries[1]?.display).toBe('first');
  });

  it('restores the next entry and then exits history navigation', () => {
    act(() => {
      history!.addToHistory('first');
      history!.addToHistory('second');
    });

    const entries: Array<HistoryEntry | null> = [];
    act(() => {
      history!.getPreviousCommand();
      entries.push(
        history!.getPreviousCommand(),
        history!.getNextCommand(),
        history!.getNextCommand()
      );
    });

    expect(entries[0]?.display).toBe('first');
    expect(entries[1]?.display).toBe('second');
    expect(entries[2]).toBeNull();
  });
});
