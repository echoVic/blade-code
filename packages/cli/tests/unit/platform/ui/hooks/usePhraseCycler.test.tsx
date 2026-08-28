// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePhraseCycler } from '../../../../../src/ui/hooks/usePhraseCycler.js';

describe('usePhraseCycler', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let active = true;
  let waiting = false;
  let paused = false;
  let phrase = '';

  function Harness() {
    phrase = usePhraseCycler(active, waiting, paused);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);
    active = true;
    waiting = false;
    paused = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves the current phrase across pause and resume', () => {
    act(() => root.render(<Harness />));
    const initialPhrase = phrase;
    expect(initialPhrase).not.toBe('');
    expect(Math.random).toHaveBeenCalledTimes(2);

    paused = true;
    act(() => root.render(<Harness />));
    expect(phrase).toBe(initialPhrase);

    paused = false;
    act(() => root.render(<Harness />));
    expect(phrase).toBe(initialPhrase);
    expect(Math.random).toHaveBeenCalledTimes(2);
  });

  it('shows the fixed waiting phrase and clears it when inactive', () => {
    waiting = true;
    act(() => root.render(<Harness />));
    expect(phrase).toBe('等待用户确认...');

    waiting = false;
    active = false;
    act(() => root.render(<Harness />));
    expect(phrase).toBe('');
  });
});
