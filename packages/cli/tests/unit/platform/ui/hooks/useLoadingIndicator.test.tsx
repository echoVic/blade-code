// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/ui/hooks/usePhraseCycler.js', () => ({
  usePhraseCycler: () => 'working',
}));

import { useLoadingIndicator } from '../../../../../src/ui/hooks/useLoadingIndicator.js';

describe('useLoadingIndicator', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let processing = false;
  let paused = false;
  let state: ReturnType<typeof useLoadingIndicator> | undefined;

  function Harness() {
    state = useLoadingIndicator(processing, false, paused);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    processing = false;
    paused = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('tracks wall-clock processing time and resets after completion', () => {
    processing = true;
    act(() => root.render(<Harness />));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(state).toEqual({ currentPhrase: 'working', elapsedTime: 2 });

    processing = false;
    act(() => root.render(<Harness />));
    expect(state).toEqual({ currentPhrase: 'working', elapsedTime: 0 });
  });

  it('stops rendering timer updates while paused and catches up after resume', () => {
    processing = true;
    act(() => root.render(<Harness />));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(state?.elapsedTime).toBe(1);

    paused = true;
    act(() => root.render(<Harness />));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(state?.elapsedTime).toBe(1);

    paused = false;
    act(() => root.render(<Harness />));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(state?.elapsedTime).toBe(7);
  });
});
