// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../../src/components/settings/SettingsModal';
import { useAppStore } from '../../../src/store/AppStore';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { useSettingsStore } from '../../../src/store/SettingsStore';

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
      settingsSection: 'general',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState({ isSettingsOpen: false });
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
});
