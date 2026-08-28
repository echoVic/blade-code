// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const stdout = {
    columns: 100,
    rows: 30,
    on: vi.fn((_event: string, listener: () => void) => {
      listeners.add(listener);
      return stdout;
    }),
    off: vi.fn((_event: string, listener: () => void) => {
      listeners.delete(listener);
      return stdout;
    }),
  };
  return { listeners, stdout };
});

vi.mock('ink', () => ({
  useStdout: () => ({ stdout: mocks.stdout }),
}));

import { useTerminalDimensions } from '../../../../../src/ui/hooks/useTerminalDimensions.js';
import { useTerminalWidth } from '../../../../../src/ui/hooks/useTerminalWidth.js';

describe('useTerminalDimensions', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let dimensions: ReturnType<typeof useTerminalDimensions> | undefined;
  let unmounted = false;

  function Harness() {
    dimensions = useTerminalDimensions();
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.clear();
    mocks.stdout.on.mockClear();
    mocks.stdout.off.mockClear();
    mocks.stdout.columns = 100;
    mocks.stdout.rows = 30;
    unmounted = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    if (!unmounted) act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('publishes width and height from one debounced resize subscription', () => {
    act(() => root.render(<Harness />));
    expect(dimensions).toEqual({ width: 100, height: 30 });
    expect(mocks.stdout.on).toHaveBeenCalledOnce();

    mocks.stdout.columns = 120;
    mocks.stdout.rows = 40;
    act(() => {
      for (const listener of mocks.listeners) listener();
      vi.advanceTimersByTime(199);
    });
    expect(dimensions).toEqual({ width: 100, height: 30 });

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(dimensions).toEqual({ width: 120, height: 40 });

    act(() => root.unmount());
    unmounted = true;
    expect(mocks.stdout.off).toHaveBeenCalledOnce();
  });

  it('does not rerender a width-only consumer for a height-only resize', () => {
    let renderCount = 0;
    let width = 0;
    function WidthHarness() {
      renderCount += 1;
      width = useTerminalWidth();
      return null;
    }

    act(() => root.render(<WidthHarness />));
    expect(width).toBe(100);
    expect(renderCount).toBe(1);

    mocks.stdout.rows = 50;
    act(() => {
      for (const listener of mocks.listeners) listener();
      vi.advanceTimersByTime(200);
    });

    expect(width).toBe(100);
    expect(renderCount).toBe(1);
  });
});
