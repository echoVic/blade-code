// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  glob: vi.fn(),
}));

vi.mock('fast-glob', () => ({
  default: mocks.glob,
}));

import {
  clearAtCompletionCache,
  useAtCompletion,
} from '../../../../../src/ui/hooks/useAtCompletion.js';

describe('useAtCompletion', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let input = '';
  let state: ReturnType<typeof useAtCompletion> | undefined;
  let cwd = '/workspace/one';

  function Harness() {
    state = useAtCompletion(input, input.length, { cwd, debounceDelay: 300 });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clearAtCompletionCache();
    mocks.glob.mockReset().mockResolvedValue(['src/alpha.ts', 'docs/readme.md']);
    input = '';
    cwd = `/workspace/${Math.random()}`;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('does not scan files until an at mention is present', () => {
    act(() => root.render(<Harness />));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(mocks.glob).not.toHaveBeenCalled();
    expect(state?.suggestions).toEqual([]);
    expect(state?.loading).toBe(false);
  });

  it('loads files once and reuses the cached list while the query changes', async () => {
    input = '@src';
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(state?.suggestions).toContain('src/alpha.ts');
    expect(mocks.glob).toHaveBeenCalledOnce();

    input = '@alpha';
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(state?.suggestions).toEqual(['src/alpha.ts']);
    expect(mocks.glob).toHaveBeenCalledOnce();
  });
});
