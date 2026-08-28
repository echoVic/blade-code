// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ink = vi.hoisted(() => ({
  activeHandlers: [] as Array<(input: string, key: Record<string, boolean>) => void>,
}));

vi.mock('ink', () => ({
  useInput: (
    handler: (input: string, key: Record<string, boolean>) => void,
    options?: { isActive?: boolean }
  ) => {
    if (options?.isActive !== false) {
      ink.activeHandlers.push(handler);
    }
  },
}));

import {
  TerminalInputRouterProvider,
  useTerminalInput,
} from '../../../../../src/ui/input/TerminalInputRouter.js';

describe('TerminalInputRouter', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    ink.activeHandlers.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses one active Ink listener and dispatches by priority until consumed', () => {
    const events: string[] = [];
    function LowPriority() {
      useTerminalInput(() => {
        events.push('low');
      });
      return null;
    }
    function HighPriority() {
      useTerminalInput(
        () => {
          events.push('high');
          return true;
        },
        { priority: 100 }
      );
      return null;
    }

    act(() => {
      root.render(
        <TerminalInputRouterProvider>
          <LowPriority />
          <HighPriority />
        </TerminalInputRouterProvider>
      );
    });

    expect(ink.activeHandlers).toHaveLength(1);
    act(() => {
      ink.activeHandlers[0]?.('j', {});
    });
    expect(events).toEqual(['high']);
  });

  it('continues to lower-priority handlers when the owner passes through', () => {
    const events: string[] = [];
    function Handlers() {
      useTerminalInput(
        () => {
          events.push('global');
          return false;
        },
        { priority: 20 }
      );
      useTerminalInput(() => {
        events.push('editor');
        return true;
      });
      return null;
    }

    act(() => {
      root.render(
        <TerminalInputRouterProvider>
          <Handlers />
        </TerminalInputRouterProvider>
      );
    });
    act(() => {
      ink.activeHandlers[0]?.('x', {});
    });

    expect(events).toEqual(['global', 'editor']);
  });
});
