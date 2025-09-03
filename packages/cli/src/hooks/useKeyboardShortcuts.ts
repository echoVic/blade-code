import { useInput } from 'ink';
import { useCallback, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  description: string;
  category?: 'navigation' | 'tools' | 'editing' | 'system';
  action: () => void;
  condition?: () => boolean;
}

export interface ShortcutGroup {
  category: string;
  shortcuts: KeyboardShortcut[];
}

export type ShortcutMap = Map<string, KeyboardShortcut>;

// 生成快捷键的唯一键
const generateShortcutKey = (
  shortcut: Omit<KeyboardShortcut, 'description' | 'action'>
): string => {
  const modifiers = [
    shortcut.ctrl ? 'Ctrl' : '',
    shortcut.alt ? 'Alt' : '',
    shortcut.shift ? 'Shift' : '',
    shortcut.meta ? 'Meta' : '',
  ]
    .filter(Boolean)
    .join('+');

  return modifiers ? `${modifiers}+${shortcut.key}` : shortcut.key;
};

// 格式化快捷键显示
export const formatShortcut = (shortcut: KeyboardShortcut): string => {
  const modifiers = [
    shortcut.ctrl ? 'Ctrl' : '',
    shortcut.alt ? 'Alt' : '',
    shortcut.shift ? 'Shift' : '',
    shortcut.meta ? 'Cmd' : '', // 显示为Cmd而不是Meta
  ].filter(Boolean);

  if (modifiers.length === 0) {
    return shortcut.key;
  }

  return `${modifiers.join('+')}+${shortcut.key}`;
};

// 解析快捷键字符串
export const parseShortcutString = (str: string): Omit<KeyboardShortcut, 'action'> => {
  const parts = str.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  return {
    key: key.toUpperCase(),
    ctrl: modifiers.includes('Ctrl'),
    alt: modifiers.includes('Alt'),
    shift: modifiers.includes('Shift'),
    meta: modifiers.includes('Meta') || modifiers.includes('Cmd'),
    description: '',
  };
};

// 快捷键Hook
export const useKeyboardShortcuts = (shortcuts: KeyboardShortcut[] = []) => {
  const shortcutMapRef = useRef<ShortcutMap>(new Map());

  // 构建快捷键映射
  shortcutMapRef.current = new Map(
    shortcuts.map(shortcut => [generateShortcutKey(shortcut), shortcut])
  );

  const handleInput = useCallback(
    (
      input: string,
      key: {
        left: boolean;
        right: boolean;
        up: boolean;
        down: boolean;
        pageup: boolean;
        pagedown: boolean;
        return: boolean;
        escape: boolean;
        tab: boolean;
        backspace: boolean;
        delete: boolean;
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
        meta: boolean;
      }
    ) => {
      // 如果输入是可打印字符，不是快捷键
      if (input.length === 1 && !key.ctrl && !key.alt && !key.meta && !key.shift) {
        return;
      }

      // 构建当前按键的快捷键
      const pressedKey =
        input.toUpperCase() ||
        (key.escape ? 'Escape' : '') ||
        (key.return ? 'Return' : '') ||
        (key.tab ? 'Tab' : '') ||
        (key.backspace ? 'Backspace' : '') ||
        (key.delete ? 'Delete' : '');

      if (!pressedKey) return;

      const shortcutKey = generateShortcutKey({
        key: pressedKey,
        ctrl: key.ctrl,
        alt: key.alt,
        shift: key.shift,
        meta: key.meta,
      });

      const shortcut = shortcutMapRef.current.get(shortcutKey);
      if (shortcut) {
        // 检查条件
        if (shortcut.condition && !shortcut.condition()) {
          return;
        }

        // 执行快捷键动作
        shortcut.action();
        return;
      }

      // 方向键处理
      if (key.up || key.down || key.left || key.right) {
        const direction = key.up ? 'Up' : key.down ? 'Down' : key.left ? 'Left' : 'Right';
        const directionShortcut = shortcutMapRef.current.get(direction);
        if (directionShortcut) {
          directionShortcut.action();
        }
      }
    },
    []
  );

  useInput(handleInput);

  // 添加快捷键
  const addShortcut = useCallback((shortcut: KeyboardShortcut) => {
    const key = generateShortcutKey(shortcut);
    shortcutMapRef.current.set(key, shortcut);
  }, []);

  // 移除快捷键
  const removeShortcut = useCallback(
    (shortcut: Omit<KeyboardShortcut, 'description' | 'action'>) => {
      const key = generateShortcutKey(shortcut);
      shortcutMapRef.current.delete(key);
    },
    []
  );

  // 清除所有快捷键
  const clearShortcuts = useCallback(() => {
    shortcutMapRef.current.clear();
  }, []);

  // 获取所有快捷键
  const getAllShortcuts = useCallback(() => {
    return Array.from(shortcutMapRef.current.values());
  }, []);

  // 按类别分组获取快捷键
  const getShortcutsByCategory = useCallback((): ShortcutGroup[] => {
    const shortsuts = Array.from(shortcutMapRef.current.values());
    const grouped = shortsuts.reduce(
      (acc, shortcut) => {
        const category = shortcut.category || 'other';
        if (!acc[category]) {
          acc[category] = [];
        }
        acc[category].push(shortcut);
        return acc;
      },
      {} as Record<string, KeyboardShortcut[]>
    );

    return Object.entries(grouped).map(([category, shortcuts]) => ({
      category,
      shortcuts: shortcuts.sort((a, b) => a.description.localeCompare(b.description)),
    }));
  }, []);

  return {
    addShortcut,
    removeShortcut,
    clearShortcuts,
    getAllShortcuts,
    getShortcutsByCategory,
  };
};

// 全局快捷键管理器Hook
export const useShortcutManager = () => {
  const { addShortcut, removeShortcut, getAllShortcuts, clearShortcuts } = useKeyboardShortcuts();

  // 注册一组快捷键
  const registerShortcuts = useCallback(
    (shortcuts: KeyboardShortcut[]) => {
      shortcuts.forEach(addShortcut);
    },
    [addShortcut]
  );

  // 注销一组快捷键
  const unregisterShortcuts = useCallback(
    (shortcuts: Omit<KeyboardShortcut, 'description' | 'action'>[]) => {
      shortcuts.forEach(removeShortcut);
    },
    [removeShortcut]
  );

  // 检查快捷键冲突
  const checkConflict = useCallback(
    (newShortcut: Omit<KeyboardShortcut, 'description' | 'action'>) => {
      const key = generateShortcutKey(newShortcut);
      const existingShortcuts = getAllShortcuts();
      return existingShortcuts.find(shortcut => generateShortcutKey(shortcut) === key);
    },
    [getAllShortcuts]
  );

  // 验证快捷键格式
  const validateShortcut = useCallback((shortcut: KeyboardShortcut): boolean => {
    if (!shortcut.key || shortcut.key.length === 0) {
      return false;
    }

    // 检查是否是有效的按键
    const validKeys = /^[A-Z0-9\s\-[\];',\\/\.`]$/i;
    if (!validKeys.test(shortcut.key)) {
      return false;
    }

    // 检查是否至少有一个修饰键（除了单功能键）
    const isFunctionKey = [
      'Escape',
      'Tab',
      'Return',
      'Backspace',
      'Delete',
      'Up',
      'Down',
      'Left',
      'Right',
    ].includes(shortcut.key);
    if (!isFunctionKey && !shortcut.ctrl && !shortcut.alt && !shortcut.meta && !shortcut.shift) {
      return false;
    }

    return true;
  }, []);

  return {
    registerShortcuts,
    unregisterShortcuts,
    addShortcut,
    removeShortcut,
    clearShortcuts,
    checkConflict,
    validateShortcut,
    getAllShortcuts,
  };
};

// 快捷键帮助Hook
export const useShortcutHelp = () => {
  const { getShortcutsByCategory } = useKeyboardShortcuts();

  const showShortcutHelp = useCallback(() => {
    const groups = getShortcutsByCategory();

    console.log('\n🎹 快捷键帮助:\n');

    groups.forEach(group => {
      console.log(`\n📂 ${group.category}:`);
      group.shortcuts.forEach(shortcut => {
        const formattedShortcut = formatShortcut(shortcut);
        console.log(`  ${formattedShortcut.padEnd(20)} - ${shortcut.description}`);
      });
    });

    console.log('\n💡 提示: 按下快捷键即可执行对应功能\n');
  }, [getShortcutsByCategory]);

  return { showShortcutHelp };
};
