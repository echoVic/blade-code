import { useMemoizedFn } from 'ahooks';
import chalk from 'chalk';
import { type Key, Text, useInput, useStdin } from 'ink';
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
  if (!text.includes('\r')) return text;
  return text.replace(CRLF_REGEX, '\n').replace(CR_REGEX, '\n');
}

type DisabledKey = keyof {
  [K in keyof Key as Key[K] extends boolean ? K : never]: true;
};

export interface CustomTextInputProps {
  value: string;
  onChange: (value: string) => void;
  cursorPosition: number;
  onChangeCursorPosition: (position: number) => void;
  onPaste?: (text: string) => Promise<{ prompt?: string }> | { prompt?: string } | void;
  onImagePaste?: (
    base64: string,
    mediaType: string,
    filename?: string,
  ) => Promise<{ prompt?: string }> | void;
  placeholder?: string;
  focus?: boolean;
  disabledKeys?: DisabledKey[];
}

function insertTextAtCursor(
  text: string,
  value: string,
  cursor: number,
): { newValue: string; newCursorPosition: number } {
  const safe = Math.max(0, Math.min(cursor, value.length));
  return {
    newValue: value.slice(0, safe) + text + value.slice(safe),
    newCursorPosition: safe + text.length,
  };
}

interface PasteState {
  chunks: string[];
  timeoutId: NodeJS.Timeout | null;
  firstInputTime: number | null;
  lastInputTime: number | null;
  totalLength: number;
}

const EMPTY_PASTE: PasteState = {
  chunks: [],
  timeoutId: null,
  firstInputTime: null,
  lastInputTime: null,
  totalLength: 0,
};

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
  const pasteStateRef = useRef<PasteState>({ ...EMPTY_PASTE });
  const latestValueRef = useRef(originalValue);
  const latestCursorRef = useRef(cursorPosition);

  useEffect(() => {
    latestValueRef.current = originalValue;
    latestCursorRef.current = cursorPosition;
  }, [originalValue, cursorPosition]);

  useEffect(() => {
    return () => {
      if (pasteStateRef.current.timeoutId) clearTimeout(pasteStateRef.current.timeoutId);
    };
  }, []);

  useEffect(() => {
    if (cursorPosition > originalValue.length) onChangeCursorPosition(originalValue.length);
  }, [originalValue, cursorPosition, onChangeCursorPosition]);

  const applyInsert = useMemoizedFn((text: string, val?: string, cur?: number) => {
    const v = val ?? latestValueRef.current;
    const c = cur ?? latestCursorRef.current;
    const { newValue, newCursorPosition } = insertTextAtCursor(normalizeInputText(text), v, c);
    onChange(newValue);
    onChangeCursorPosition(newCursorPosition);
  });

  const tryImagePath = useMemoizedFn(async (text: string): Promise<boolean> => {
    if (!onImagePaste || !isImagePath(text)) return false;
    try {
      const r = await processImageFromPath(text);
      if (!r) return false;
      const result = await onImagePaste(r.base64, r.mediaType, r.filename);
      if (result?.prompt) applyInsert(result.prompt);
      return true;
    } catch {
      return false;
    }
  });

  const tryPasteCallback = useMemoizedFn(async (text: string): Promise<boolean> => {
    if (!onPaste) return false;
    const result = await onPaste(text);
    if (result?.prompt) {
      applyInsert(result.prompt);
      return true;
    }
    return false;
  });

  const processPendingChunks = useMemoizedFn(() => {
    if (pasteStateRef.current.timeoutId) clearTimeout(pasteStateRef.current.timeoutId);

    pasteStateRef.current.timeoutId = setTimeout(async () => {
      const { chunks, totalLength } = pasteStateRef.current;
      if (chunks.length === 0) return;
      const merged = normalizeInputText(chunks.join(''));
      const chunkCount = chunks.length;
      pasteStateRef.current = { ...EMPTY_PASTE };

      if (await tryImagePath(merged)) return;

      const isPaste =
        totalLength > PASTE_CONFIG.LARGE_INPUT_THRESHOLD ||
        merged.includes('\n') ||
        (totalLength > PASTE_CONFIG.MEDIUM_SIZE_MULTI_CHUNK_THRESHOLD && chunkCount > 3);

      if (isPaste && (await tryPasteCallback(merged))) return;
      applyInsert(merged);
    }, PASTE_CONFIG.TIMEOUT_MS);
  });

  const handleCtrlV = useMemoizedFn(async () => {
    const isMac = process.platform === 'darwin';
    if (onImagePaste) {
      const img = await getImageFromClipboard();
      if (img) {
        const result = await onImagePaste(img.base64, img.mediaType, 'clipboard.png');
        if (result?.prompt) applyInsert(result.prompt);
        return;
      }
    }
    if (isMac) return;
    const text = await getTextFromClipboard();
    if (!text) return;
    const sanitized = normalizeInputText(text);
    const isLarge = sanitized.includes('\n') || sanitized.length > PASTE_CONFIG.LARGE_INPUT_THRESHOLD;
    if (isLarge && (await tryPasteCallback(sanitized))) return;
    applyInsert(sanitized);
  });

  const { isRawModeSupported } = useStdin();

  useInput(
    (rawInput, key) => {
      const input = normalizeInputText(rawInput);
      if (
        disabledKeys.some((k) => key[k]) ||
        (key.ctrl && rawInput === 'c') ||
        (key.ctrl && rawInput === 'l') ||
        (key.ctrl && rawInput === 't') ||
        (key.ctrl && rawInput === 'o') ||
        (key.meta && rawInput === 'l') ||
        (key.meta && rawInput === 't') ||
        (key.meta && rawInput === 'o') ||
        (key.shift && key.tab) ||
        (input === '?' && originalValue === '')
      ) return;

      const currentState = pasteStateRef.current;
      let nextCursor = cursorPosition;
      let nextValue = originalValue;

      if (key.leftArrow) {
        nextCursor--;
      } else if (key.rightArrow) {
        nextCursor++;
      } else if (key.backspace || key.delete) {
        if (rawInput === '') {
          if (cursorPosition > 0) {
            nextValue = originalValue.slice(0, cursorPosition - 1) + originalValue.slice(cursorPosition);
            nextCursor--;
          }
        } else if (cursorPosition < originalValue.length) {
          nextValue = originalValue.slice(0, cursorPosition) + originalValue.slice(cursorPosition + 1);
        }
      } else if (key.ctrl && input === 'a') {
        nextCursor = 0;
      } else if (key.ctrl && input === 'e') {
        nextCursor = originalValue.length;
      } else if (key.ctrl && input === 'k') {
        nextValue = originalValue.slice(0, cursorPosition);
      } else if (key.ctrl && input === 'u') {
        nextValue = originalValue.slice(cursorPosition);
        nextCursor = 0;
      } else if (key.ctrl && input === 'w') {
        const match = originalValue.slice(0, cursorPosition).match(/\s*\S+\s*$/);
        if (match) {
          nextValue = originalValue.slice(0, cursorPosition - match[0].length) + originalValue.slice(cursorPosition);
          nextCursor -= match[0].length;
        }
      } else if (key.ctrl && input === 'v') {
        handleCtrlV().catch(() => { /* clipboard read failed */ });
        return;
      } else if (key.pageUp) {
        nextCursor = 0;
      } else if (key.pageDown) {
        nextCursor = originalValue.length;
      } else if (input === '\n' && (key.shift || key.meta)) {
        applyInsert(input, originalValue, cursorPosition);
        return;
      } else if (!key.ctrl && !key.meta) {
        if (!currentState.firstInputTime) currentState.firstInputTime = Date.now();
        currentState.lastInputTime = Date.now();
        const elapsed = Date.now() - (currentState.firstInputTime || Date.now());

        const isPasteCandidate =
          onPaste &&
          (input.length > PASTE_CONFIG.LARGE_INPUT_THRESHOLD ||
            (input.includes('\n') && input.length > 1) ||
            (elapsed < PASTE_CONFIG.RAPID_INPUT_THRESHOLD_MS && currentState.chunks.length > 0) ||
            (elapsed < PASTE_CONFIG.RAPID_INPUT_THRESHOLD_MS && input.length > 10) ||
            currentState.timeoutId !== null);

        if (isPasteCandidate) {
          currentState.chunks.push(input);
          currentState.totalLength += input.length;
          processPendingChunks();
          return;
        }

        if (input.length === 1 && !currentState.timeoutId) {
          currentState.chunks = [];
          currentState.firstInputTime = null;
          currentState.lastInputTime = null;
          currentState.totalLength = 0;
        }

        nextValue = originalValue.slice(0, cursorPosition) + input + originalValue.slice(cursorPosition);
        nextCursor += input.length;
      }

      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));
      if (nextValue !== originalValue) onChange(nextValue);
      if (nextCursor !== cursorPosition) onChangeCursorPosition(nextCursor);
    },
    { isActive: focus && isRawModeSupported },
  );

  const showCursor = focus;
  let renderedValue = originalValue;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');

    if (originalValue.length === 0) {
      renderedValue = chalk.inverse(' ');
    } else {
      renderedValue = '';
      for (let i = 0; i < originalValue.length; i++) {
        renderedValue +=
          i === cursorPosition && cursorPosition < originalValue.length
            ? chalk.inverse(originalValue[i])
            : originalValue[i];
      }
      if (cursorPosition >= originalValue.length) renderedValue += chalk.inverse(' ');
    }
  }

  return (
    <Text>
      {placeholder
        ? originalValue.length > 0 ? renderedValue : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
