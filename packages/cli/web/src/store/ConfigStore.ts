import type { ModelConfig, PermissionMode } from '@api/schemas';
import { PermissionModeEnum } from '@api/schemas';
import { create } from 'zustand';
import { requestJson } from '@/lib/http';

export type { ModelConfig, PermissionMode };
export { PermissionModeEnum };

interface ConfigState {
  currentModelId: string | null;
  currentMode: PermissionMode;
  configuredModels: ModelConfig[];
  availableModels: ModelConfig[];
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;

  loadModels: () => Promise<void>;
  setCurrentModel: (modelId: string) => Promise<void>;
  setMode: (mode: PermissionMode) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  currentModelId: null,
  currentMode: PermissionModeEnum.DEFAULT,
  configuredModels: [],
  availableModels: [],
  isLoading: false,
  hasLoaded: false,
  error: null,

  loadModels: async () => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });
    try {
      const data = await requestJson<{
        current: ModelConfig | null;
        configured: ModelConfig[];
        available?: ModelConfig[];
      }>('/models');
      const currentModel = data.current as ModelConfig | null;

      set({
        currentModelId: currentModel?.id || null,
        configuredModels: data.configured || [],
        availableModels: data.available || [],
        isLoading: false,
        hasLoaded: true,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load models',
        isLoading: false,
        hasLoaded: true,
      });
    }
  },

  setCurrentModel: async (modelId: string) => {
    set({ error: null });
    try {
      await requestJson('/configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: { currentModelId: modelId },
          options: { scope: 'global' },
        }),
      });
      set({ currentModelId: modelId });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to set model',
      });
      throw err;
    }
  },

  setMode: (mode) => set({ currentMode: mode }),
}));
