/**
 * @ 文件自动补全 Hook
 *
 * 提供 @ 文件提及的自动补全功能
 */

import fg from 'fast-glob';
import Fuse from 'fuse.js';
import { useEffect, useMemo, useState } from 'react';
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

/**
 * @ 提及匹配结果
 */
export interface AtMatchResult {
  /** 是否匹配到 @ 提及 */
  hasQuery: boolean;
  /** 提取的查询字符串（去掉 @ 和引号） */
  query: string;
  /** @ 提及的起始位置 */
  startIndex: number;
  /** @ 提及的结束位置 */
  endIndex: number;
  /** 是否使用引号 */
  quoted: boolean;
}

/**
 * 自动补全结果
 */
export interface AtCompletionResult extends AtMatchResult {
  /** 建议列表 */
  suggestions: string[];
  /** 当前选中的建议索引 */
  selectedIndex: number;
  /** 是否正在加载 */
  loading: boolean;
}

/**
 * Hook 选项
 */
export interface UseAtCompletionOptions {
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 最大建议数量，默认 15 */
  maxSuggestions?: number;
  /** 忽略模式，默认排除常见目录 */
  ignorePatterns?: string[];
  /** 防抖延迟（毫秒），默认 300ms */
  debounceDelay?: number;
  /** 是否启用模糊匹配，默认 true */
  fuzzyMatch?: boolean;
}

/**
 * 提取光标处的 @ 提及
 */
function extractAtMention(input: string, cursorPosition: number): AtMatchResult {
  // 正则：匹配 @"quoted" 或 @bareword
  // @ 之前必须是行首(^)或空格(\s),避免误匹配邮箱等
  const atMatches = [...input.matchAll(/(?:^|\s)(@(?:"[^"]*"|(?:[^\\ ]|\\ )*))/g)];

  // 找到光标位置的 @ 提及
  for (const match of atMatches) {
    const fullMatch = match[1]; // @"..." 或 @...
    const matchStart = match.index! + (match[0].length - fullMatch.length);
    const matchEnd = matchStart + fullMatch.length;

    // 检查光标是否在这个 @ 提及内
    if (cursorPosition >= matchStart && cursorPosition <= matchEnd) {
      let query = fullMatch.slice(1); // 移除 @
      let quoted = false;

      // 处理引号
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

/**
 * @ 文件自动补全 Hook
 *
 * @example
 * ```typescript
 * const completion = useAtCompletion(input, cursorPos);
 *
 * if (completion.hasQuery && completion.suggestions.length > 0) {
 *   // 显示建议下拉菜单
 *   <SuggestionList items={completion.suggestions} />
 * }
 * ```
 */
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
    cwd = process.cwd(),
    maxSuggestions = 15,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    debounceDelay = 300,
    fuzzyMatch = true,
  } = options;

  // 文件列表状态
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 将 ignorePatterns 转换为稳定的 key，避免引用变化导致无限循环
  const ignorePatternsKey = useMemo(
    () => JSON.stringify(ignorePatterns),
    [ignorePatterns]
  );

  // 提取 @ 提及
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

  // 加载文件列表（带防抖和全局缓存）- 只在输入包含 @ 时加载
  useEffect(() => {
    // 如果输入中没有 @，跳过文件加载
    if (!input.includes('@')) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // 检查全局缓存
    const now = Date.now();
    if (
      globalFileCache &&
      globalFileCache.cwd === cwd &&
      globalFileCache.ignoreKey === ignorePatternsKey &&
      now - globalFileCache.timestamp < FILE_CACHE_TTL
    ) {
      // 使用缓存
      setFiles(globalFileCache.files);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadFiles = async () => {
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
          // 更新全局缓存
          globalFileCache = {
            cwd,
            ignoreKey: ignorePatternsKey,
            files: normalized,
            timestamp: now,
          };
        }
      } catch (error) {
        console.error('Failed to load files for @ completion:', error);
        // 即使失败也不阻塞 UI
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, cwd, debounceDelay, ignorePatternsKey]);

  // 过滤建议
  const suggestions = useMemo(() => {
    if (!atMatch.hasQuery || files.length === 0) {
      return [];
    }

    const query = atMatch.query.toLowerCase();

    // 如果查询为空，返回最近修改的文件
    if (query === '') {
      return files.slice(0, maxSuggestions);
    }

    // 使用 Fuse.js 进行模糊匹配
    if (fuzzyMatch) {
      const fuse = new Fuse(files, {
        threshold: 0.4,
        ignoreLocation: true, // 支持路径任意位置匹配（长路径中的文件名也能被搜到）
        minMatchCharLength: 1,
      });

      const results = fuse.search(query);
      return results.slice(0, maxSuggestions).map((r) => r.item);
    }

    // 简单的包含匹配
    return files
      .filter((file) => file.toLowerCase().includes(query))
      .slice(0, maxSuggestions);
  }, [atMatch, files, maxSuggestions, fuzzyMatch]);

  // 重置选中索引当建议变化时
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

/**
 * 格式化建议为完整的 @ 提及
 *
 * @param suggestion - 文件路径建议
 * @param quoted - 是否需要引号
 * @returns 格式化后的 @ 提及
 */
function formatSuggestion(suggestion: string, quoted: boolean = false): string {
  // 如果路径包含空格，自动加引号
  if (suggestion.includes(' ') || quoted) {
    return `@"${suggestion}"`;
  }
  return `@${suggestion}`;
}

/**
 * 应用补全建议
 *
 * @param input - 原始输入
 * @param atMatch - @ 提及匹配结果
 * @param suggestion - 选中的建议
 * @returns 应用建议后的输入和新的光标位置
 */
export function applySuggestion(
  input: string,
  atMatch: AtMatchResult,
  suggestion: string
): { newInput: string; newCursorPos: number } {
  if (!atMatch.hasQuery) {
    return { newInput: input, newCursorPos: input.length };
  }

  // 格式化建议
  const formatted = formatSuggestion(suggestion, atMatch.quoted);

  // 替换原有的 @ 提及，保留后面的内容
  const before = input.slice(0, atMatch.startIndex);
  const after = input.slice(atMatch.endIndex);
  const newInput = before + formatted + ' ' + after;

  // 光标位置在补全后的路径之后(加一个空格)
  const newCursorPos = atMatch.startIndex + formatted.length + 1;

  return { newInput, newCursorPos };
}
