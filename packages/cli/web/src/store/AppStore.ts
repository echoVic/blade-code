import { create } from 'zustand'

interface AppState {
  isSidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  isFilePreviewOpen: boolean
  toggleFilePreview: () => void
  setFilePreviewOpen: (open: boolean) => void
  isSettingsOpen: boolean
  toggleSettings: () => void
  isMcpOpen: boolean
  toggleMcp: () => void
  isSkillsOpen: boolean
  toggleSkills: () => void
  isTerminalOpen: boolean
  toggleTerminal: () => void
}

export const useAppStore = create<AppState>((set) => ({
  isSidebarOpen: true,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  isFilePreviewOpen: false,
  toggleFilePreview: () => set((state) => ({ isFilePreviewOpen: !state.isFilePreviewOpen })),
  setFilePreviewOpen: (open) => set({ isFilePreviewOpen: open }),
  isSettingsOpen: false,
  toggleSettings: () => set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),
  isMcpOpen: false,
  toggleMcp: () => set((state) => ({ isMcpOpen: !state.isMcpOpen })),
  isSkillsOpen: false,
  toggleSkills: () => set((state) => ({ isSkillsOpen: !state.isSkillsOpen })),
  isTerminalOpen: false,
  toggleTerminal: () => set((state) => ({ isTerminalOpen: !state.isTerminalOpen })),
}))
