// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  isEditableShortcutTarget,
  KEYBOARD_SHORTCUTS,
  shortcutForEvent,
  shortcutHint,
  shortcutKeyLabels,
} from '@/lib/keyboardShortcuts';

function keyboard(
  key: string,
  overrides: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {}
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('keyboard shortcuts', () => {
  it('matches primary-modifier and unmodified shortcuts', () => {
    expect(shortcutForEvent(keyboard('K', { metaKey: true }))?.id).toBe('searchTasks');
    expect(shortcutForEvent(keyboard('P', { metaKey: true, shiftKey: true }))?.id).toBe(
      'openCommands'
    );
    expect(shortcutForEvent(keyboard('b', { ctrlKey: true }))?.id).toBe(
      'toggleSidebar'
    );
    expect(shortcutForEvent(keyboard('n'))?.id).toBe('newTask');
    expect(shortcutForEvent(keyboard('/'))?.id).toBe('focusComposer');
  });

  it('rejects missing or additional modifiers', () => {
    expect(shortcutForEvent(keyboard('k'))).toBeNull();
    expect(shortcutForEvent(keyboard('n', { metaKey: true }))).toBeNull();
    expect(
      shortcutForEvent(keyboard('b', { ctrlKey: true, shiftKey: true }))
    ).toBeNull();
  });

  it('formats platform-specific hints from the same definitions', () => {
    const search = KEYBOARD_SHORTCUTS.find(
      (shortcut) => shortcut.id === 'searchTasks'
    )!;
    expect(shortcutKeyLabels(search, 'MacIntel')).toEqual(['⌘', 'K']);
    expect(shortcutKeyLabels(search, 'Win32')).toEqual(['Ctrl', 'K']);
    const commands = KEYBOARD_SHORTCUTS.find(
      (shortcut) => shortcut.id === 'openCommands'
    )!;
    expect(shortcutKeyLabels(commands, 'MacIntel')).toEqual(['⌘', '⇧', 'P']);
    expect(shortcutKeyLabels(commands, 'Win32')).toEqual(['Ctrl', 'Shift', 'P']);
    expect(shortcutHint('newTask', 'MacIntel')).toBe('N');
  });

  it('detects nested editable targets without blocking ordinary controls', () => {
    const input = document.createElement('input');
    const child = document.createElement('span');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.appendChild(child);

    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(child)).toBe(true);
    expect(isEditableShortcutTarget(document.createElement('button'))).toBe(false);
  });
});
