import { useCallback, useState } from 'react';

/**
 * 命令历史记录 Hook
 * 负责管理命令历史和导航
 */
export const useCommandHistory = () => {
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // 添加命令到历史记录
  const addToHistory = useCallback((command: string) => {
    setCommandHistory((prev) => [...prev, command]);
    setHistoryIndex(-1);
  }, []);

  // 获取上一个历史命令
  const getPreviousCommand = useCallback((): string => {
    if (commandHistory.length === 0) return '';

    const newIndex =
      historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);

    setHistoryIndex(newIndex);
    return commandHistory[newIndex] || '';
  }, [commandHistory, historyIndex]);

  // 获取下一个历史命令
  const getNextCommand = useCallback((): string => {
    if (historyIndex === -1) return '';

    const newIndex = historyIndex + 1;
    if (newIndex >= commandHistory.length) {
      setHistoryIndex(-1);
      return '';
    } else {
      setHistoryIndex(newIndex);
      return commandHistory[newIndex] || '';
    }
  }, [commandHistory, historyIndex]);

  // 重置历史索引
  const resetHistoryIndex = useCallback(() => {
    setHistoryIndex(-1);
  }, []);

  return {
    commandHistory,
    historyIndex,
    addToHistory,
    getPreviousCommand,
    getNextCommand,
    resetHistoryIndex,
  };
};
