export type ShortcutId =
  | 'searchTasks'
  | 'openCommands'
  | 'newTask'
  | 'focusComposer'
  | 'toggleSidebar';

export interface KeyboardShortcut {
  id: ShortcutId;
  key: string;
  primaryModifier: boolean;
  shiftKey?: boolean;
  scope: 'Global' | 'Chat' | 'Layout';
}

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    id: 'searchTasks',
    key: 'k',
    primaryModifier: true,
    scope: 'Global',
  },
  {
    id: 'openCommands',
    key: 'p',
    primaryModifier: true,
    shiftKey: true,
    scope: 'Global',
  },
  {
    id: 'newTask',
    key: 'n',
    primaryModifier: false,
    scope: 'Global',
  },
  {
    id: 'focusComposer',
    key: '/',
    primaryModifier: false,
    scope: 'Chat',
  },
  {
    id: 'toggleSidebar',
    key: 'b',
    primaryModifier: true,
    scope: 'Layout',
  },
] as const;

export interface ShortcutKeyboardEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function shortcutForEvent(
  event: ShortcutKeyboardEvent
): KeyboardShortcut | null {
  const key = event.key.toLocaleLowerCase();
  return (
    KEYBOARD_SHORTCUTS.find((shortcut) => {
      if (
        shortcut.key !== key ||
        event.altKey ||
        event.shiftKey !== Boolean(shortcut.shiftKey)
      ) {
        return false;
      }
      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      return shortcut.primaryModifier ? hasPrimaryModifier : !hasPrimaryModifier;
    }) ?? null
  );
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'
    )
  );
}

export function isMacPlatform(platform?: string): boolean {
  const browserNavigator =
    typeof navigator === 'undefined'
      ? null
      : (navigator as Navigator & {
          userAgentData?: { platform?: string };
        });
  const value =
    platform ??
    browserNavigator?.userAgentData?.platform ??
    browserNavigator?.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(value);
}

export function shortcutKeyLabels(
  shortcut: KeyboardShortcut,
  platform?: string
): string[] {
  const key = shortcut.key === '/' ? '/' : shortcut.key.toLocaleUpperCase();
  const mac = isMacPlatform(platform);
  return [
    ...(shortcut.primaryModifier ? [mac ? '⌘' : 'Ctrl'] : []),
    ...(shortcut.shiftKey ? [mac ? '⇧' : 'Shift'] : []),
    key,
  ];
}

export function shortcutHint(id: ShortcutId, platform?: string): string {
  const shortcut = KEYBOARD_SHORTCUTS.find((item) => item.id === id);
  return shortcut ? shortcutKeyLabels(shortcut, platform).join('') : '';
}
