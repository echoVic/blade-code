// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../../src/components/settings/SettingsModal';
import { useAppStore } from '../../../src/store/AppStore';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { useSettingsStore } from '../../../src/store/SettingsStore';

function SettingsHarness() {
  const isSettingsOpen = useAppStore((state) => state.isSettingsOpen);
  return (
    <>
      <button
        type="button"
        data-settings-trigger
        onClick={() => useAppStore.getState().openSettings()}
      >
        Settings trigger
      </button>
      {isSettingsOpen && <SettingsModal />}
    </>
  );
}

describe('SettingsModal', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const loadModels = vi.fn().mockResolvedValue(undefined);
  const loadSettings = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    loadModels.mockClear();
    loadSettings.mockClear();
    useConfigStore.setState({
      currentModelId: null,
      configuredModels: [],
      availableModels: [],
      isLoading: false,
      hasLoaded: true,
      error: null,
      loadModels,
    });
    useSettingsStore.setState({ loadSettings });
    useAppStore.setState({
      isSettingsOpen: false,
      isMcpOpen: false,
      settingsSection: 'general',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      })
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState({ isSettingsOpen: false, isMcpOpen: false });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens directly on the requested models section', async () => {
    useAppStore.getState().openSettings('models');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });

    const modelsTab =
      document.body.querySelector<HTMLButtonElement>('#settings-tab-models');
    expect(modelsTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain(
      'Configure API keys and model settings'
    );
    expect(document.body.textContent).toContain('No models configured yet');
    expect(loadModels).toHaveBeenCalledOnce();
    expect(loadSettings).toHaveBeenCalledOnce();
  });

  it('moves keyboard focus across settings tab groups', async () => {
    useAppStore.getState().openSettings('general');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });

    const generalTab = document.body.querySelector<HTMLButtonElement>(
      '#settings-tab-general'
    );
    const hooksTab =
      document.body.querySelector<HTMLButtonElement>('#settings-tab-hooks');
    const pluginsTab = document.body.querySelector<HTMLButtonElement>(
      '#settings-tab-plugins'
    );
    generalTab?.focus();

    await act(async () => {
      generalTab?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true })
      );
    });
    expect(hooksTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(hooksTab);

    await act(async () => {
      hooksTab?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
      );
    });
    expect(pluginsTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(pluginsTab);
  });

  it('opens the mounted MCP panel instead of looping back to settings', async () => {
    useAppStore.getState().openSettings('mcp');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });
    const openMcp = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Open MCP Panel');

    await act(async () => {
      openMcp?.click();
      await Promise.resolve();
    });

    expect(useAppStore.getState()).toMatchObject({
      isSettingsOpen: true,
      isMcpOpen: true,
    });
  });

  it('closes with Escape and restores focus to the opening trigger', async () => {
    await act(async () => {
      root.render(<SettingsHarness />);
      await Promise.resolve();
    });
    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-settings-trigger]'
    );
    trigger?.focus();

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    const backButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-settings-panel] button')
    ).find((button) => button.textContent?.trim() === 'Back');
    await vi.waitFor(() => expect(document.activeElement).toBe(backButton));

    await act(async () => {
      backButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await Promise.resolve();
    });

    expect(useAppStore.getState().isSettingsOpen).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('falls back to the settings trigger after a programmatic open', async () => {
    await act(async () => {
      root.render(<SettingsHarness />);
      useAppStore.getState().openSettings();
      await Promise.resolve();
    });
    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-settings-trigger]'
    );
    const backButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-settings-panel] button')
    ).find((button) => button.textContent?.trim() === 'Back');
    await vi.waitFor(() => expect(document.activeElement).toBe(backButton));

    await act(async () => {
      backButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('uses Escape to dismiss inline deletion before closing settings', async () => {
    useConfigStore.setState({
      configuredModels: [
        {
          id: 'deepseek-test',
          displayName: 'DeepSeek Test',
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      ],
    });
    useAppStore.getState().openSettings('models');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });
    const providerButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('#settings-panel-models button')
    ).find((button) => button.textContent?.includes('deepseek'));
    await act(async () => providerButton?.click());
    const deleteButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Delete DeepSeek Test"]'
    );
    await act(async () => deleteButton?.click());
    const confirmation =
      document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(confirmation).toBeTruthy();

    await act(async () => {
      confirmation?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(useAppStore.getState().isSettingsOpen).toBe(true);
  });

  it('uses the first Escape to close Add Model and the second to close settings', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      })
    );
    useAppStore.getState().openSettings('models');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });
    const addButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('#settings-panel-models button')
    ).find((button) => button.textContent?.includes('Add New Model'));
    await act(async () => {
      addButton?.click();
      await Promise.resolve();
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).toBeTruthy();

    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      );
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(useAppStore.getState().isSettingsOpen).toBe(true);

    now += 251;
    const backButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-settings-panel] button')
    ).find((button) => button.textContent?.trim() === 'Back');
    await act(async () => {
      backButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await Promise.resolve();
    });
    expect(useAppStore.getState().isSettingsOpen).toBe(false);
    nowSpy.mockRestore();
  });

  it('tests and explicitly cascades a custom provider channel', async () => {
    useConfigStore.setState({
      configuredModels: [
        {
          id: 'team-model',
          displayName: 'Team Model',
          provider: 'team-gateway',
          model: 'vendor-model',
        },
      ],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/providers') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'team-gateway',
              name: 'Team Gateway',
              modelCount: 1,
              defaultBaseUrl: 'https://gateway.example.test/v1',
              supportsApiKey: true,
              configured: true,
              custom: true,
              wireApi: 'openai-completions',
            },
          ],
        } as Response;
      }
      if (url === '/providers/team-gateway/probe') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            providerId: 'team-gateway',
            modelConfigId: 'team-model',
            model: 'vendor-model',
            wireApi: 'openai-completions',
            latencyMs: 42,
            code: 'ok',
            message: 'Provider responded successfully.',
          }),
        } as Response;
      }
      if (
        url === '/providers/team-gateway?removeModels=true' &&
        init?.method === 'DELETE'
      ) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            removedModelIds: ['team-model'],
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.getState().openSettings('models');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Team Gateway'));

    const testButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Test Team Gateway"]'
    );
    await act(async () => {
      testButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Provider responded successfully. · 42ms'
      )
    );

    const deleteButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Delete channel Team Gateway"]'
    );
    await act(async () => deleteButton?.click());
    expect(document.body.textContent).toContain(
      'Delete channel Team Gateway, its credential, and 1 configured model(s)?'
    );
    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
    ).find((button) => button.textContent?.trim() === 'Delete channel');
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/providers/team-gateway?removeModels=true',
        { method: 'DELETE' }
      )
    );
  });

  it('exposes the global communication style selector on the General tab', async () => {
    useSettingsStore.setState({
      communicationStyle: 'auto',
      loadSettings,
    });
    useAppStore.getState().openSettings('general');

    await act(async () => {
      root.render(<SettingsModal />);
      await Promise.resolve();
    });

    // The global communication-style selector is present on the General tab and
    // reflects the persisted value. Selecting a new option is exercised in the
    // browser end-to-end suite (Radix popovers do not open under jsdom).
    const styleTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Communication Style"]'
    );
    expect(styleTrigger).toBeInstanceOf(HTMLButtonElement);
    expect(styleTrigger?.textContent).toContain('Auto');
  });
});
