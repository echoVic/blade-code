// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ink = {
  activeHandlers: [] as Array<(input: string, key: Record<string, boolean>) => void>,
};

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
import {
  emitTuiComposerReadyMarker,
  formatTuiComposerReadyMarker,
  readTuiComposerReadyMarker,
} from '../../../../../src/ui/input/tuiComposerReady.js';

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

  it('fires onRegistered only after the active router handler is registered', () => {
    const events: string[] = [];

    function RegisteredHandler() {
      useTerminalInput(
        () => {
          events.push('handler');
          return true;
        },
        {
          onRegistered: () => {
            events.push('registered');
            ink.activeHandlers[0]?.('x', {});
          },
        }
      );
      return null;
    }

    act(() => {
      root.render(
        <TerminalInputRouterProvider>
          <RegisteredHandler />
        </TerminalInputRouterProvider>
      );
    });

    expect(events).toEqual(['registered', 'handler']);
  });

  it('does not fire onRegistered for inactive handlers', () => {
    const onRegistered = vi.fn();

    function InactiveHandler() {
      useTerminalInput(() => true, {
        isActive: false,
        onRegistered,
      });
      return null;
    }

    act(() => {
      root.render(
        <TerminalInputRouterProvider>
          <InactiveHandler />
        </TerminalInputRouterProvider>
      );
    });

    expect(onRegistered).not.toHaveBeenCalled();
  });

  it('does not read or emit a composer-ready marker when the env is absent', () => {
    const write = vi.fn<(value: string) => void>();

    expect(readTuiComposerReadyMarker({})).toBeUndefined();
    expect(emitTuiComposerReadyMarker({}, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'ABCDEF0123456789abcdef0123456789',
    '0123456789abcdef0123456789abcde',
    '0123456789abcdef0123456789abcdef0',
    '0123456789abcdef0123456789abcdeg',
  ])(
    'does not read or emit a composer-ready marker for malformed nonce %j',
    (nonce) => {
      const write = vi.fn<(value: string) => void>();
      const env = {
        BLADE_TUI_COMPOSER_READY_NONCE: nonce,
      } satisfies NodeJS.ProcessEnv;

      expect(readTuiComposerReadyMarker(env)).toBeUndefined();
      expect(emitTuiComposerReadyMarker(env, write)).toBe(false);
      expect(write).not.toHaveBeenCalled();
    }
  );

  it('reads and emits the exact composer-ready OSC marker for a valid nonce', () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    const env = {
      BLADE_TUI_COMPOSER_READY_NONCE: nonce,
    } satisfies NodeJS.ProcessEnv;
    const write = vi.fn<(value: string) => void>();
    const marker =
      '\u001b]99;blade-composer-ready=0123456789abcdef0123456789abcdef\u0007';

    expect(formatTuiComposerReadyMarker(nonce)).toBe(marker);
    expect(readTuiComposerReadyMarker(env)).toBe(marker);
    expect(emitTuiComposerReadyMarker(env, write)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(marker);
  });
});
