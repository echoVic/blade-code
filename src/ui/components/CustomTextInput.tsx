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
export type DisabledKey = keyof {
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
 * 粘贴检测状态
 */
interface PasteState {
  chunks: string[];
  timeoutId: NodeJS.Timeout | null;
  firstInputTime: number | null;
  lastInputTime: number | null;
  totalLength: number;
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
  // 粘贴检测状态
  const pasteStateRef = useRef<PasteState>({
    chunks: [],
    timeoutId: null,
    firstInputTime: null,
    lastInputTime: null,
    totalLength: 0,
  });

  // 存储最新的值和光标位置（用于异步回调中避免闭包陷阱）
  const latestValueRef = useRef(originalValue);
  const latestCursorRef = useRef(cursorPosition);

  // 同步更新 ref
  useEffect(() => {
    latestValueRef.current = originalValue;
    latestCursorRef.current = cursorPosition;
  }, [originalValue, cursorPosition]);

  // 清理超时
  useEffect(() => {
    return () => {
      if (pasteStateRef.current.timeoutId) {
        clearTimeout(pasteStateRef.current.timeoutId);
      }
    };
  }, []);

  // 同步光标位置（当 value 长度变化时）
  useEffect(() => {
    if (cursorPosition > originalValue.length) {
      onChangeCursorPosition(originalValue.length);
    }
  }, [originalValue, cursorPosition, onChangeCursorPosition]);

  /**
   * 处理待处理的粘贴 chunks
   */
  const processPendingChunks = useMemoizedFn(() => {
    const currentState = pasteStateRef.current;
    if (currentState.timeoutId) {
      clearTimeout(currentState.timeoutId);
    }

    const timeoutId = setTimeout(async () => {
      const chunks = pasteStateRef.current.chunks;
      const totalLength = pasteStateRef.current.totalLength;

      if (chunks.length === 0) return;

      const mergedInput = normalizeInputText(chunks.join(''));

      // 重置状态
      pasteStateRef.current = {
        chunks: [],
        timeoutId: null,
        firstInputTime: null,
        lastInputTime: null,
        totalLength: 0,
      };

      // 使用 ref 获取最新值（避免闭包陷阱）
      const currentValue = latestValueRef.current;
      const currentCursor = latestCursorRef.current;

      // 1. 检测是否为图片路径
      if (onImagePaste && isImagePath(mergedInput)) {
        try {
          const imageResult = await processImageFromPath(mergedInput);
          if (imageResult) {
            const result = await onImagePaste(
              imageResult.base64,
              imageResult.mediaType,
              imageResult.filename
            );
            if (result?.prompt) {
              const sanitizedPrompt = normalizeInputText(result.prompt);
              const { newValue, newCursorPosition } = insertTextAtCursor(
                sanitizedPrompt,
                currentValue,
                currentCursor
              );
              onChange(newValue);
              onChangeCursorPosition(newCursorPosition);
            }
            return;
          }
        } catch (error) {
          console.error('Failed to process image path:', error);
        }
      }

      // 2. 判断是否应该触发 onPaste
      const hasMultipleLines = mergedInput.includes('\n');
      const isMediumSizeMultiChunk =
        totalLength > PASTE_CONFIG.MEDIUM_SIZE_MULTI_CHUNK_THRESHOLD &&
        chunks.length > 3;
      const isPastePattern =
        totalLength > PASTE_CONFIG.LARGE_INPUT_THRESHOLD ||
        hasMultipleLines ||
        isMediumSizeMultiChunk;

      if (isPastePattern && onPaste) {
        const result = await onPaste(mergedInput);
        if (result?.prompt) {
          const sanitizedPrompt = normalizeInputText(result.prompt);
          const { newValue, newCursorPosition } = insertTextAtCursor(
            sanitizedPrompt,
            currentValue,
            currentCursor
          );
          onChange(newValue);
          onChangeCursorPosition(newCursorPosition);
          return;
        }
      }

      // 3. 直接插入文本
      const { newValue, newCursorPosition } = insertTextAtCursor(
        mergedInput,
        currentValue,
        currentCursor
      );
      onChange(newValue);
      onChangeCursorPosition(newCursorPosition);
    }, PASTE_CONFIG.TIMEOUT_MS);

    pasteStateRef.current.timeoutId = timeoutId;
  });

  /**
   * 键盘输入处理
   * 基于 ink-text-input 并扩展功能
   */
  useInput(
    (rawInput, key) => {
      const input = normalizeInputText(rawInput);

      // 检查是否是被禁用的按键
      const isDisabledKey = disabledKeys.some((disabledKey) => key[disabledKey]);

      // 跳过被禁用的按键和 Ctrl+C（由外部处理）
      // 空输入时的 ? 键也跳过（用于切换快捷键帮助）
      if (
        isDisabledKey ||
        (key.ctrl && rawInput === 'c') ||
        (key.shift && key.tab) ||
        (input === '?' && originalValue === '')
      ) {
        return;
      }

      const currentTime = Date.now();
      const currentState = pasteStateRef.current;
      let nextCursorPosition = cursorPosition;
      let nextValue = originalValue;

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
          if (cursorPosition > 0) {
            nextValue =
              originalValue.slice(0, cursorPosition - 1) +
              originalValue.slice(cursorPosition, originalValue.length);
            nextCursorPosition--;
          }
        } else {
          // Delete：删除光标位置的字符（向前删除）
          if (cursorPosition < originalValue.length) {
            nextValue =
              originalValue.slice(0, cursorPosition) +
              originalValue.slice(cursorPosition + 1, originalValue.length);
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
        nextCursorPosition = originalValue.length;
      }
      // === 扩展：Ctrl+K - 删除到行尾 ===
      else if (key.ctrl && input === 'k') {
        nextValue = originalValue.slice(0, cursorPosition);
      }
      // === 扩展：Ctrl+U - 删除到行首 ===
      else if (key.ctrl && input === 'u') {
        nextValue = originalValue.slice(cursorPosition);
        nextCursorPosition = 0;
      }
      // === 扩展：Ctrl+W - 删除前一个单词 ===
      else if (key.ctrl && input === 'w') {
        const beforeCursor = originalValue.slice(0, cursorPosition);
        const match = beforeCursor.match(/\s*\S+\s*$/);
        if (match) {
          const deleteCount = match[0].length;
          nextValue =
            originalValue.slice(0, cursorPosition - deleteCount) +
            originalValue.slice(cursorPosition);
          nextCursorPosition -= deleteCount;
        }
      }
      // === 扩展：Ctrl+V - 从剪贴板粘贴 ===
      // macOS: Ctrl+V 仅粘贴图片（文本用 Cmd+V，通过终端 bracketed paste 处理）
      // Linux/Windows: Ctrl+V 优先图片，其次文本
      else if (key.ctrl && input === 'v') {
        const isMac = process.platform === 'darwin';

        (async () => {
          // 1. 尝试读取图片
          if (onImagePaste) {
            const imageResult = await getImageFromClipboard();
            if (imageResult) {
              const result = await onImagePaste(
                imageResult.base64,
                imageResult.mediaType,
                'clipboard.png'
              );
              if (result?.prompt) {
                const sanitizedPrompt = normalizeInputText(result.prompt);
                const { newValue, newCursorPosition } = insertTextAtCursor(
                  sanitizedPrompt,
                  latestValueRef.current,
                  latestCursorRef.current
                );
                onChange(newValue);
                onChangeCursorPosition(newCursorPosition);
              }
              return;
            }
          }

          // 2. macOS 下 Ctrl+V 不处理文本（用户应使用 Cmd+V）
          if (isMac) {
            return;
          }

          // 3. Linux/Windows: 没有图片时读取文本
          const textResult = await getTextFromClipboard();
          if (textResult) {
            const sanitizedText = normalizeInputText(textResult);

            // 大段文本走 onPaste 流程（摘要/标记）
            const hasMultipleLines = sanitizedText.includes('\n');
            const isLargeText = sanitizedText.length > PASTE_CONFIG.LARGE_INPUT_THRESHOLD;

            if ((hasMultipleLines || isLargeText) && onPaste) {
              const result = await onPaste(sanitizedText);
              if (result?.prompt) {
                const sanitizedPrompt = normalizeInputText(result.prompt);
                const { newValue, newCursorPosition } = insertTextAtCursor(
                  sanitizedPrompt,
                  latestValueRef.current,
                  latestCursorRef.current
                );
                onChange(newValue);
                onChangeCursorPosition(newCursorPosition);
                return;
              }
            }

            // 小段文本直接插入
            const { newValue, newCursorPosition } = insertTextAtCursor(
              sanitizedText,
              latestValueRef.current,
              latestCursorRef.current
            );
            onChange(newValue);
            onChangeCursorPosition(newCursorPosition);
          }
        })().catch(() => {
          // 读取剪贴板失败，静默处理
        });
        return;
      }
      // === 扩展：Home 键 ===
      else if (key.pageUp) {
        nextCursorPosition = 0;
      }
      // === 扩展：End 键 ===
      else if (key.pageDown) {
        nextCursorPosition = originalValue.length;
      }
      // === 扩展：Shift+Enter（多行输入） ===
      else if (input === '\n' && (key.shift || key.meta)) {
        const { newValue, newCursorPosition } = insertTextAtCursor(
          input,
          originalValue,
          cursorPosition
        );
        onChange(newValue);
        onChangeCursorPosition(newCursorPosition);
        return;
      }
      // === 扩展：粘贴检测逻辑 ===
      else if (!key.ctrl && !key.meta) {
        // 初始化时间
        if (!currentState.firstInputTime) {
          currentState.firstInputTime = currentTime;
        }
        currentState.lastInputTime = currentTime;

        const timeSinceFirst =
          currentTime - (currentState.firstInputTime || currentTime);

        // 粘贴检测条件
        const isLargeInput = input.length > PASTE_CONFIG.LARGE_INPUT_THRESHOLD;
        const hasMultipleNewlines = input.includes('\n') && input.length > 1;
        const isRapidSequence =
          timeSinceFirst < PASTE_CONFIG.RAPID_INPUT_THRESHOLD_MS &&
          currentState.chunks.length > 0;
        const isNewRapidInput =
          timeSinceFirst < PASTE_CONFIG.RAPID_INPUT_THRESHOLD_MS && input.length > 10;
        const isAlreadyCollecting = currentState.timeoutId !== null;

        const isPasteCandidate =
          onPaste &&
          (isLargeInput ||
            hasMultipleNewlines ||
            isRapidSequence ||
            isNewRapidInput ||
            isAlreadyCollecting);

        if (isPasteCandidate) {
          // 添加到 chunks 进行合并
          currentState.chunks.push(input);
          currentState.totalLength += input.length;
          processPendingChunks();
          return;
        }

        // 重置单字符输入状态
        if (input.length === 1 && !currentState.timeoutId) {
          currentState.chunks = [];
          currentState.firstInputTime = null;
          currentState.lastInputTime = null;
          currentState.totalLength = 0;
        }

        // === ink-text-input 原有的普通输入处理 ===
        nextValue =
          originalValue.slice(0, cursorPosition) +
          input +
          originalValue.slice(cursorPosition, originalValue.length);
        nextCursorPosition += input.length;
      }

      // === ink-text-input 原有的边界检查 ===
      if (nextCursorPosition < 0) {
        nextCursorPosition = 0;
      }
      if (nextCursorPosition > nextValue.length) {
        nextCursorPosition = nextValue.length;
      }

      // 更新状态（先更新值，再更新光标位置，避免闪烁）
      if (nextValue !== originalValue) {
        onChange(nextValue);
      }
      if (nextCursorPosition !== cursorPosition) {
        onChangeCursorPosition(nextCursorPosition);
      }
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
