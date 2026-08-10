// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/session';

const requestJson = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/http', () => ({ requestJson }));

import { HookTrustPanel } from '../../../src/components/settings/HookTrustPanel';

const untrusted = {
  projectPath: '/workspace/project',
  trustRoot: '/workspace/project',
  state: 'untrusted',
  enabled: true,
  configuredHooks: 1,
  currentDigest: `sha256:${'a'.repeat(64)}`,
  definitions: [
    {
      event: 'PreToolUse',
      matcher: '{"tools":"Bash"}',
      name: 'safety-check',
      type: 'command',
      target: 'bin/check.sh',
      pluginName: 'audit-plugin',
      pluginSource: 'project',
    },
  ],
};

const sessionEnabled = {
  sessionId: 'session-1',
  projectPath: '/workspace/project',
  enabled: true,
  paused: false,
  configEnabled: true,
};

describe('HookTrustPanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    requestJson.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useSessionStore.setState({
      currentSessionId: 'session-1',
      currentSessionRef: {
        sessionId: 'session-1',
        projectPath: '/workspace/project',
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('requires explicit confirmation before trusting the reviewed digest', async () => {
    requestJson
      .mockResolvedValueOnce(untrusted)
      .mockResolvedValueOnce(sessionEnabled)
      .mockResolvedValueOnce({
        ...untrusted,
        state: 'trusted',
        trustedDigest: untrusted.currentDigest,
      });

    await act(async () => {
      root.render(<HookTrustPanel />);
    });

    expect(container.textContent).toContain('Review required');
    expect(container.textContent).toContain('bin/check.sh');
    expect(container.textContent).toContain('audit-plugin · project');

    const trustButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Trust digest'
    );
    await act(async () => {
      trustButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain(
      'Run these 1 hooks with your user permissions'
    );

    const confirmButton = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Trust reviewed hooks'
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestJson).toHaveBeenNthCalledWith(3, '/hooks/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/project',
        action: 'trust',
        expectedDigest: untrusted.currentDigest,
      }),
    });
    expect(container.textContent).toContain('Trusted');
  });

  it('keeps a changed definition reviewable instead of auto-trusting it', async () => {
    requestJson
      .mockResolvedValueOnce({
        ...untrusted,
        state: 'modified',
        definitions: [
          {
            ...untrusted.definitions[0],
            target: 'bin/changed-check.sh',
          },
        ],
      })
      .mockResolvedValueOnce(sessionEnabled);

    await act(async () => {
      root.render(<HookTrustPanel />);
    });

    expect(container.textContent).toContain('Changed since approval');
    expect(container.textContent).toContain('bin/changed-check.sh');
    expect(container.textContent).toContain('Trust digest');
  });

  it('ignores a late trust response from the previously selected project', async () => {
    let resolveFirst!: (value: typeof untrusted) => void;
    requestJson.mockImplementation((url: string) => {
      if (url === '/hooks/trust?projectPath=%2Fworkspace%2Fproject') {
        return new Promise<typeof untrusted>((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (
        url === '/hooks/session?projectPath=%2Fworkspace%2Fproject&sessionId=session-1'
      ) {
        return Promise.resolve(sessionEnabled);
      }
      if (url === '/hooks/trust?projectPath=%2Fworkspace%2Fsecond') {
        return Promise.resolve({
          ...untrusted,
          projectPath: '/workspace/second',
          trustRoot: '/workspace/second',
          definitions: [
            {
              ...untrusted.definitions[0],
              target: 'bin/second-project.sh',
            },
          ],
        });
      }
      if (
        url === '/hooks/session?projectPath=%2Fworkspace%2Fsecond&sessionId=session-2'
      ) {
        return Promise.resolve({
          ...sessionEnabled,
          sessionId: 'session-2',
          projectPath: '/workspace/second',
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    await act(async () => {
      root.render(<HookTrustPanel />);
    });
    await act(async () => {
      useSessionStore.setState({
        currentSessionRef: {
          sessionId: 'session-2',
          projectPath: '/workspace/second',
        },
      });
    });

    expect(container.textContent).toContain('bin/second-project.sh');

    await act(async () => {
      resolveFirst({
        ...untrusted,
        definitions: [
          {
            ...untrusted.definitions[0],
            target: 'bin/late-first-project.sh',
          },
        ],
      });
    });

    expect(container.textContent).toContain('bin/second-project.sh');
    expect(container.textContent).not.toContain('bin/late-first-project.sh');
  });

  it('pauses only the current session through the session endpoint', async () => {
    requestJson
      .mockResolvedValueOnce(untrusted)
      .mockResolvedValueOnce(sessionEnabled)
      .mockResolvedValueOnce({
        ...sessionEnabled,
        enabled: false,
        paused: true,
      });

    await act(async () => {
      root.render(<HookTrustPanel />);
    });

    const sessionSwitch = container.querySelector<HTMLButtonElement>(
      '[aria-label="Pause hooks for current session"]'
    );
    expect(sessionSwitch?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      sessionSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestJson).toHaveBeenNthCalledWith(3, '/hooks/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/project',
        sessionId: 'session-1',
        enabled: false,
      }),
    });
    expect(
      container.querySelector('[aria-label="Enable hooks for current session"]')
    ).toBeTruthy();
  });

  it('renders a disabled switch when runtime policy cannot execute hooks', async () => {
    requestJson
      .mockResolvedValueOnce({
        ...untrusted,
        enabled: false,
        state: 'disabled',
      })
      .mockResolvedValueOnce({
        ...sessionEnabled,
        enabled: false,
        configEnabled: false,
      });

    await act(async () => {
      root.render(<HookTrustPanel />);
    });

    const sessionSwitch = container.querySelector<HTMLButtonElement>(
      '[aria-label="Hooks unavailable for current session"]'
    );
    expect(sessionSwitch).toBeInstanceOf(HTMLButtonElement);
    expect(sessionSwitch?.disabled).toBe(true);
    expect(sessionSwitch?.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('Disabled by workspace configuration.');
  });
});
