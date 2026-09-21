import { useEffect, useMemo, useRef, useState } from 'react';
import { fileNameIndex } from '../../services/FileNameIndex.js';
import { getCwd } from '../../utils/cwd.js';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
} from '../../utils/filePatterns.js';

export function clearAtCompletionCache(): void {
  fileNameIndex.invalidate();
}

export interface AtMatchResult {
  hasQuery: boolean;
  query: string;
  startIndex: number;
  endIndex: number;
  quoted: boolean;
}

export interface AtCompletionResult extends AtMatchResult {
  suggestions: string[];
  selectedIndex: number;
  loading: boolean;
}

export interface UseAtCompletionOptions {
  cwd?: string;
  maxSuggestions?: number;
  ignorePatterns?: string[];
  debounceDelay?: number;
  fuzzyMatch?: boolean;
  /** 禁止任何文件系统扫描。 */
  disabled?: boolean;
  /** 在实际执行扫描前再次确认请求仍被允许。 */
  canRequest?: () => boolean;
}

function extractAtMention(input: string, cursorPosition: number): AtMatchResult {
  // 正则：匹配 @"quoted" 或 @bareword
  // @ 之前必须是行首(^)或空格(\s),避免误匹配邮箱等
  const atMatches = [...input.matchAll(/(?:^|\s)(@(?:"[^"]*"|(?:[^\\ ]|\\ )*))/g)];
  for (const match of atMatches) {
    const fullMatch = match[1]; // @"..." 或 @...
    const matchStart = match.index! + (match[0].length - fullMatch.length);
    const matchEnd = matchStart + fullMatch.length;
    if (cursorPosition >= matchStart && cursorPosition <= matchEnd) {
      let query = fullMatch.slice(1); // 移除 @
      let quoted = false;
      if (query.startsWith('"')) {
        quoted = true;
        query = query.slice(1); // 移除开头的 "
        if (query.endsWith('"')) {
          query = query.slice(0, -1); // 移除结尾的 "
        }
      }

      return {
        hasQuery: true,
        query,
        startIndex: matchStart,
        endIndex: matchEnd,
        quoted,
      };
    }
  }

  return {
    hasQuery: false,
    query: '',
    startIndex: -1,
    endIndex: -1,
    quoted: false,
  };
}

// 默认忽略模式（复用 filePatterns.ts 中的配置）
const DEFAULT_IGNORE_PATTERNS = [
  ...DEFAULT_EXCLUDE_DIRS.map((dir) => `${dir}/**`),
  ...DEFAULT_EXCLUDE_DIRS,
  ...DEFAULT_EXCLUDE_FILE_PATTERNS.map((pattern) => `**/${pattern}`),
];
export function useAtCompletion(
  input: string,
  cursorPosition: number | undefined,
  options: UseAtCompletionOptions = {}
): AtCompletionResult {
  const {
    cwd = getCwd(),
    maxSuggestions = 15,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    debounceDelay = 300,
    fuzzyMatch = true,
    disabled = false,
    canRequest,
  } = options;
  const canRequestRef = useRef(canRequest);
  const loadedIndexKeyRef = useRef<string | null>(null);
  canRequestRef.current = canRequest;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ignorePatternsKey = useMemo(
    () => JSON.stringify(ignorePatterns),
    [ignorePatterns]
  );
  const shouldLoadFiles = !disabled && input.includes('@');
  const atMatch = useMemo(() => {
    if (cursorPosition === undefined) {
      return {
        hasQuery: false,
        query: '',
        startIndex: -1,
        endIndex: -1,
        quoted: false,
      };
    }
    return extractAtMention(input, cursorPosition);
  }, [input, cursorPosition]);
  const indexKey = `${cwd}\0${ignorePatternsKey}`;

  useEffect(() => {
    if (!shouldLoadFiles || !atMatch.hasQuery) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const searchFiles = async () => {
      if (disabled || canRequestRef.current?.() === false) {
        setSuggestions([]);
        setLoading(false);
        return;
      }
      if (loadedIndexKeyRef.current !== indexKey) setLoading(true);
      try {
        const matches = await fileNameIndex.search(atMatch.query, {
          cwd,
          limit: maxSuggestions,
          includeDirectories: true,
          ignorePatterns,
          fuzzy: fuzzyMatch,
          signal: controller.signal,
        });
        if (!cancelled) {
          setSuggestions(matches.map((match) => match.path));
          loadedIndexKeyRef.current = indexKey;
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          console.error('Failed to search files for @ completion:', error);
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    const timer =
      loadedIndexKeyRef.current === indexKey
        ? undefined
        : setTimeout(searchFiles, debounceDelay);
    if (timer === undefined) void searchFiles();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    atMatch.hasQuery,
    atMatch.query,
    cwd,
    debounceDelay,
    disabled,
    fuzzyMatch,
    ignorePatterns,
    indexKey,
    maxSuggestions,
    shouldLoadFiles,
  ]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);
  return {
    ...atMatch,
    suggestions,
    selectedIndex,
    loading,
  };
}

function formatSuggestion(suggestion: string, quoted: boolean = false): string {
  if (suggestion.includes(' ') || quoted) {
    return `@"${suggestion}"`;
  }
  return `@${suggestion}`;
}

export function applySuggestion(
  input: string,
  atMatch: AtMatchResult,
  suggestion: string
): { newInput: string; newCursorPos: number } {
  if (!atMatch.hasQuery) {
    return { newInput: input, newCursorPos: input.length };
  }

  const formatted = formatSuggestion(suggestion, atMatch.quoted);
  const before = input.slice(0, atMatch.startIndex);
  const after = input.slice(atMatch.endIndex);
  const newInput = before + formatted + ' ' + after;
  const newCursorPos = atMatch.startIndex + formatted.length + 1;
  return { newInput, newCursorPos };
}
