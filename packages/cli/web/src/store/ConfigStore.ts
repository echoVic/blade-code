import type { ModelConfig, PermissionMode } from '@api/schemas';
import { PermissionModeEnum } from '@api/schemas';
import { create } from 'zustand';
import { requestJson } from '@/lib/http';

export type { ModelConfig, PermissionMode };
export { PermissionModeEnum };
export const DEFAULT_WEB_PERMISSION_MODE = PermissionModeEnum.AUTO_EDIT;

interface ConfigState {
  currentModelId: string | null;
  currentMode: PermissionMode;
  configuredModels: ModelConfig[];
  availableModels: ModelConfig[];
  isLoading: boolean;
  hasLoaded: boolean;
  loadedWorkspacePath: string | null;
  error: string | null;

  loadModels: (workspacePath?: string) => Promise<void>;
  setCurrentModel: (modelId: string, workspacePath?: string) => Promise<void>;
  setMode: (mode: PermissionMode) => void;
  resetMode: () => void;
}

let modelRequestSequence = 0;

export const useConfigStore = create<ConfigState>((set, get) => ({
  currentModelId: null,
  currentMode: DEFAULT_WEB_PERMISSION_MODE,
  configuredModels: [],
  availableModels: [],
  isLoading: false,
  hasLoaded: false,
  loadedWorkspacePath: null,
  error: null,

  loadModels: async (workspacePath) => {
    const target = workspacePath ?? null;
    if (get().isLoading && get().loadedWorkspacePath === target) {
      return;
    }
    const requestSequence = ++modelRequestSequence;
    set({
      isLoading: true,
      hasLoaded: false,
      loadedWorkspacePath: target,
      error: null,
    });
    try {
      const data = await requestJson<{
        current: ModelConfig | null;
        configured: ModelConfig[];
        available?: ModelConfig[];
      }>(
        '/models',
        workspacePath ? { headers: { 'x-blade-directory': workspacePath } } : undefined
      );
      if (
        requestSequence !== modelRequestSequence ||
        get().loadedWorkspacePath !== target
      ) {
        return;
      }
      const currentModel = data.current as ModelConfig | null;

      set({
        currentModelId: currentModel?.id || null,
        configuredModels: data.configured || [],
        availableModels: data.available || [],
        isLoading: false,
        hasLoaded: true,
      });
    } catch (err) {
      if (
        requestSequence !== modelRequestSequence ||
        get().loadedWorkspacePath !== target
      ) {
        return;
      }
      set({
        error: err instanceof Error ? err.message : 'Failed to load models',
        isLoading: false,
        hasLoaded: true,
      });
    }
  },

  setCurrentModel: async (modelId, workspacePath) => {
    set({ error: null });
    if (workspacePath) {
      set({ currentModelId: modelId });
      return;
    }
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
  resetMode: () => set({ currentMode: DEFAULT_WEB_PERMISSION_MODE }),
}));
