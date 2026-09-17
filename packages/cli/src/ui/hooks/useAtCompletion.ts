import fg from 'fast-glob';
import Fuse from 'fuse.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCwd } from '../../utils/cwd.js';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
} from '../../utils/filePatterns.js';

// 全局文件列表缓存，避免重复加载
let globalFileCache: {
  cwd: string;
  ignoreKey: string;
  files: string[];
  timestamp: number;
} | null = null;
const FILE_CACHE_TTL = 5000; // 5 秒缓存

export function clearAtCompletionCache(): void {
  globalFileCache = null;
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
  canRequestRef.current = canRequest;
  const [files, setFiles] = useState<string[]>([]);
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
  useEffect(() => {
    if (!shouldLoadFiles) {
      setFiles([]);
      setLoading(false);
      return;
    }

    const now = Date.now();
    if (
      globalFileCache &&
      globalFileCache.cwd === cwd &&
      globalFileCache.ignoreKey === ignorePatternsKey &&
      now - globalFileCache.timestamp < FILE_CACHE_TTL
    ) {
      setFiles(globalFileCache.files);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const loadFiles = async () => {
      if (disabled || canRequestRef.current?.() === false) {
        setFiles([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const foundFiles = (await fg('**/*', {
          cwd,
          dot: false,
          followSymbolicLinks: false,
          onlyFiles: false,
          markDirectories: true,
          unique: true,
          ignore: ignorePatterns,
        })) as string[];
        const normalized = foundFiles.map((f) => f.replace(/\\/g, '/'));
        if (!cancelled) {
          setFiles(normalized);
          globalFileCache = {
            cwd,
            ignoreKey: ignorePatternsKey,
            files: normalized,
            timestamp: now,
          };
        }
      } catch (error) {
        console.error('Failed to load files for @ completion:', error);
        if (!cancelled) {
          setFiles([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    const timer = setTimeout(loadFiles, debounceDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // ignorePatternsKey intentionally represents the array's semantic value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoadFiles, cwd, debounceDelay, ignorePatternsKey, disabled]);
  const fuse = useMemo(
    () =>
      fuzzyMatch && files.length > 0
        ? new Fuse(files, {
            threshold: 0.4,
            ignoreLocation: true,
            minMatchCharLength: 1,
          })
        : null,
    [files, fuzzyMatch]
  );
  const suggestions = useMemo(() => {
    if (!atMatch.hasQuery || files.length === 0) {
      return [];
    }

    const query = atMatch.query.toLowerCase();
    if (query === '') {
      return files.slice(0, maxSuggestions);
    }

    if (fuse) {
      const results = fuse.search(query);
      return results.slice(0, maxSuggestions).map((r) => r.item);
    }

    return files
      .filter((file) => file.toLowerCase().includes(query))
      .slice(0, maxSuggestions);
  }, [atMatch, files, fuse, maxSuggestions]);
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
