/**
 * 自定义 TextInput 组件
 * 基于 ink-text-input v6.0.0 并扩展功能
 *
 * 扩展功能：
 * - 程序化光标控制
 * - 文本粘贴检测
 * - 图片粘贴支持
 * - Ctrl 快捷键（Emacs 风格）
 * - Delete 正向删除
 */

import { useMemoizedFn } from 'ahooks';
import chalk from 'chalk';
import { type Key, Text, useInput } from 'ink';
import React, { useEffect, useRef } from 'react';
import { PASTE_CONFIG } from '../constants.js';
import {
  createTerminalInputParserState,
  parseTerminalInput,
} from '../input/terminalInput.js';
import {
  getImageFromClipboard,
  getTextFromClipboard,
  isImagePath,
  processImageFromPath,
} from '../utils/imagePaste.js';

const CRLF_REGEX = /\r\n/g;
const CR_REGEX = /\r/g;

function normalizeInputText(text: string): string {
  if (!text.includes('\r')) {
    return text;
  }
  return text.replace(CRLF_REGEX, '\n').replace(CR_REGEX, '\n');
}

/**
 * 禁用的按键类型（Key 对象的布尔属性）
 */
type DisabledKey = keyof {
  [K in keyof Key as Key[K] extends boolean ? K : never]: true;
};

/**
 * 组件属性
 */
export interface CustomTextInputProps {
  /** 输入值 */
  value: string;
  /** 值变化回调 */
  onChange: (value: string) => void;
  /** 光标位置（外部控制） */
  cursorPosition: number;
  /** 光标位置变化回调 */
  onChangeCursorPosition: (position: number) => void;
  /** 文本粘贴回调 - 返回 prompt 时替换粘贴内容 */
  onPaste?: (text: string) => Promise<{ prompt?: string }> | { prompt?: string } | void;
  /** 图片粘贴回调 */
  onImagePaste?: (
    base64: string,
    mediaType: string,
    filename?: string
  ) => Promise<{ prompt?: string }> | void;
  /** 占位符 */
  placeholder?: string;
  /** 是否聚焦 */
  focus?: boolean;
  /** 禁用的按键列表（这些按键将被跳过，由外部处理） */
  disabledKeys?: DisabledKey[];
}

/**
 * 在光标位置插入文本
 */
function insertTextAtCursor(
  text: string,
  originalValue: string,
  cursorPosition: number
): { newValue: string; newCursorPosition: number } {
  const safeOffset = Math.max(0, Math.min(cursorPosition, originalValue.length));
  const beforeCursor = originalValue.slice(0, safeOffset);
  const afterCursor = originalValue.slice(safeOffset);
  return {
    newValue: beforeCursor + text + afterCursor,
    newCursorPosition: safeOffset + text.length,
  };
}

/**
 * 自定义 TextInput 组件
 * 基于 ink-text-input 并扩展功能
 */
export function CustomTextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  onChange,
  cursorPosition,
  onChangeCursorPosition,
  onPaste,
  onImagePaste,
  disabledKeys = [],
}: CustomTextInputProps): React.JSX.Element {
  const terminalInputStateRef = useRef(createTerminalInputParserState());
  const latestValueRef = useRef(originalValue);
  const latestCursorRef = useRef(cursorPosition);
  const pendingInputMutationRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    latestValueRef.current = originalValue;
    latestCursorRef.current = cursorPosition;
  }, [originalValue, cursorPosition]);

  useEffect(() => {
    if (cursorPosition > originalValue.length) {
      onChangeCursorPosition(originalValue.length);
    }
  }, [originalValue, cursorPosition, onChangeCursorPosition]);

  const commitInputState = useMemoizedFn(
    (newValue: string, newCursorPosition: number) => {
      const previousValue = latestValueRef.current;
      const previousCursor = latestCursorRef.current;
      latestValueRef.current = newValue;
      latestCursorRef.current = newCursorPosition;
      if (newValue !== previousValue) onChange(newValue);
      if (newCursorPosition !== previousCursor) {
        onChangeCursorPosition(newCursorPosition);
      }
    }
  );

  const insertIntoLatest = useMemoizedFn((text: string) => {
    if (!text) return;
    const { newValue, newCursorPosition } = insertTextAtCursor(
      normalizeInputText(text),
      latestValueRef.current,
      latestCursorRef.current
    );
    commitInputState(newValue, newCursorPosition);
  });

  const handlePastedText = useMemoizedFn(async (rawText: string) => {
    const text = normalizeInputText(rawText);
    if (!text) return;

    if (onImagePaste && isImagePath(text)) {
      try {
        const imageResult = await processImageFromPath(text);
        if (imageResult) {
          const result = await onImagePaste(
            imageResult.base64,
            imageResult.mediaType,
            imageResult.filename
          );
          if (result?.prompt) insertIntoLatest(result.prompt);
          return;
        }
      } catch (error) {
        console.error('Failed to process image path:', error);
      }
    }

    const shouldProjectPaste =
      text.length > PASTE_CONFIG.LARGE_INPUT_THRESHOLD || text.includes('\n');
    if (shouldProjectPaste && onPaste) {
      const result = await onPaste(text);
      if (result?.prompt) {
        insertIntoLatest(result.prompt);
        return;
      }
    }

    insertIntoLatest(text);
  });

  const enqueueInputMutation = useMemoizedFn((mutation: () => void | Promise<void>) => {
    const previous = pendingInputMutationRef.current;
    if (!previous) {
      try {
        const result = mutation();
        if (!result) return;
        const pending = result.catch(() => undefined);
        pendingInputMutationRef.current = pending;
        void pending.finally(() => {
          if (pendingInputMutationRef.current === pending) {
            pendingInputMutationRef.current = null;
          }
        });
      } catch {
        // Input projection failures must not terminate the TUI.
      }
      return;
    }

    const pending = previous
      .then(mutation)
      .then(() => undefined)
      .catch(() => undefined);
    pendingInputMutationRef.current = pending;
    void pending.finally(() => {
      if (pendingInputMutationRef.current === pending) {
        pendingInputMutationRef.current = null;
      }
    });
  });

  /**
   * 键盘输入处理
   * 基于 ink-text-input 并扩展功能
   */
  useInput(
    (rawInput, key) => {
      enqueueInputMutation(() => {
        const input = normalizeInputText(rawInput);
        const parsedInput = parseTerminalInput(terminalInputStateRef.current, input);
        terminalInputStateRef.current = parsedInput.state;
        if (parsedInput.handled) {
          return (async () => {
            for (const segment of parsedInput.segments) {
              if (segment.kind === 'paste') {
                await handlePastedText(segment.text);
              } else {
                insertIntoLatest(segment.text);
              }
            }
          })();
        }

        // 检查是否是被禁用的按键
        const isDisabledKey = disabledKeys.some((disabledKey) => key[disabledKey]);

        // 跳过被禁用的按键和需要外部处理的按键
        // - Ctrl+C: 中断/退出
        // - Shift+Tab: 切换权限模式
        // - 空输入时的 ? 键: 切换快捷键帮助
        // - Ctrl+L/T/O: 清屏/切换 thinking/切换历史折叠（由 useMainInput 处理）
        if (
          isDisabledKey ||
          (key.ctrl && rawInput === 'c') ||
          (key.ctrl && rawInput === 'l') ||
          (key.ctrl && rawInput === 't') ||
          (key.ctrl && rawInput === 'o') ||
          (key.meta && rawInput === 'l') ||
          (key.meta && rawInput === 't') ||
          (key.meta && rawInput === 'o') ||
          (key.shift && key.tab) ||
          (input === '?' && latestValueRef.current === '')
        ) {
          return;
        }

        const currentValue = latestValueRef.current;
        const currentCursor = latestCursorRef.current;
        let nextCursorPosition = currentCursor;
        let nextValue = currentValue;

        // === ink-text-input 原有的左右箭头处理 ===
        if (key.leftArrow) {
          nextCursorPosition--;
        } else if (key.rightArrow) {
          nextCursorPosition++;
        }
        // === 扩展：Backspace/Delete 处理 ===
        else if (key.backspace || key.delete) {
          // WORKAROUND: 某些键盘/终端配置下，Backspace 键会被识别为 delete
          // 通过 rawInput 为空来判断是 Backspace（向后删除）还是真正的 Delete（向前删除）
          const isBackspace = rawInput === '';

          if (isBackspace) {
            // Backspace：删除光标前面的字符
            if (currentCursor > 0) {
              nextValue =
                currentValue.slice(0, currentCursor - 1) +
                currentValue.slice(currentCursor, currentValue.length);
              nextCursorPosition--;
            }
          } else {
            // Delete：删除光标位置的字符（向前删除）
            if (currentCursor < currentValue.length) {
              nextValue =
                currentValue.slice(0, currentCursor) +
                currentValue.slice(currentCursor + 1, currentValue.length);
              // 光标位置不变
            }
          }
        }
        // === 扩展：Ctrl+A - 移到开头 ===
        else if (key.ctrl && input === 'a') {
          nextCursorPosition = 0;
        }
        // === 扩展：Ctrl+E - 移到末尾 ===
        else if (key.ctrl && input === 'e') {
          nextCursorPosition = currentValue.length;
        }
        // === 扩展：Ctrl+K - 删除到行尾 ===
        else if (key.ctrl && input === 'k') {
          nextValue = currentValue.slice(0, currentCursor);
        }
        // === 扩展：Ctrl+U - 删除到行首 ===
        else if (key.ctrl && input === 'u') {
          nextValue = currentValue.slice(currentCursor);
          nextCursorPosition = 0;
        }
        // === 扩展：Ctrl+W - 删除前一个单词 ===
        else if (key.ctrl && input === 'w') {
          const beforeCursor = currentValue.slice(0, currentCursor);
          const match = beforeCursor.match(/\s*\S+\s*$/);
          if (match) {
            const deleteCount = match[0].length;
            nextValue =
              currentValue.slice(0, currentCursor - deleteCount) +
              currentValue.slice(currentCursor);
            nextCursorPosition -= deleteCount;
          }
        }
        // === 扩展：Ctrl+V - 从剪贴板粘贴 ===
        // macOS: Ctrl+V 仅粘贴图片（文本用 Cmd+V，通过终端 bracketed paste 处理）
        // Linux/Windows: Ctrl+V 优先图片，其次文本
        else if (key.ctrl && input === 'v') {
          const isMac = process.platform === 'darwin';

          return (async () => {
            // 1. 尝试读取图片
            if (onImagePaste) {
              const imageResult = await getImageFromClipboard();
              if (imageResult) {
                const result = await onImagePaste(
                  imageResult.base64,
                  imageResult.mediaType,
                  'clipboard.png'
                );
                if (result?.prompt) insertIntoLatest(result.prompt);
                return;
              }
            }

            // 2. macOS 下 Ctrl+V 不处理文本（用户应使用 Cmd+V）
            if (isMac) {
              return;
            }

            // 3. Linux/Windows: 没有图片时读取文本
            const textResult = await getTextFromClipboard();
            if (textResult) await handlePastedText(textResult);
          })();
        }
        // === 扩展：Home 键 ===
        else if (key.pageUp) {
          nextCursorPosition = 0;
        }
        // === 扩展：End 键 ===
        else if (key.pageDown) {
          nextCursorPosition = currentValue.length;
        }
        // === 扩展：Shift+Enter（多行输入） ===
        else if (input === '\n' && (key.shift || key.meta)) {
          const { newValue, newCursorPosition } = insertTextAtCursor(
            input,
            currentValue,
            currentCursor
          );
          commitInputState(newValue, newCursorPosition);
          return;
        }
        // Multi-character chunks are either terminal paste/IME commits or batched stdin.
        else if (!key.ctrl && !key.meta) {
          if (
            onPaste &&
            (input.length > PASTE_CONFIG.LARGE_INPUT_THRESHOLD || input.includes('\n'))
          ) {
            return handlePastedText(input);
          }

          nextValue =
            currentValue.slice(0, currentCursor) +
            input +
            currentValue.slice(currentCursor, currentValue.length);
          nextCursorPosition += input.length;
        }

        // === ink-text-input 原有的边界检查 ===
        if (nextCursorPosition < 0) {
          nextCursorPosition = 0;
        }
        if (nextCursorPosition > nextValue.length) {
          nextCursorPosition = nextValue.length;
        }

        commitInputState(nextValue, nextCursorPosition);
      });
    },
    { isActive: focus }
  );

  // === ink-text-input 原有的渲染逻辑 ===
  const showCursor = focus;
  let renderedValue = originalValue;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // Fake cursor rendering
  if (showCursor) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');

    // 空输入时显示光标
    if (originalValue.length === 0) {
      renderedValue = chalk.inverse(' ');
    } else {
      // 有内容时，逐字符渲染
      renderedValue = '';

      // 渲染所有字符，光标在中间时反转对应字符
      for (let i = 0; i < originalValue.length; i++) {
        if (i === cursorPosition && cursorPosition < originalValue.length) {
          // 光标在字符位置时（非末尾），反转该字符
          renderedValue += chalk.inverse(originalValue[i]);
        } else {
          renderedValue += originalValue[i];
        }
      }

      // 光标在末尾时，追加反转的空格
      if (cursorPosition >= originalValue.length) {
        renderedValue += chalk.inverse(' ');
      }
    }
  }

  return (
    <Text>
      {placeholder
        ? originalValue.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
