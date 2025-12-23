import { useMemoizedFn } from 'ahooks';
import { useRef, useState } from 'react';

/**
 * 粘贴标记分隔符，用于在输入中标识粘贴内容
 * 格式：␞PASTE:id:摘要内容␟
 * 其中 ␞ (U+241E) 和 ␟ (U+241F) 是控制字符图形符号
 * 这些字符极少在普通文本中出现，可以安全地用作分隔符
 */
const PASTE_MARKER_START = '\u241E';
const PASTE_MARKER_END = '\u241F';

/**
 * 生成粘贴标记开始部分（不含结束符）
 * 调用方需要自行添加摘要内容和结束符
 */
export function createPasteMarkerStart(id: number): string {
  return `${PASTE_MARKER_START}PASTE:${id}:`;
}

/**
 * 获取粘贴标记结束符
 */
export function getPasteMarkerEnd(): string {
  return PASTE_MARKER_END;
}

/**
 * 粘贴标记正则：匹配 ␞PASTE:数字:任意内容␟
 * 使用非贪婪匹配 [\s\S]*? 确保匹配到最近的结束符（支持换行）
 * 's' flag (dotall) 在某些环境不支持，改用 [\s\S] 匹配任意字符
 */
const PASTE_MARKER_REGEX = new RegExp(
  `${PASTE_MARKER_START}PASTE:(\\d+):[\\s\\S]*?${PASTE_MARKER_END}`,
  'g'
);

/**
 * 检查字符串是否包含任何粘贴标记
 */
export function containsPasteMarker(text: string): boolean {
  return text.includes(PASTE_MARKER_START) && text.includes(PASTE_MARKER_END);
}

/**
 * 粘贴内容映射：ID -> 原文
 * 用于在提交时将粘贴标记替换回完整内容
 */
export type PasteContentMap = Map<number, string>;

/**
 * 输入缓冲区接口
 * 简化设计：直接使用 useState，让 React 自己管理状态
 */
export interface InputBuffer {
  /** 当前输入值 */
  value: string;
  /** 光标位置 */
  cursorPosition: number;
  /** 设置输入值 */
  setValue: (value: string) => void;
  /** 设置光标位置 */
  setCursorPosition: (position: number) => void;
  /** 清空输入 */
  clear: () => void;
  /** 粘贴内容映射：ID -> 原文 */
  pasteMap: PasteContentMap;
  /** 添加粘贴映射，返回生成的标记 ID */
  addPasteMapping: (original: string) => number;
  /** 恢复粘贴映射（用于历史回放） */
  restorePasteMappings: (mappings: PasteContentMap) => void;
  /** 解析输入：将粘贴标记替换为原文 */
  resolveInput: (input: string) => string;
}

/**
 * 输入缓冲区 Hook
 *
 * 粘贴标记设计：
 * - 使用唯一 ID 标记粘贴内容：␞PASTE:1:摘要内容␟
 * - 映射存储 ID -> 原文
 * - 用户可以在标记前后编辑文本，不影响映射
 * - 提交时通过正则替换整个标记（包括摘要）为原文
 */
export function useInputBuffer(
  initialValue: string = '',
  initialCursorPosition: number = 0
): InputBuffer {
  // 使用单一状态对象，避免多次setState导致重复渲染
  const [state, setState] = useState({
    value: initialValue,
    cursorPosition: initialCursorPosition,
  });

  // 粘贴 ID 计数器
  const pasteIdCounterRef = useRef(0);

  // 粘贴内容映射：ID -> 原文
  const pasteMapRef = useRef<PasteContentMap>(new Map());

  // 设置值
  const setValue = useMemoizedFn((newValue: string) => {
    setState((prev) => ({
      value: newValue,
      cursorPosition: prev.cursorPosition,
    }));

    // 清理不再存在于输入中的粘贴映射
    // 检查标记开始部分是否存在（格式：␞PASTE:id:）
    for (const id of pasteMapRef.current.keys()) {
      const markerStart = createPasteMarkerStart(id);
      if (!newValue.includes(markerStart)) {
        pasteMapRef.current.delete(id);
      }
    }
  });

  // 光标位置设置（带边界检查）
  const setCursorPosition = useMemoizedFn((position: number) => {
    setState((prev) => ({
      ...prev,
      cursorPosition: Math.max(0, Math.min(position, prev.value.length)),
    }));
  });

  // 清空
  const clear = useMemoizedFn(() => {
    setState({ value: '', cursorPosition: 0 });
    pasteMapRef.current.clear();
  });

  // 添加粘贴映射，返回生成的标记 ID
  // 调用方使用 createPasteMarkerStart(id) + 摘要 + getPasteMarkerEnd() 构建完整标记
  const addPasteMapping = useMemoizedFn((original: string): number => {
    pasteIdCounterRef.current += 1;
    const id = pasteIdCounterRef.current;
    pasteMapRef.current.set(id, original);
    return id;
  });

  // 恢复粘贴映射（用于历史回放）
  const restorePasteMappings = useMemoizedFn((mappings: PasteContentMap) => {
    for (const [id, original] of mappings) {
      pasteMapRef.current.set(id, original);
      // 更新计数器，确保新粘贴不会冲突
      if (id >= pasteIdCounterRef.current) {
        pasteIdCounterRef.current = id;
      }
    }
  });

  // 解析输入：将粘贴标记替换为原文
  const resolveInput = useMemoizedFn((input: string): string => {
    // 快速检查：如果没有标记，直接返回
    if (!containsPasteMarker(input)) {
      return input;
    }

    // 使用正则全局替换所有标记
    return input.replace(PASTE_MARKER_REGEX, (match, idStr) => {
      const id = parseInt(idStr, 10);
      const original = pasteMapRef.current.get(id);
      // 如果找到映射则替换，否则保留原标记（不应该发生）
      return original !== undefined ? original : match;
    });
  });

  return {
    value: state.value,
    cursorPosition: state.cursorPosition,
    setValue,
    setCursorPosition,
    clear,
    pasteMap: pasteMapRef.current,
    addPasteMapping,
    restorePasteMappings,
    resolveInput,
  };
}
