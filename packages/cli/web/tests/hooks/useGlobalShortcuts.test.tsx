// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useGlobalShortcuts } from '../../src/hooks/useGlobalShortcuts';
import { useAppStore } from '../../src/store/AppStore';

function ShortcutHarness() {
  useGlobalShortcuts();
  return null;
}

function press(key: string, options: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  window.dispatchEvent(event);
  return event;
}

describe('useGlobalShortcuts', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useAppStore.setState({
      isTaskSwitcherOpen: false,
      taskSwitcherMode: 'tasks',
    });
    await act(async () => {
      root.render(<ShortcutHarness />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens, switches, and closes command center modes from global shortcuts', () => {
    const commands = press('P', { metaKey: true, shiftKey: true });
    expect(commands.defaultPrevented).toBe(true);
    expect(useAppStore.getState()).toMatchObject({
      isTaskSwitcherOpen: true,
      taskSwitcherMode: 'commands',
    });

    press('K', { metaKey: true });
    expect(useAppStore.getState()).toMatchObject({
      isTaskSwitcherOpen: true,
      taskSwitcherMode: 'tasks',
    });

    press('K', { metaKey: true });
    expect(useAppStore.getState().isTaskSwitcherOpen).toBe(false);
  });
});
