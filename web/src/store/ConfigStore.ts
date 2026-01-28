import type { ModelConfig, PermissionMode } from '@api/schemas'
import { PermissionModeEnum } from '@api/schemas'
import { create } from 'zustand'

export type { ModelConfig, PermissionMode }
export { PermissionModeEnum }

interface ConfigState {
  currentModelId: string | null
  currentMode: PermissionMode
  configuredModels: ModelConfig[]
  availableModels: ModelConfig[]
  isLoading: boolean
  error: string | null

  loadModels: () => Promise<void>
  setCurrentModel: (modelId: string) => Promise<void>
  setMode: (mode: PermissionMode) => void
}

export const useConfigStore = create<ConfigState>((set) => ({
  currentModelId: null,
  currentMode: PermissionModeEnum.DEFAULT,
  configuredModels: [],
  availableModels: [],
  isLoading: false,
  error: null,

  loadModels: async () => {
    set({ isLoading: true, error: null })
    try {
      const response = await fetch('/models')
      if (!response.ok) throw new Error('Failed to load models')
      
      const data = await response.json()
      const currentModel = data.current as ModelConfig | null
      
      set({
        currentModelId: currentModel?.id || null,
        configuredModels: data.configured || [],
        availableModels: data.available || [],
        isLoading: false,
      })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  setCurrentModel: async (modelId: string) => {
    try {
      const response = await fetch('/configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          updates: { currentModelId: modelId },
          options: { scope: 'global' }
        }),
      })
      if (!response.ok) throw new Error('Failed to set model')
      set({ currentModelId: modelId })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  setMode: (mode) => set({ currentMode: mode }),
}))
