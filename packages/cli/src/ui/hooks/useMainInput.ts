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
import { endsWithSeparator } from '../../utils/pathHelpers.js';
import { applySuggestion, useAtCompletion } from './useAtCompletion.js';
import type { HistoryEntry, PasteMappings } from './useCommandHistory.js';
import { useCtrlCHandler } from './useCtrlCHandler.js';
import type { InputBuffer, ResolvedInput } from './useInputBuffer.js';
import { useKeyboardMachine } from './useKeyboardMachine.js';
import { useSuggestions } from './useSuggestions.js';

const logger = createLogger(LogCategory.UI);

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
  isShortcutsModalOpen?: boolean,
) => {
  const currentFocus = useCurrentFocus();
  const isFocused = currentFocus === FocusId.MAIN_INPUT;

  const input = buffer.value;
  const setInput = buffer.setValue;
  const cursorPosition = buffer.cursorPosition;

  const sessionActions = useSessionActions();
  const appActions = useAppActions();
  const currentModel = useCurrentModel();
  const supportsThinking = currentModel ? isThinkingModel(currentModel) : false;

  const _keyboard = useKeyboardMachine();
  const _suggestionState = useSuggestions();

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

  const atCompletion = useAtCompletion(input, cursorPosition, {
    cwd: process.cwd(),
    maxSuggestions: 10,
  });

  const handleCtrlC = useCtrlCHandler(isProcessing || false, onAbort);

  const lastEscTimeRef = useRef<number>(0);
  const ESC_DOUBLE_CLICK_THRESHOLD = 500;
  const abortCalledRef = useRef<boolean>(false);

  useEffect(() => {
    if (isProcessing) abortCalledRef.current = false;
  }, [isProcessing]);

  useEffect(() => {
    if (atCompletion.hasQuery && atCompletion.suggestions.length > 0) {
      const fileSuggestions: CommandSuggestion[] = atCompletion.suggestions.map(
        (path) => ({
          command: path,
          description: endsWithSeparator(path) ? `Directory: ${path}` : `File: ${path}`,
          matchScore: 1,
        }),
      );
      setSuggestions(fileSuggestions);
      setShowSuggestions(true);
      setSelectedSuggestionIndex(0);
    } else if (input.startsWith('/')) {
      const hasSubcommand = input.includes(' ');
      if (hasSubcommand) {
        setShowSuggestions(false);
        setSuggestions([]);
      } else {
        const newSuggestions = getFuzzyCommandSuggestions(input);
        setSuggestions(newSuggestions);
        setShowSuggestions(newSuggestions.length > 0);
        setSelectedSuggestionIndex(0);
      }
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [input, atCompletion.hasQuery, atCompletion.suggestions]);

  const handleClear = useMemoizedFn(() => {
    sessionActions.clearMessages();
    sessionActions.setError(null);
  });

  const applySuggestionToInput = useMemoizedFn((selectedCommand: string) => {
    if (atCompletion.hasQuery && atCompletion.suggestions.includes(selectedCommand)) {
      const { newInput, newCursorPos } = applySuggestion(input, atCompletion, selectedCommand);
      setInput(newInput);
      buffer.setCursorPosition(newCursorPos);
    } else {
      const newInput = selectedCommand + ' ';
      setInput(newInput);
      buffer.setCursorPosition(newInput.length);
    }
    setShowSuggestions(false);
    setSuggestions([]);
  });

  const handleSubmit = useMemoizedFn(() => {
    logger.debug('[DIAG] handleSubmit called:', { input, showSuggestions });
    const displayText = input.trim();

    if (displayText) {
      const resolved = buffer.resolveInput(displayText);
      logger.debug('[DIAG] Submitting command:', {
        displayText,
        textLength: resolved.text.length,
        imageCount: resolved.images.length,
      });

      setShowSuggestions(false);
      setSuggestions([]);

      const currentMappings: PasteMappings =
        buffer.pasteMap.size > 0 ? new Map(buffer.pasteMap) : new Map();

      onAddToHistory(displayText, currentMappings);
      buffer.clear();
      onSubmit(resolved);
      logger.debug('[DIAG] Command submitted to onSubmit callback');
    } else {
      logger.debug('[DIAG] Empty command, not submitting');
    }
  });

  const restoreHistoryEntry = useMemoizedFn((entry: HistoryEntry | null) => {
    if (!entry) return;
    if (entry.pasteMappings.size > 0) buffer.restorePasteMappings(entry.pasteMappings);
    setInput(entry.display);
    buffer.setCursorPosition(entry.display.length);
  });

  useInput(
    (inputKey, key) => {
      if (inputKey === '?' && !input) {
        onToggleShortcuts?.();
        setTimeout(() => buffer.clear(), 0);
        return;
      }

      const shouldSkip =
        key.backspace || key.delete || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown ||
        (!key.ctrl && !key.meta && !key.escape && !key.tab &&
          !key.upArrow && !key.downArrow && !key.return &&
          !(inputKey === '?' && !input));

      if (shouldSkip) return;

      const ctrlOrMeta = key.ctrl || key.meta;
      if (ctrlOrMeta && (inputKey === 'c' || inputKey === 'd')) { handleCtrlC(); return; }
      if (ctrlOrMeta && inputKey === 'l') { handleClear(); return; }
      if (ctrlOrMeta && inputKey === 't') { sessionActions.toggleThinkingExpanded(); return; }
      if (ctrlOrMeta && inputKey === 'o') { sessionActions.toggleHistoryExpanded(); return; }

      if (key.escape) {
        if (isShortcutsModalOpen) {
          onToggleShortcuts?.();
        } else if (isProcessing && onAbort) {
          if (abortCalledRef.current) return;
          abortCalledRef.current = true;
          onAbort();
        } else if (showSuggestions) {
          setShowSuggestions(false);
          setSuggestions([]);
        } else if (input) {
          const now = Date.now();
          if (now - lastEscTimeRef.current < ESC_DOUBLE_CLICK_THRESHOLD) {
            buffer.clear();
            lastEscTimeRef.current = 0;
          } else {
            lastEscTimeRef.current = now;
          }
        }
        return;
      }

      if (key.tab && key.shift) {
        onTogglePermissionMode?.();
        return;
      }

      if (key.tab) {
        if (showSuggestions && suggestions.length > 0) {
          applySuggestionToInput(suggestions[selectedSuggestionIndex].command);
        } else if (supportsThinking) {
          appActions.toggleThinkingMode();
        }
        return;
      }

      if (key.return) {
        if (showSuggestions && suggestions.length > 0) {
          applySuggestionToInput(suggestions[selectedSuggestionIndex].command);
        } else {
          handleSubmit();
        }
        return;
      }

      if (key.upArrow) {
        if (showSuggestions && suggestions.length > 0) {
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : maxIndex));
        } else {
          restoreHistoryEntry(onPreviousCommand());
        }
        return;
      }

      if (key.downArrow) {
        if (showSuggestions && suggestions.length > 0) {
          const maxIndex = suggestions.length - 1;
          setSelectedSuggestionIndex((prev) => (prev < maxIndex ? prev + 1 : 0));
        } else {
          restoreHistoryEntry(onNextCommand());
        }
        return;
      }
    },
    { isActive: isFocused },
  );

  return {
    handleSubmit,
    showSuggestions,
    suggestions,
    selectedSuggestionIndex,
  };
};
