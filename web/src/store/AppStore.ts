import { create } from 'zustand'

interface AppState {
  isSidebarOpen: boolean
  toggleSidebar: () => void
  isFilePreviewOpen: boolean
  toggleFilePreview: () => void
  isSettingsOpen: boolean
  toggleSettings: () => void
  isTerminalOpen: boolean
  toggleTerminal: () => void
}

export const useAppStore = create<AppState>((set) => ({
  isSidebarOpen: true,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  isFilePreviewOpen: false,
  toggleFilePreview: () => set((state) => ({ isFilePreviewOpen: !state.isFilePreviewOpen })),
  isSettingsOpen: false,
  toggleSettings: () => set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),
  isTerminalOpen: false,
  toggleTerminal: () => set((state) => ({ isTerminalOpen: !state.isTerminalOpen })),
}))
