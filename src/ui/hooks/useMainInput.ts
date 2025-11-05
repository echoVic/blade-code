import { useMemoizedFn } from 'ahooks';
import { useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getFuzzyCommandSuggestions } from '../../slash-commands/index.js';
import type { CommandSuggestion } from '../../slash-commands/types.js';
import { FocusId, useFocusContext } from '../contexts/FocusContext.js';
import { useSession } from '../contexts/SessionContext.js';
import { applySuggestion, useAtCompletion } from './useAtCompletion.js';
import { useCtrlCHandler } from './useCtrlCHandler.js';

// 创建 UI Hook 专用 Logger
const logger = createLogger(LogCategory.UI);

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
  onTogglePermissionMode?: () => void,
  onToggleShortcuts?: () => void,
  isShortcutsModalOpen?: boolean
) => {
  // 使用 FocusContext 管理焦点
  const { state: focusState } = useFocusContext();
  const isFocused = focusState.currentFocus === FocusId.MAIN_INPUT;

  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const { state: sessionState, dispatch } = useSession();

  // @ 文件自动补全（使用真实光标位置）
  const atCompletion = useAtCompletion(input, sessionState.cursorPosition, {
    cwd: process.cwd(),
    maxSuggestions: 10,
  });

  // 使用智能 Ctrl+C 处理
  const handleCtrlC = useCtrlCHandler(isProcessing || false, onAbort);

  // Esc 双击检测：用于清空输入框
  const lastEscTimeRef = useRef<number>(0);
  const ESC_DOUBLE_CLICK_THRESHOLD = 500; // 500ms 内连续两次 Esc 视为双击

  // 防止重复取消
  const abortCalledRef = useRef<boolean>(false);

  // 当 isProcessing 变化时，重置 abortCalledRef
  useEffect(() => {
    if (isProcessing) {
      abortCalledRef.current = false;
    }
  }, [isProcessing]);

  // 更新建议列表（支持斜杠命令和 @ 文件提及）
  useEffect(() => {
    if (input.startsWith('/')) {
      // 斜杠命令建议
      const newSuggestions = getFuzzyCommandSuggestions(input);
      setSuggestions(newSuggestions);
      setShowSuggestions(newSuggestions.length > 0);
      setSelectedSuggestionIndex(0);
    } else if (atCompletion.hasQuery && atCompletion.suggestions.length > 0) {
      // @ 文件建议（转换为 CommandSuggestion 格式）
      const fileSuggestions: CommandSuggestion[] = atCompletion.suggestions.map(
        (file) => ({
          command: file,
          description: `File: ${file}`,
          matchScore: 1,
        })
      );
      setSuggestions(fileSuggestions);
      setShowSuggestions(true);
      setSelectedSuggestionIndex(0);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [input, atCompletion.hasQuery, atCompletion.suggestions]);

  // 处理清屏
  const handleClear = useMemoizedFn(() => {
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_ERROR', payload: null });
  });

  // 处理提交
  const handleSubmit = useMemoizedFn(() => {
    logger.debug('[DIAG] handleSubmit called:', { input, showSuggestions });

    // 直接使用用户输入的内容，不使用建议
    // 如果用户想使用建议，应该先按 Tab 键选择，然后再按 Enter 提交
    const commandToSubmit = input.trim();

    if (commandToSubmit) {
      logger.debug('[DIAG] Submitting command:', commandToSubmit);
      // 隐藏建议
      setShowSuggestions(false);
      setSuggestions([]);

      onAddToHistory(commandToSubmit);
      setInput('');
      onSubmit(commandToSubmit);
      logger.debug('[DIAG] Command submitted to onSubmit callback');
    } else {
      logger.debug('[DIAG] Empty command, not submitting');
    }
  });

  // 键盘输入监听 - 只处理全局快捷键和建议导航
  // CustomTextInput 处理基本编辑键 (backspace, delete, arrows, typing)
  // useMainInput 处理全局快捷键 (Ctrl+C/L, Esc) 和建议 (Tab, 上下箭头)
  useInput(
    (inputKey, key) => {
      // ? - 切换快捷键帮助（仅当输入框为空时）
      // 必须在 shouldSkip 之前检查，否则会被当作普通字符处理
      if (inputKey === '?' && !input) {
        onToggleShortcuts?.();
        // 防止 ? 被添加到输入框（通过延迟清空）
        setTimeout(() => setInput(''), 0);
        return;
      }

      // 跳过基本编辑键和普通字符输入，交给 CustomTextInput 处理
      // 但是 ? 键（当输入框为空时）要保留，用于切换快捷键帮助
      const shouldSkip =
        key.backspace || key.delete || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown ||
        // 跳过普通字符输入（没有任何修饰键，且不是特殊键）
        // 但是排除空输入框时的 ? 键
        ((!key.ctrl && !key.meta && !key.escape && !key.tab && !key.upArrow && !key.downArrow && !key.return) &&
         !(inputKey === '?' && !input));

      if (shouldSkip) {
        return;
      }

      // Ctrl+C / Ctrl+D - 停止任务或退出
      if ((key.ctrl && inputKey === 'c') || (key.meta && inputKey === 'c') ||
          (key.ctrl && inputKey === 'd') || (key.meta && inputKey === 'd')) {
        handleCtrlC();
        return;
      }
      // Ctrl+L - 清屏
      if ((key.ctrl && inputKey === 'l') || (key.meta && inputKey === 'l')) {
        handleClear();
        return;
      }
      // Esc - 关闭快捷键帮助 > 停止任务 > 隐藏建议 > 双击清空输入
      if (key.escape) {
        if (isShortcutsModalOpen) {
          // 如果快捷键帮助面板打开，先关闭它
          onToggleShortcuts?.();
        } else if (isProcessing && onAbort) {
          if (abortCalledRef.current) {
            return;
          }
          abortCalledRef.current = true;
          onAbort();
        } else if (showSuggestions) {
          setShowSuggestions(false);
          setSuggestions([]);
        } else if (input) {
          const now = Date.now();
          const timeSinceLastEsc = now - lastEscTimeRef.current;
          if (timeSinceLastEsc < ESC_DOUBLE_CLICK_THRESHOLD) {
            setInput('');
            lastEscTimeRef.current = 0;
          } else {
            lastEscTimeRef.current = now;
          }
        }
        return;
      }
      // Shift+Tab - 切换权限模式
      if (key.tab && key.shift) {
        onTogglePermissionMode?.();
        return;
      }
      // Tab - 选中建议
      if (key.tab && showSuggestions && suggestions.length > 0) {
        const selectedCommand = suggestions[selectedSuggestionIndex].command;
        if (atCompletion.hasQuery && atCompletion.suggestions.includes(selectedCommand)) {
          const { newInput, newCursorPos } = applySuggestion(input, atCompletion, selectedCommand);
          setInput(newInput);
          dispatch({ type: 'SET_CURSOR_POSITION', payload: newCursorPos });
        } else {
          const newInput = selectedCommand + ' ';
          setInput(newInput);
          dispatch({ type: 'SET_CURSOR_POSITION', payload: newInput.length });
        }
        setShowSuggestions(false);
        setSuggestions([]);
        return;
      }
      // Enter - 选中建议或提交命令
      if (key.return) {
        if (showSuggestions && suggestions.length > 0) {
          const selectedCommand = suggestions[selectedSuggestionIndex].command;
          if (atCompletion.hasQuery && atCompletion.suggestions.includes(selectedCommand)) {
            const { newInput, newCursorPos } = applySuggestion(input, atCompletion, selectedCommand);
            setInput(newInput);
            dispatch({ type: 'SET_CURSOR_POSITION', payload: newCursorPos });
          } else {
            const newInput = selectedCommand + ' ';
            setInput(newInput);
            dispatch({ type: 'SET_CURSOR_POSITION', payload: newInput.length });
          }
          setShowSuggestions(false);
          setSuggestions([]);
        } else {
          handleSubmit();
        }
        return;
      }
      // 上下箭头 - 建议导航或历史命令
      if (key.upArrow) {
        if (showSuggestions && suggestions.length > 0) {
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
        } else {
          const prevCommand = onPreviousCommand();
          if (prevCommand !== '') {
            setInput(prevCommand);
            dispatch({ type: 'SET_CURSOR_POSITION', payload: prevCommand.length });
          }
        }
        return;
      }
      if (key.downArrow) {
        if (showSuggestions && suggestions.length > 0) {
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
        } else {
          const nextCommand = onNextCommand();
          if (nextCommand !== '') {
            setInput(nextCommand);
            dispatch({ type: 'SET_CURSOR_POSITION', payload: nextCommand.length });
          }
        }
        return;
      }
    },
    { isActive: isFocused } // 当输入框聚焦时激活，但只处理上面列出的特定按键
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
