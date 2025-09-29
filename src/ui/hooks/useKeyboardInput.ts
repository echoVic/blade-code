import { useApp, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { getFuzzyCommandSuggestions } from '../../slash-commands/index.js';
import type { CommandSuggestion } from '../../slash-commands/types.js';
import { useSession } from '../contexts/SessionContext.js';

/**
 * 键盘输入处理 Hook
 * 负责键盘事件监听和输入管理
 */
export const useKeyboardInput = (
  onSubmit: (input: string) => void,
  onPreviousCommand: () => string,
  onNextCommand: () => string,
  onAddToHistory: (command: string) => void
) => {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const { exit } = useApp();
  const { dispatch } = useSession();

  // 更新建议列表
  useEffect(() => {
    if (input.startsWith('/')) {
      const newSuggestions = getFuzzyCommandSuggestions(input);
      setSuggestions(newSuggestions);
      setShowSuggestions(newSuggestions.length > 0);
      setSelectedSuggestionIndex(0);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [input]);

  // 处理清屏
  const handleClear = useCallback(() => {
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_ERROR', payload: null });
  }, [dispatch]);

  // 处理退出
  const handleExit = useCallback(() => {
    exit();
  }, [exit]);

  // 处理提交
  const handleSubmit = useCallback(() => {
    let commandToSubmit = input.trim();

    // 如果显示建议并且有选中项，使用选中的命令
    if (showSuggestions && suggestions.length > 0 && selectedSuggestionIndex >= 0) {
      commandToSubmit = suggestions[selectedSuggestionIndex].command;
    }

    if (commandToSubmit) {
      // 隐藏建议
      setShowSuggestions(false);
      setSuggestions([]);

      onAddToHistory(commandToSubmit);
      setInput('');
      onSubmit(commandToSubmit);
    }
  }, [input, onSubmit, onAddToHistory, showSuggestions, suggestions, selectedSuggestionIndex]);

  // 键盘输入监听
  useInput((inputKey, key) => {
    if (key.return) {
      // 回车键提交命令
      handleSubmit();
    } else if ((key.ctrl && inputKey === 'c') || (key.meta && inputKey === 'c')) {
      // Ctrl+C 退出
      handleExit();
    } else if ((key.ctrl && inputKey === 'd') || (key.meta && inputKey === 'd')) {
      // Ctrl+D 退出
      handleExit();
    } else if ((key.ctrl && inputKey === 'l') || (key.meta && inputKey === 'l')) {
      // Ctrl+L 清屏
      handleClear();
    } else if (inputKey === '\u001B') {
      // Esc 键 - 退出建议模式或返回
      if (showSuggestions) {
        setShowSuggestions(false);
        setSuggestions([]);
      } else {
        handleExit();
      }
    } else if (key.tab && showSuggestions && suggestions.length > 0) {
      // Tab 键 - 自动补全
      const selectedCommand = suggestions[selectedSuggestionIndex].command;
      setInput(selectedCommand);
      setShowSuggestions(false);
      setSuggestions([]);
    } else if (key.upArrow) {
      if (showSuggestions && suggestions.length > 0) {
        // 在建议列表中向上导航
        const maxIndex = suggestions.length - 1;

        setSelectedSuggestionIndex((prev) =>
          prev > 0 ? prev - 1 : maxIndex
        );
      } else {
        // 上箭头 - 历史命令
        const prevCommand = onPreviousCommand();
        if (prevCommand !== '') {
          setInput(prevCommand);
        }
      }
    } else if (key.downArrow) {
      if (showSuggestions && suggestions.length > 0) {
        // 在建议列表中向下导航
        const maxIndex = suggestions.length - 1;

        setSelectedSuggestionIndex((prev) =>
          prev < maxIndex ? prev + 1 : 0
        );
      } else {
        // 下箭头 - 历史命令
        const nextCommand = onNextCommand();
        setInput(nextCommand);
      }
    } else if (key.backspace || key.delete) {
      // 退格键删除字符
      setInput((prev) => prev.slice(0, -1));
    } else if (inputKey && inputKey !== '\u001b') {
      // 普通字符输入（排除 Escape 键）
      setInput((prev) => prev + inputKey);
    }
  });

  return {
    input,
    setInput,
    showSuggestions,
    suggestions,
    selectedSuggestionIndex,
  };
};
