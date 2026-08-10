// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/session';

const requestJson = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/http', () => ({ requestJson }));

import { WorkspaceTrustPanel } from '../../../src/components/settings/WorkspaceTrustPanel';

const untrusted = {
  projectPath: '/workspace/project',
  trustRoot: '/workspace/project',
  state: 'untrusted',
  trusted: false,
  sensitiveSources: 2,
  decision: 'undecided',
  sources: [
    {
      path: '.blade/config.json',
      kind: 'config',
      keys: ['mcpServers'],
      effects: [
        {
          kind: 'mcp',
          name: 'project (stdio)',
          target: 'node server.js',
        },
      ],
    },
    {
      path: 'package.json',
      kind: 'package',
      keys: ['type-check'],
      effects: [
        {
          kind: 'command',
          name: 'package script: type-check',
        },
      ],
    },
  ],
};

describe('WorkspaceTrustPanel', () => {
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

  it('requires explicit confirmation before trusting project execution config', async () => {
    requestJson.mockResolvedValueOnce(untrusted).mockResolvedValueOnce({
      ...untrusted,
      state: 'trusted',
      trusted: true,
      decision: 'trusted',
      reloadRequired: true,
    });

    await act(async () => {
      root.render(<WorkspaceTrustPanel />);
    });

    expect(container.textContent).toContain('Review required');
    expect(container.textContent).toContain('node server.js');
    expect(container.textContent).toContain('package script: type-check');
    expect(container.textContent).not.toContain('node malicious-verifier.cjs');

    const trustButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Trust workspace'
    );
    await act(async () => {
      trustButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('configure models, MCP, LSP, permissions');

    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Trust reviewed workspace'
    );
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestJson).toHaveBeenNthCalledWith(2, '/workspace-trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/project',
        action: 'trust',
      }),
    });
    expect(container.textContent).toContain('Workspace trusted');
    expect(container.textContent).toContain('Restart Blade');
  });

  it('shows a no-op state when no executable project config exists', async () => {
    requestJson.mockResolvedValueOnce({
      ...untrusted,
      state: 'not_required',
      trusted: true,
      sensitiveSources: 0,
      sources: [],
    });

    await act(async () => {
      root.render(<WorkspaceTrustPanel />);
    });

    expect(container.textContent).toContain('No trust required');
    expect(container.textContent).toContain(
      'No project-controlled executable configuration'
    );
    const trustButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Trust workspace'
    );
    expect(trustButton?.disabled).toBe(true);
  });
});
