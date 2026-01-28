import type { GeneralSettings, ModelConfig } from '@api/schemas'

const API_BASE = ''

export interface ModelsResponse {
  current: ModelConfig | null
  configured: ModelConfig[]
  available: ModelConfig[]
}

export const configService = {
  getModels: async (): Promise<ModelsResponse> => {
    const res = await fetch(`${API_BASE}/models`)
    if (!res.ok) throw new Error('Failed to load models')
    return res.json()
  },

  setCurrentModel: async (modelId: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/configs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: { currentModelId: modelId },
        options: { scope: 'local' },
      }),
    })
    if (!res.ok) throw new Error('Failed to set model')
  },

  getSettings: async (): Promise<GeneralSettings> => {
    const res = await fetch(`${API_BASE}/configs`)
    if (!res.ok) throw new Error('Failed to load settings')
    return res.json()
  },

  updateSettings: async (updates: Partial<GeneralSettings>): Promise<void> => {
    const res = await fetch(`${API_BASE}/configs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates,
        options: { scope: 'global' },
      }),
    })
    if (!res.ok) throw new Error('Failed to save settings')
  },
}

export type { GeneralSettings, ModelConfig }
