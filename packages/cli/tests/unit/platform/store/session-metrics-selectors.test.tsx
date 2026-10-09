// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  usePromptCacheMetrics,
  useSessionCostMetrics,
} from '../../../../src/store/selectors/index.js';
import { sessionActions } from '../../../../src/store/vanilla.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('session metrics selectors', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let renders = 0;

  function Harness() {
    usePromptCacheMetrics();
    useSessionCostMetrics();
    renders += 1;
    return null;
  }

  beforeEach(() => {
    renders = 0;
    sessionActions().resetTokenUsage();
    sessionActions().setCompacting(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sessionActions().setCompacting(false);
  });

  it('keeps derived metric snapshots stable across unrelated store updates', () => {
    act(() => root.render(<Harness />));
    expect(renders).toBe(1);

    act(() => sessionActions().setCompacting(true));

    expect(renders).toBe(1);
  });
});
