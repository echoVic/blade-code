import { useApp, useInput } from 'ink';
import { useCallback, useState } from 'react';
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
  const { exit } = useApp();
  const { dispatch } = useSession();

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
    if (input.trim()) {
      const command = input.trim();
      onAddToHistory(command);
      setInput('');
      onSubmit(command);
    }
  }, [input, onSubmit, onAddToHistory]);

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
    } else if (key.upArrow) {
      // 上箭头 - 历史命令
      const prevCommand = onPreviousCommand();
      if (prevCommand !== '') {
        setInput(prevCommand);
      }
    } else if (key.downArrow) {
      // 下箭头 - 历史命令
      const nextCommand = onNextCommand();
      setInput(nextCommand);
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
  };
};
