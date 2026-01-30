import type { GeneralSettings, UiTheme } from '@api/schemas'
import { create } from 'zustand'

interface SettingsState extends GeneralSettings {
  isLoading: boolean
  error: string | null
  loadSettings: () => Promise<void>
  updateSettings: (updates: Partial<GeneralSettings>) => Promise<void>
}

const getIsDark = (uiTheme: UiTheme): boolean => {
  if (uiTheme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return uiTheme === 'dark'
}

const applyThemeToDOM = (uiTheme: UiTheme) => {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (uiTheme === 'system') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    root.classList.add(systemTheme)
  } else {
    root.classList.add(uiTheme)
  }
}

const DEFAULT_SETTINGS: GeneralSettings = {
  language: 'zh-CN',
  theme: 'dracula',
  uiTheme: 'system',
  autoSaveSessions: true,
  notifyBuild: true,
  notifyErrors: false,
  notifySounds: false,
  privacyTelemetry: false,
  privacyCrash: true,
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  isLoading: false,
  error: null,

  loadSettings: async () => {
    set({ isLoading: true, error: null })
    try {
      const response = await fetch('/configs')
      if (!response.ok) throw new Error('Failed to load settings')
      const config = await response.json()
      
      const newUiTheme = config.uiTheme ?? DEFAULT_SETTINGS.uiTheme
      set({
        language: config.language ?? DEFAULT_SETTINGS.language,
        theme: config.theme ?? DEFAULT_SETTINGS.theme,
        uiTheme: newUiTheme,
        autoSaveSessions: config.autoSaveSessions ?? DEFAULT_SETTINGS.autoSaveSessions,
        notifyBuild: config.notifyBuild ?? DEFAULT_SETTINGS.notifyBuild,
        notifyErrors: config.notifyErrors ?? DEFAULT_SETTINGS.notifyErrors,
        notifySounds: config.notifySounds ?? DEFAULT_SETTINGS.notifySounds,
        privacyTelemetry: config.privacyTelemetry ?? DEFAULT_SETTINGS.privacyTelemetry,
        privacyCrash: config.privacyCrash ?? DEFAULT_SETTINGS.privacyCrash,
        isLoading: false,
      })
      applyThemeToDOM(newUiTheme)
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  updateSettings: async (updates: Partial<GeneralSettings>) => {
    const prevState = get()
    set({ ...updates, error: null })
    
    if (updates.uiTheme) {
      applyThemeToDOM(updates.uiTheme)
    }
    
    try {
      const response = await fetch('/configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates,
          options: { scope: 'global' },
        }),
      })
      if (!response.ok) throw new Error('Failed to save settings')
    } catch (err) {
      set({
        language: prevState.language,
        theme: prevState.theme,
        uiTheme: prevState.uiTheme,
        autoSaveSessions: prevState.autoSaveSessions,
        notifyBuild: prevState.notifyBuild,
        notifyErrors: prevState.notifyErrors,
        notifySounds: prevState.notifySounds,
        privacyTelemetry: prevState.privacyTelemetry,
        privacyCrash: prevState.privacyCrash,
        error: (err as Error).message,
      })
      if (updates.uiTheme) {
        applyThemeToDOM(prevState.uiTheme)
      }
    }
  },
}))

applyThemeToDOM(DEFAULT_SETTINGS.uiTheme)

export const useIsDark = () => useSettingsStore((state) => getIsDark(state.uiTheme))

export type { GeneralSettings, UiTheme }
