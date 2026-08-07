import { create } from 'zustand';

export type SidebarView = 'project' | 'status';
export type PreviewTab = 'diff' | 'files' | 'logs';
export type SettingsSection = 'general' | 'models' | 'mcp' | 'skills' | 'shortcuts';
export type TaskSwitcherMode = 'tasks' | 'commands';

const SIDEBAR_VIEW_KEY = 'blade.sidebar.view';
const PREVIEW_WIDTH_KEY = 'blade.preview.width';
const DEFAULT_PREVIEW_WIDTH = 640;
const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 960;

const readSidebarView = (): SidebarView => {
  if (typeof localStorage === 'undefined') return 'project';
  const stored = localStorage.getItem(SIDEBAR_VIEW_KEY);
  return stored === 'status' || stored === 'project' ? stored : 'project';
};

const clampPreviewWidth = (width: number): number =>
  Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, Math.round(width)));

const readPreviewWidth = (): number => {
  if (typeof localStorage === 'undefined') return DEFAULT_PREVIEW_WIDTH;
  const raw = localStorage.getItem(PREVIEW_WIDTH_KEY);
  if (!raw) return DEFAULT_PREVIEW_WIDTH;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampPreviewWidth(stored) : DEFAULT_PREVIEW_WIDTH;
};

interface AppState {
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  sidebarView: SidebarView;
  setSidebarView: (view: SidebarView) => void;
  isFilePreviewOpen: boolean;
  toggleFilePreview: () => void;
  setFilePreviewOpen: (open: boolean) => void;
  previewWidth: number;
  setPreviewWidth: (width: number) => void;
  previewTab: PreviewTab;
  setPreviewTab: (tab: PreviewTab) => void;
  previewTargetPath: string | null;
  previewRequestId: number;
  openFilePreview: (input?: { tab?: PreviewTab; targetPath?: string | null }) => void;
  isSettingsOpen: boolean;
  settingsSection: SettingsSection;
  toggleSettings: () => void;
  openSettings: (section?: SettingsSection) => void;
  isMcpOpen: boolean;
  toggleMcp: () => void;
  isSkillsOpen: boolean;
  toggleSkills: () => void;
  isTerminalOpen: boolean;
  toggleTerminal: () => void;
  isTaskSwitcherOpen: boolean;
  taskSwitcherMode: TaskSwitcherMode;
  setTaskSwitcherOpen: (open: boolean, mode?: TaskSwitcherMode) => void;
  setTaskSwitcherMode: (mode: TaskSwitcherMode) => void;
}

export const useAppStore = create<AppState>((set) => ({
  isSidebarOpen: true,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  sidebarView: readSidebarView(),
  setSidebarView: (view) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SIDEBAR_VIEW_KEY, view);
    }
    set({ sidebarView: view });
  },
  isFilePreviewOpen: false,
  toggleFilePreview: () =>
    set((state) => ({ isFilePreviewOpen: !state.isFilePreviewOpen })),
  setFilePreviewOpen: (open) => set({ isFilePreviewOpen: open }),
  previewWidth: readPreviewWidth(),
  setPreviewWidth: (width) => {
    const next = clampPreviewWidth(width);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(next));
    }
    set({ previewWidth: next });
  },
  previewTab: 'diff',
  setPreviewTab: (tab) => set({ previewTab: tab }),
  previewTargetPath: null,
  previewRequestId: 0,
  openFilePreview: (input) =>
    set((state) => ({
      isFilePreviewOpen: true,
      previewTab: input?.tab ?? state.previewTab,
      previewTargetPath: input?.targetPath ?? null,
      previewRequestId: state.previewRequestId + 1,
    })),
  isSettingsOpen: false,
  settingsSection: 'general',
  toggleSettings: () =>
    set((state) => ({
      isSettingsOpen: !state.isSettingsOpen,
      ...(!state.isSettingsOpen ? { settingsSection: 'general' as const } : {}),
    })),
  openSettings: (section = 'general') =>
    set({
      isSettingsOpen: true,
      settingsSection: section,
    }),
  isMcpOpen: false,
  toggleMcp: () =>
    set({ isSettingsOpen: true, settingsSection: 'mcp' }),
  isSkillsOpen: false,
  toggleSkills: () =>
    set({ isSettingsOpen: true, settingsSection: 'skills' }),
  isTerminalOpen: false,
  toggleTerminal: () => set((state) => ({ isTerminalOpen: !state.isTerminalOpen })),
  isTaskSwitcherOpen: false,
  taskSwitcherMode: 'tasks',
  setTaskSwitcherOpen: (open, mode) =>
    set((state) => ({
      isTaskSwitcherOpen: open,
      taskSwitcherMode: mode ?? state.taskSwitcherMode,
    })),
  setTaskSwitcherMode: (mode) => set({ taskSwitcherMode: mode }),
}));
