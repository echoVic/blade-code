// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  width: 100,
  write: vi.fn(),
  incrementClearCount: vi.fn(),
}));

vi.mock('ink', () => ({
  useStdout: () => ({ stdout: { write: mocks.write } }),
}));

vi.mock('../../../../../src/store/index.js', () => ({
  useBladeStore: (
    selector: (state: {
      session: { actions: { incrementClearCount: () => void } };
    }) => unknown
  ) =>
    selector({
      session: { actions: { incrementClearCount: mocks.incrementClearCount } },
    }),
}));

vi.mock('../../../../../src/ui/hooks/useTerminalWidth.js', () => ({
  useTerminalWidth: () => mocks.width,
}));

import { useRefreshStatic } from '../../../../../src/ui/hooks/useRefreshStatic.js';

describe('useRefreshStatic', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  function Harness() {
    useRefreshStatic();
    return null;
  }

  beforeEach(() => {
    mocks.width = 100;
    mocks.write.mockReset();
    mocks.incrementClearCount.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('refreshes immediately after the debounced terminal width changes', () => {
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.incrementClearCount).not.toHaveBeenCalled();

    mocks.width = 120;
    act(() => root.render(<Harness />));

    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.incrementClearCount).toHaveBeenCalledOnce();
  });
});
