import { useEffect } from 'react';
import { focusBladeComposer } from '@/lib/composerFocus';
import { isEditableShortcutTarget, shortcutForEvent } from '@/lib/keyboardShortcuts';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';

export function useGlobalShortcuts(): void {
  const setTaskSwitcherOpen = useAppStore((state) => state.setTaskSwitcherOpen);
  const setMainView = useAppStore((state) => state.setMainView);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const startTemporarySession = useSessionStore((state) => state.startTemporarySession);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const shortcut = shortcutForEvent(event);
      if (!shortcut) return;

      const appState = useAppStore.getState();
      const taskSwitcherOpen = appState.isTaskSwitcherOpen;
      const editableTarget = isEditableShortcutTarget(event.target);
      const blockingDialog = Boolean(document.querySelector('[role="dialog"]'));

      if (shortcut.id === 'searchTasks' || shortcut.id === 'openCommands') {
        if (blockingDialog && !taskSwitcherOpen) return;
        event.preventDefault();
        const mode = shortcut.id === 'searchTasks' ? 'tasks' : 'commands';
        const closesCurrentMode =
          taskSwitcherOpen && appState.taskSwitcherMode === mode;
        setTaskSwitcherOpen(!closesCurrentMode, mode);
        return;
      }

      if (editableTarget || blockingDialog) return;

      if (shortcut.id === 'newTask') {
        event.preventDefault();
        setMainView('workspace');
        startTemporarySession();
        requestAnimationFrame(() => focusBladeComposer());
        return;
      }

      if (shortcut.id === 'focusComposer') {
        if (focusBladeComposer()) event.preventDefault();
        return;
      }

      if (shortcut.id === 'toggleSidebar') {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setMainView, setTaskSwitcherOpen, startTemporarySession, toggleSidebar]);
}
