import { useMemoizedFn } from 'ahooks';
import { useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getFuzzyCommandSuggestions } from '../../slash-commands/index.js';
import type { CommandSuggestion } from '../../slash-commands/types.js';
import {
  useAppActions,
  useCurrentFocus,
  useCurrentModel,
  useSessionActions,
} from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { isThinkingModel } from '../../utils/modelDetection.js';
import { applySuggestion, useAtCompletion } from './useAtCompletion.js';
import type { HistoryEntry, PasteMappings } from './useCommandHistory.js';
import { useCtrlCHandler } from './useCtrlCHandler.js';
import type { InputBuffer, ResolvedInput } from './useInputBuffer.js';

// 创建 UI Hook 专用 Logger
const logger = createLogger(LogCategory.UI);

/**
 * 主输入框处理 Hook
 * 负责主界面输入框的键盘事件、命令建议和历史记录
 */
export const useMainInput = (
  buffer: InputBuffer,
  onSubmit: (resolved: ResolvedInput) => void,
  onPreviousCommand: () => HistoryEntry | null,
  onNextCommand: () => HistoryEntry | null,
  onAddToHistory: (display: string, pasteMappings?: PasteMappings) => void,
  onAbort?: () => void,
  isProcessing?: boolean,
  onTogglePermissionMode?: () => void,
  onToggleShortcuts?: () => void,
  isShortcutsModalOpen?: boolean
) => {
  // 使用 Zustand store 管理焦点
  const currentFocus = useCurrentFocus();
  const isFocused = currentFocus === FocusId.MAIN_INPUT;

  // 从 buffer 读取输入值和光标位置
  const input = buffer.value;
  const setInput = buffer.setValue;
  const cursorPosition = buffer.cursorPosition;

  // 使用 Zustand store 的 session actions
  const sessionActions = useSessionActions();

  // 使用 Zustand store 的 app actions (for thinking mode toggle)
  const appActions = useAppActions();

  // 获取当前模型配置（用于检测是否支持 thinking）
  const currentModel = useCurrentModel();
  const supportsThinking = currentModel ? isThinkingModel(currentModel) : false;

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

  // @ 文件自动补全（使用真实光标位置）
  const atCompletion = useAtCompletion(input, cursorPosition, {
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
      // 斜杠命令建议：只在输入不包含空格时显示（空格表示已有子命令）
      const hasSubcommand = input.includes(' ');
      if (hasSubcommand) {
        // 已有子命令，不显示建议
        setShowSuggestions(false);
        setSuggestions([]);
      } else {
        const newSuggestions = getFuzzyCommandSuggestions(input);
        setSuggestions(newSuggestions);
        setShowSuggestions(newSuggestions.length > 0);
        setSelectedSuggestionIndex(0);
      }
    } else if (atCompletion.hasQuery && atCompletion.suggestions.length > 0) {
      // @ 文件/目录建议（转换为 CommandSuggestion 格式）
      const fileSuggestions: CommandSuggestion[] = atCompletion.suggestions.map(
        (path) => ({
          command: path,
          description: path.endsWith('/') ? `Directory: ${path}` : `File: ${path}`,
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
    sessionActions.clearMessages();
    sessionActions.setError(null);
  });

  // 处理提交
  const handleSubmit = useMemoizedFn(() => {
    logger.debug('[DIAG] handleSubmit called:', { input, showSuggestions });

    // 直接使用用户输入的内容，不使用建议
    // 如果用户想使用建议，应该先按 Tab 键选择，然后再按 Enter 提交
    const displayText = input.trim();

    if (displayText) {
      // 将显示的摘要替换回原始粘贴内容，并分离文本和图片
      const resolved = buffer.resolveInput(displayText);

      logger.debug('[DIAG] Submitting command:', {
        displayText,
        textLength: resolved.text.length,
        imageCount: resolved.images.length,
      });

      // 隐藏建议
      setShowSuggestions(false);
      setSuggestions([]);

      // 保存当前的粘贴映射到历史记录（在 clear 之前）
      const currentMappings: PasteMappings =
        buffer.pasteMap.size > 0 ? new Map(buffer.pasteMap) : new Map();

      // 历史记录保存显示文本和粘贴映射
      // 回放时恢复映射，提交时通过 resolveInput 展开
      onAddToHistory(displayText, currentMappings);
      buffer.clear(); // 使用 buffer.clear() 清空输入（同时清除粘贴映射）
      onSubmit(resolved); // 发送解析后的内容（文本 + 图片）
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
        setTimeout(() => buffer.clear(), 0);
        return;
      }

      // 跳过基本编辑键和普通字符输入，交给 CustomTextInput 处理
      // 但是 ? 键（当输入框为空时）要保留，用于切换快捷键帮助
      const shouldSkip =
        key.backspace ||
        key.delete ||
        key.leftArrow ||
        key.rightArrow ||
        key.pageUp ||
        key.pageDown ||
        // 跳过普通字符输入（没有任何修饰键，且不是特殊键）
        // 但是排除空输入框时的 ? 键
        (!key.ctrl &&
          !key.meta &&
          !key.escape &&
          !key.tab &&
          !key.upArrow &&
          !key.downArrow &&
          !key.return &&
          !(inputKey === '?' && !input));

      if (shouldSkip) {
        return;
      }

      // Ctrl+C / Ctrl+D - 停止任务或退出
      if (
        (key.ctrl && inputKey === 'c') ||
        (key.meta && inputKey === 'c') ||
        (key.ctrl && inputKey === 'd') ||
        (key.meta && inputKey === 'd')
      ) {
        handleCtrlC();
        return;
      }
      // Ctrl+L - 清屏
      if ((key.ctrl && inputKey === 'l') || (key.meta && inputKey === 'l')) {
        handleClear();
        return;
      }
      // Ctrl+T - 切换 thinking 内容展开/折叠
      if ((key.ctrl && inputKey === 't') || (key.meta && inputKey === 't')) {
        sessionActions.toggleThinkingExpanded();
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
            buffer.clear();
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
      // Tab - 选中建议（有建议时），或切换 thinking 模式（无建议时，且模型支持）
      if (key.tab) {
        if (showSuggestions && suggestions.length > 0) {
          // 有建议时：选中建议
          const selectedCommand = suggestions[selectedSuggestionIndex].command;
          if (
            atCompletion.hasQuery &&
            atCompletion.suggestions.includes(selectedCommand)
          ) {
            const { newInput, newCursorPos } = applySuggestion(
              input,
              atCompletion,
              selectedCommand
            );
            setInput(newInput);
            buffer.setCursorPosition(newCursorPos);
          } else {
            const newInput = selectedCommand + ' ';
            setInput(newInput);
            buffer.setCursorPosition(newInput.length);
          }
          setShowSuggestions(false);
          setSuggestions([]);
        } else if (supportsThinking) {
          // 无建议时：仅当模型支持 thinking 时才切换 thinking 模式
          appActions.toggleThinkingMode();
        }
        // 如果模型不支持 thinking，Tab 键无效果（静默忽略）
        return;
      }
      // Enter - 选中建议或提交命令
      if (key.return) {
        if (showSuggestions && suggestions.length > 0) {
          const selectedCommand = suggestions[selectedSuggestionIndex].command;
          if (
            atCompletion.hasQuery &&
            atCompletion.suggestions.includes(selectedCommand)
          ) {
            const { newInput, newCursorPos } = applySuggestion(
              input,
              atCompletion,
              selectedCommand
            );
            setInput(newInput);
            buffer.setCursorPosition(newCursorPos);
          } else {
            const newInput = selectedCommand + ' ';
            setInput(newInput);
            buffer.setCursorPosition(newInput.length);
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
          const entry = onPreviousCommand();
          if (entry) {
            // 恢复粘贴映射（在设置输入之前，避免触发清理逻辑）
            if (entry.pasteMappings.size > 0) {
              buffer.restorePasteMappings(entry.pasteMappings);
            }
            // 显示历史文本
            setInput(entry.display);
            buffer.setCursorPosition(entry.display.length);
          }
        }
        return;
      }
      if (key.downArrow) {
        if (showSuggestions && suggestions.length > 0) {
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
        } else {
          const entry = onNextCommand();
          if (entry) {
            // 恢复粘贴映射（在设置输入之前，避免触发清理逻辑）
            if (entry.pasteMappings.size > 0) {
              buffer.restorePasteMappings(entry.pasteMappings);
            }
            // 显示历史文本
            setInput(entry.display);
            buffer.setCursorPosition(entry.display.length);
          }
        }
        return;
      }
    },
    { isActive: isFocused } // 当输入框聚焦时激活，但只处理上面列出的特定按键
  );

  return {
    handleSubmit,
    showSuggestions,
    suggestions,
    selectedSuggestionIndex,
  };
};
