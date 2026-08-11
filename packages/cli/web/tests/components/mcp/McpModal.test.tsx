// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpPanel } from '../../../src/components/mcp/McpModal';

const requestJson = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/http', () => ({ requestJson }));

const oauthServer = {
  id: 'remote',
  name: 'remote',
  status: 'error',
  endpoint: 'https://mcp.example.test/rpc',
  description: 'MCP server: remote',
  tools: [],
  error: 'OAuth authorization required',
  logging: { enabled: true, level: 'warning' },
  oauthEnabled: true,
  oauthStatus: 'unauthenticated',
};

describe('McpModal OAuth lifecycle', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    requestJson.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders only the authorization URL returned by the explicit login endpoint', async () => {
    let status = 'unauthenticated';
    requestJson.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/mcp/remote/logs?limit=20' && !options) {
        return { revision: 0, entries: [] };
      }
      if (url === '/mcp' && !options) {
        return [{ ...oauthServer, oauthStatus: status }];
      }
      if (url === '/mcp/remote/oauth/login' && options?.method === 'POST') {
        status = 'authorizing';
        return {
          success: true,
          authorizationUrl: 'https://auth.example.test/authorize?state=opaque',
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => {
      root.render(<McpPanel active />);
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Authorization required')
    );
    const authorize = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Authorize');

    await act(async () => {
      authorize?.click();
      await Promise.resolve();
    });
    const continueLink = await vi.waitFor(() => {
      const link = Array.from(
        document.body.querySelectorAll<HTMLAnchorElement>('a')
      ).find((candidate) => candidate.textContent === 'Continue authorization');
      expect(link).toBeTruthy();
      return link;
    });
    expect(requestJson).toHaveBeenCalledWith('/mcp/remote/oauth/login', {
      method: 'POST',
    });
    expect(continueLink?.href).toBe('https://auth.example.test/authorize?state=opaque');
    expect(continueLink?.target).toBe('_blank');
    expect(continueLink?.rel).toBe('noopener noreferrer');
    expect(document.body.textContent).toContain('Waiting for authorization...');
  });

  it('clears credentials only after an explicit sign-out click', async () => {
    let authenticated = true;
    requestJson.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/mcp/remote/logs?limit=20' && !options) {
        return { revision: 0, entries: [] };
      }
      if (url === '/mcp' && !options) {
        return [
          {
            ...oauthServer,
            status: authenticated ? 'connected' : 'offline',
            error: undefined,
            oauthStatus: authenticated ? 'authenticated' : 'unauthenticated',
          },
        ];
      }
      if (url === '/mcp/remote/oauth/logout' && options?.method === 'POST') {
        authenticated = false;
        return { success: true };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => {
      root.render(<McpPanel active />);
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Authorized'));
    const signOut = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Sign out');

    await act(async () => {
      signOut?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Authorization required')
    );
    expect(requestJson).toHaveBeenCalledWith('/mcp/remote/oauth/logout', {
      method: 'POST',
    });
  });

  it('renders bounded recovery progress and lets the user cancel backoff', async () => {
    let recovering = true;
    requestJson.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/mcp/remote/logs?limit=20' && !options) {
        return { revision: 0, entries: [] };
      }
      if (url === '/mcp' && !options) {
        return [
          {
            ...oauthServer,
            status: recovering ? 'reconnecting' : 'offline',
            error: recovering ? 'Connection closed' : undefined,
            oauthEnabled: false,
            oauthStatus: 'disabled',
            recovery: recovering
              ? {
                  phase: 'reconnecting',
                  reason: 'transport_closed',
                  attempt: 2,
                  maxAttempts: 5,
                }
              : undefined,
          },
        ];
      }
      if (url === '/mcp/remote/disconnect' && options?.method === 'POST') {
        recovering = false;
        return { success: true };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => {
      root.render(<McpPanel active />);
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Recovering 2/5')
    );
    const stop = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Stop recovery');

    await act(async () => {
      stop?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Offline'));
    expect(requestJson).toHaveBeenCalledWith('/mcp/remote/disconnect', {
      method: 'POST',
    });
  });

  it('renders sanitized diagnostics and changes the negotiated logging level', async () => {
    let level = 'warning';
    requestJson.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/mcp' && !options) {
        return [
          {
            ...oauthServer,
            status: 'connected',
            error: undefined,
            oauthEnabled: false,
            oauthStatus: 'disabled',
            logging: { enabled: true, level },
            instructions: {
              text: 'Use INSTRUCTION_CODE_42',
              sourceBytes: 23,
              projectedBytes: 23,
              sha256: 'b'.repeat(64),
              truncated: false,
              detailsOmitted: false,
            },
          },
        ];
      }
      if (url === '/mcp/remote/logs?limit=20' && !options) {
        return {
          revision: 3,
          entries: [
            {
              revision: 3,
              serverName: 'remote',
              level: 'warning',
              logger: 'fixture',
              message: 'SAFE_LOG_MARKER',
              projectedBytes: 15,
              dataSha256: 'a'.repeat(64),
              truncated: false,
              detailsOmitted: false,
              timestamp: 1_000,
            },
          ],
        };
      }
      if (url === '/mcp/remote/logging-level' && options?.method === 'POST') {
        level = JSON.parse(String(options.body)).level;
        return { success: true, level };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => {
      root.render(<McpPanel active />);
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('SAFE_LOG_MARKER')
    );
    const debug = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'debug');

    await act(async () => {
      debug?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(debug?.getAttribute('aria-pressed')).toBe('true');
      expect(debug?.textContent).toBe('debug');
      expect(document.body.textContent).not.toContain('Setting...');
    });
    expect(requestJson).toHaveBeenCalledWith('/mcp/remote/logging-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });
    expect(document.body.textContent).toContain('sha256');
    expect(document.body.textContent).toContain('INSTRUCTION_CODE_42');
  });

  it('requests and renders bounded MCP argument completions', async () => {
    requestJson.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/mcp' && !options) {
        return [
          {
            ...oauthServer,
            status: 'connected',
            error: undefined,
            oauthEnabled: false,
            oauthStatus: 'disabled',
            completionSupported: true,
            tasks: {
              enabled: true,
              defaultTtlMs: 60_000,
              pollIntervalMs: 250,
              maxTasksPerSession: 8,
              maxLifetimeMs: 120_000,
            },
            prompts: [
              {
                name: 'deploy',
                arguments: [{ name: 'environment', required: true }],
              },
            ],
            resourceTemplates: [],
          },
        ];
      }
      if (url === '/mcp/remote/logs?limit=20' && !options) {
        return { revision: 0, entries: [] };
      }
      if (url === '/mcp/remote/complete' && options?.method === 'POST') {
        return {
          values: ['production'],
          total: 1,
          hasMore: false,
          sourceValueCount: 1,
          sourceBytes: 32,
          projectedBytes: 10,
          sha256: 'd'.repeat(64),
          truncated: false,
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => {
      root.render(<McpPanel active />);
    });
    const input = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="MCP completion partial value"]'
      );
      expect(element).toBeTruthy();
      return element!;
    });
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      setValue?.call(input, 'pro');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const complete = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Complete');

    await act(async () => {
      complete?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain('production'));
    expect(requestJson).toHaveBeenCalledWith('/mcp/remote/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference: { type: 'prompt', name: 'deploy' },
        argument: { name: 'environment', value: 'pro' },
      }),
    });
    expect(document.body.textContent).toContain('sha256');
    expect(document.body.textContent).toContain('Experimental MCP Tasks');
    expect(document.body.textContent).toContain('8 per Session · 250ms poll');
    expect(document.body.textContent).not.toContain('Completing...');
  });
});
