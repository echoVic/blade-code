import { useMemoizedFn } from 'ahooks';
import { useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { getFuzzyCommandSuggestions } from '../../slash-commands/index.js';
import type { CommandSuggestion } from '../../slash-commands/types.js';
import { FocusId, useFocusContext } from '../contexts/FocusContext.js';
import { useSession } from '../contexts/SessionContext.js';
import { useCtrlCHandler } from './useCtrlCHandler.js';

/**
 * 主输入框处理 Hook
 * 负责主界面输入框的键盘事件、命令建议和历史记录
 */
export const useMainInput = (
  onSubmit: (input: string) => void,
  onPreviousCommand: () => string,
  onNextCommand: () => string,
  onAddToHistory: (command: string) => void,
  onAbort?: () => void,
  isProcessing?: boolean,
  onTogglePermissionMode?: () => void
) => {
  // 使用 FocusContext 管理焦点
  const { state: focusState } = useFocusContext();
  const isFocused = focusState.currentFocus === FocusId.MAIN_INPUT;

  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const { dispatch } = useSession();

  // 使用智能 Ctrl+C 处理
  const handleCtrlC = useCtrlCHandler(isProcessing || false, onAbort);

  // Esc 双击检测：用于清空输入框
  const lastEscTimeRef = useRef<number>(0);
  const ESC_DOUBLE_CLICK_THRESHOLD = 500; // 500ms 内连续两次 Esc 视为双击

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
  const handleClear = useMemoizedFn(() => {
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_ERROR', payload: null });
  });

  // 处理提交
  const handleSubmit = useMemoizedFn(() => {
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
  });

  // 键盘输入监听 - 只处理特殊快捷键，让 TextInput 处理基本编辑
  // 使用 isActive 配合 isFocused，只有在聚焦时才响应输入
  useInput(
    (inputKey, key) => {
      // Ctrl+C - 智能处理（有任务时双击，无任务时单击）
      if ((key.ctrl && inputKey === 'c') || (key.meta && inputKey === 'c')) {
        handleCtrlC();
      }
      // Ctrl+D - 智能退出
      else if ((key.ctrl && inputKey === 'd') || (key.meta && inputKey === 'd')) {
        handleCtrlC();
      }
      // Ctrl+L 清屏
      else if ((key.ctrl && inputKey === 'l') || (key.meta && inputKey === 'l')) {
        handleClear();
      }
      // Ctrl+U 清空输入（Unix 标准）
      else if ((key.ctrl && inputKey === 'u') || (key.meta && inputKey === 'u')) {
        setInput('');
      }
      // Esc 键 - 停止任务 > 退出建议模式 > 双击清空输入
      else if (key.escape) {
        if (isProcessing && onAbort) {
          // 第一优先级：如果正在处理任务，触发停止
          onAbort();
        } else if (showSuggestions) {
          // 第二优先级：如果显示建议，隐藏建议
          setShowSuggestions(false);
          setSuggestions([]);
        } else if (input) {
          // 第三优先级：如果有输入内容，检测双击清空
          const now = Date.now();
          const timeSinceLastEsc = now - lastEscTimeRef.current;

          if (timeSinceLastEsc < ESC_DOUBLE_CLICK_THRESHOLD) {
            // 双击 Esc：清空输入
            setInput('');
            lastEscTimeRef.current = 0; // 重置计时器
          } else {
            // 单击 Esc：记录时间，等待第二次按下
            lastEscTimeRef.current = now;
          }
        }
      }
      // Shift+Tab 切换权限模式
      else if (key.tab && key.shift) {
        onTogglePermissionMode?.();
      }
      // Tab 键 - 自动补全
      else if (key.tab && showSuggestions && suggestions.length > 0) {
        const selectedCommand = suggestions[selectedSuggestionIndex].command;
        setInput(selectedCommand);
        setShowSuggestions(false);
        setSuggestions([]);
      }
      // 上箭头 - 在建议中导航或历史命令
      else if (key.upArrow) {
        if (showSuggestions && suggestions.length > 0) {
          // 在建议列表中向上导航
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
        } else {
          // 上箭头 - 历史命令
          const prevCommand = onPreviousCommand();
          if (prevCommand !== '') {
            setInput(prevCommand);
          }
        }
      }
      // 下箭头 - 在建议中导航或历史命令
      else if (key.downArrow) {
        if (showSuggestions && suggestions.length > 0) {
          // 在建议列表中向下导航
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
        } else {
          // 下箭头 - 历史命令
          const nextCommand = onNextCommand();
          setInput(nextCommand);
        }
      }
    },
    { isActive: isFocused }
  );

  return {
    input,
    setInput,
    handleSubmit,
    showSuggestions,
    suggestions,
    selectedSuggestionIndex,
  };
};
