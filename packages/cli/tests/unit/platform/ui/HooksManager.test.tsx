// @vitest-environment jsdom

import { act } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  disableSession: vi.fn(),
  enableSession: vi.fn(),
  useInput: vi.fn(),
}));

vi.mock('ink', () => ({
  Box: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('div', props, children),
  Text: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('span', props, children),
  useInput: (...args: unknown[]) => mocks.useInput(...args),
}));

vi.mock('ink-text-input', () => ({
  default: (props: { value: string }) =>
    React.createElement('input', { value: props.value, readOnly: true }),
}));

vi.mock('../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => ({
      disableSession: mocks.disableSession,
      enableSession: mocks.enableSession,
    }),
  },
}));

vi.mock('../../../../src/ui/themes/ThemeManager.js', () => ({
  themeManager: {
    getTheme: () => ({
      colors: {
        primary: 'blue',
        success: 'green',
        warning: 'yellow',
        error: 'red',
        muted: 'gray',
        border: { light: 'gray' },
      },
    }),
  },
}));

describe('HooksManager', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let inputHandler: ((input: string, key: Record<string, boolean>) => void) | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    inputHandler = undefined;
    mocks.disableSession.mockReset();
    mocks.enableSession.mockReset();
    mocks.useInput.mockReset();
    mocks.useInput.mockImplementation((handler: typeof inputHandler) => {
      inputHandler = handler;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('disables hooks only for the selected session and workspace', async () => {
    const { HooksManager } = await import(
      '../../../../src/ui/components/HooksManager.js'
    );
    await act(async () => {
      root.render(
        <HooksManager
          workspaceRoot="/workspace/project"
          sessionId="session-1"
          onClose={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Enable hooks for this session');
    expect(container.textContent).toContain('Disable hooks for this session');

    for (let index = 0; index < 4; index++) {
      await act(async () => {
        inputHandler?.('', { downArrow: true });
      });
    }
    await act(async () => {
      inputHandler?.('', { return: true });
    });

    expect(mocks.disableSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project'
    );
    expect(mocks.enableSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Hooks disabled for this session');
  });
});
