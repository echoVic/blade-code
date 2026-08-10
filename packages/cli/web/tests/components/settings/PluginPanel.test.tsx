// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginPanel } from '../../../src/components/settings/PluginPanel';
import { setLocale } from '../../../src/i18n';
import { useSessionStore } from '../../../src/store/session';

describe('PluginPanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useSessionStore.setState({
      currentSessionRef: null,
      selectedProjectPath: '/tmp/plugin-project',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    setLocale('en');
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the selected project and persists a local disable', async () => {
    let enabled = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/plugins?projectPath=%2Ftmp%2Fplugin-project') {
        return {
          ok: true,
          json: async () => [
            {
              name: 'review-plugin',
              description: 'Review changes',
              version: '1.0.0',
              source: 'project',
              enabled,
              status: enabled ? 'active' : 'inactive',
              commands: 1,
              skills: 0,
              agents: 0,
              hooks: 1,
              mcpServers: 0,
              configurable: true,
              managed: false,
              effectiveScope: 'project',
              settingLayers: {
                global: false,
                project: enabled,
              },
              compatibilityIssues: [],
            },
          ],
        } as Response;
      }
      if (url === '/plugins/catalog?projectPath=%2Ftmp%2Fplugin-project') {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url === '/plugins/policy?projectPath=%2Ftmp%2Fplugin-project') {
        return {
          ok: true,
          json: async () => ({
            policy: {
              restrictToAllowedSources: false,
              requireGitCommitSha: false,
              allowedGitHosts: [],
              allowedMarketplaces: [],
              allowedLocalRoots: [],
            },
            environmentRequiresSha: false,
          }),
        } as Response;
      }
      if (url === '/plugins/review-plugin/state' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          projectPath: '/tmp/plugin-project',
          enabled: false,
          scope: 'project',
        });
        enabled = false;
        return {
          ok: true,
          json: async () => ({
            name: 'review-plugin',
            requestedEnabled: false,
            effectiveEnabled: false,
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<PluginPanel />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Review changes')
    );
    expect(document.body.textContent).toContain('effective: Project');
    expect(document.body.textContent).toContain('Global off · Project on');
    act(() => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[role="radio"][title="Shared project settings"]'
        )
        ?.click();
    });
    const toggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Disable review-plugin"]'
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        document.body.querySelector('[aria-label="Enable review-plugin"]')
      ).toBeTruthy()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/review-plugin/state',
      expect.objectContaining({ method: 'POST' })
    );

    act(() => setLocale('zh'));
    expect(document.body.textContent).toContain('生效范围：项目');
    expect(document.body.textContent).toContain('全局 关 · 项目 关');
  });

  it('installs from a Marketplace and confirms managed updates and removal', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/plugins?projectPath=%2Ftmp%2Fplugin-project') {
        return {
          ok: true,
          json: async () => [
            {
              name: 'managed-plugin',
              description: 'Managed plugin',
              version: '1.0.0',
              source: 'user',
              enabled: true,
              status: 'active',
              commands: 1,
              skills: 0,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              configurable: true,
              managed: true,
              marketplace: 'team-market',
              revision: '1234567890abcdef',
            },
          ],
        } as Response;
      }
      if (url === '/plugins/catalog?projectPath=%2Ftmp%2Fplugin-project') {
        return {
          ok: true,
          json: async () => [
            {
              name: 'team-market',
              description: 'Team marketplace',
              sourceType: 'git',
              revision: 'abcdef1234567890',
              updatedAt: '2026-08-08T00:00:00.000Z',
              plugins: [
                {
                  name: 'catalog-plugin',
                  description: 'Catalog plugin',
                  version: '1.0.0',
                  tags: [],
                  installed: false,
                },
              ],
            },
          ],
        } as Response;
      }
      if (url === '/plugins/policy?projectPath=%2Ftmp%2Fplugin-project') {
        return {
          ok: true,
          json: async () => ({
            policy: {
              restrictToAllowedSources: false,
              requireGitCommitSha: false,
              allowedGitHosts: [],
              allowedMarketplaces: [],
              allowedLocalRoots: [],
            },
            environmentRequiresSha: false,
          }),
        } as Response;
      }
      if (
        url === '/plugins/install' ||
        url === '/plugins/managed-plugin/update' ||
        url === '/plugins/managed-plugin/uninstall' ||
        url === '/plugins/policy'
      ) {
        return {
          ok: true,
          json: async () => ({ changed: true }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<PluginPanel />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Team marketplace')
    );

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Require full Git commit SHA"]')
        ?.click()
    );
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Save plugin source policy"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/policy',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            projectPath: '/tmp/plugin-project',
            scope: 'local',
            policy: {
              restrictToAllowedSources: false,
              requireGitCommitSha: true,
              allowedGitHosts: [],
              allowedMarketplaces: [],
              allowedLocalRoots: [],
            },
          }),
        })
      )
    );

    const catalogButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('catalog-plugin'));
    act(() => catalogButton?.click());
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Plugin source"]')
        ?.value
    ).toBe('catalog-plugin@team-market');

    act(() =>
      document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
    );
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Install')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/install',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            projectPath: '/tmp/plugin-project',
            source: 'catalog-plugin@team-market',
            trust: true,
          }),
        })
      )
    );

    const update = () =>
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Update managed-plugin"]'
      );
    act(() => update()?.click());
    expect(update()?.textContent).toContain('Confirm update');
    await act(async () => {
      update()?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/managed-plugin/update',
        expect.objectContaining({ method: 'POST' })
      )
    );

    const uninstall = () =>
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Uninstall managed-plugin"]'
      );
    act(() => uninstall()?.click());
    expect(uninstall()?.textContent).toContain('Confirm remove');
    await act(async () => {
      uninstall()?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/managed-plugin/uninstall',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });
});
