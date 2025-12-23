import { useMemoizedFn } from 'ahooks';
import { useState } from 'react';
import type { PasteContent } from './useInputBuffer.js';

/**
 * 粘贴映射条目：标记 ID -> 内容（文本或图片）
 */
export type PasteMappings = Map<number, PasteContent>;

/**
 * 历史记录条目
 * 包含显示文本和粘贴映射
 */
export interface HistoryEntry {
  /** 显示文本（输入框中显示的内容，包含粘贴标记） */
  display: string;
  /** 粘贴映射：标记 ID -> 内容（用于回放时恢复映射） */
  pasteMappings: PasteMappings;
}

/**
 * 命令历史记录 Hook
 * 负责管理命令历史和导航
 * 支持粘贴标记的保存和恢复
 */
export const useCommandHistory = () => {
  const [commandHistory, setCommandHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // 添加命令到历史记录
  const addToHistory = useMemoizedFn(
    (display: string, pasteMappings?: PasteMappings) => {
      const entry: HistoryEntry = {
        display,
        pasteMappings: pasteMappings ? new Map(pasteMappings) : new Map(),
      };
      setCommandHistory((prev) => [...prev, entry]);
      setHistoryIndex(-1);
    }
  );

  // 获取上一个历史命令（返回完整条目）
  const getPreviousCommand = useMemoizedFn((): HistoryEntry | null => {
    if (commandHistory.length === 0) return null;

    const newIndex =
      historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);

    setHistoryIndex(newIndex);
    return commandHistory[newIndex] || null;
  });

  // 获取下一个历史命令（返回完整条目）
  const getNextCommand = useMemoizedFn((): HistoryEntry | null => {
    if (historyIndex === -1) return null;

    const newIndex = historyIndex + 1;
    if (newIndex >= commandHistory.length) {
      setHistoryIndex(-1);
      return null;
    } else {
      setHistoryIndex(newIndex);
      return commandHistory[newIndex] || null;
    }
  });

  // 重置历史索引
  const resetHistoryIndex = useMemoizedFn(() => {
    setHistoryIndex(-1);
  });

  return {
    commandHistory,
    historyIndex,
    addToHistory,
    getPreviousCommand,
    getNextCommand,
    resetHistoryIndex,
  };
};
