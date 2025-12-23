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
const _PASTE_MARKER_REGEX = new RegExp(
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
 * 文本粘贴内容
 */
export interface TextPasteContent {
  type: 'text';
  data: string; // 原始文本
}

/**
 * 图片粘贴内容
 */
export interface ImagePasteContent {
  type: 'image';
  data: string; // base64 编码
  mimeType: string; // 'image/png', 'image/jpeg' 等
}

/**
 * 粘贴内容（文本或图片）
 */
export type PasteContent = TextPasteContent | ImagePasteContent;

/**
 * 粘贴内容映射：ID -> 内容（文本或图片）
 * 用于在提交时将粘贴标记替换回完整内容
 */
export type PasteContentMap = Map<number, PasteContent>;

/**
 * 内容部分：文本或图片
 * 用于保留用户输入中文本和图片的相对顺序
 */
export type ResolvedContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; id: number; base64: string; mimeType: string };

/**
 * 解析结果：保留文本和图片的相对顺序
 */
export interface ResolvedInput {
  /** 显示文本（图片显示为 [Image #N] 占位符，用于 UI 显示） */
  displayText: string;
  /** 纯文本内容（粘贴标记已替换为原文，图片标记已移除） */
  text: string;
  /** 提取的图片列表（兼容旧接口） */
  images: Array<{ id: number; base64: string; mimeType: string }>;
  /** 交错的内容部分列表（保留顺序） */
  parts: ResolvedContentPart[];
}

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
  /** 粘贴内容映射：ID -> 内容（文本或图片） */
  pasteMap: PasteContentMap;
  /** 添加文本粘贴映射，返回生成的标记 ID */
  addPasteMapping: (original: string) => number;
  /** 添加图片粘贴映射，返回生成的标记 ID */
  addImagePasteMapping: (base64: string, mimeType: string) => number;
  /** 恢复粘贴映射（用于历史回放） */
  restorePasteMappings: (mappings: PasteContentMap) => void;
  /** 解析输入：分离文本和图片 */
  resolveInput: (input: string) => ResolvedInput;
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

  // 添加文本粘贴映射，返回生成的标记 ID
  // 调用方使用 createPasteMarkerStart(id) + 摘要 + getPasteMarkerEnd() 构建完整标记
  const addPasteMapping = useMemoizedFn((original: string): number => {
    pasteIdCounterRef.current += 1;
    const id = pasteIdCounterRef.current;
    pasteMapRef.current.set(id, { type: 'text', data: original });
    return id;
  });

  // 添加图片粘贴映射，返回生成的标记 ID
  const addImagePasteMapping = useMemoizedFn(
    (base64: string, mimeType: string): number => {
      pasteIdCounterRef.current += 1;
      const id = pasteIdCounterRef.current;
      pasteMapRef.current.set(id, { type: 'image', data: base64, mimeType });
      return id;
    }
  );

  // 恢复粘贴映射（用于历史回放）
  const restorePasteMappings = useMemoizedFn((mappings: PasteContentMap) => {
    for (const [id, content] of mappings) {
      pasteMapRef.current.set(id, content);
      // 更新计数器，确保新粘贴不会冲突
      if (id >= pasteIdCounterRef.current) {
        pasteIdCounterRef.current = id;
      }
    }
  });

  // 解析输入：分离文本和图片，同时保留相对顺序
  const resolveInput = useMemoizedFn((input: string): ResolvedInput => {
    const images: ResolvedInput['images'] = [];
    const parts: ResolvedContentPart[] = [];

    // 快速检查：如果没有标记，直接返回
    if (!containsPasteMarker(input)) {
      const trimmed = input.trim();
      if (trimmed) {
        parts.push({ type: 'text', text: trimmed });
      }
      return { displayText: input, text: input, images, parts };
    }

    // 使用 matchAll 获取所有匹配及其位置
    const regex = new RegExp(
      `${PASTE_MARKER_START}PASTE:(\\d+):[\\s\\S]*?${PASTE_MARKER_END}`,
      'g'
    );
    const matches = Array.from(input.matchAll(regex));

    let lastIndex = 0;
    let textWithoutImages = '';
    let displayText = '';

    for (const match of matches) {
      const matchStart = match.index!;
      const matchEnd = matchStart + match[0].length;
      const id = parseInt(match[1], 10);
      const content = pasteMapRef.current.get(id);

      // 处理标记前的文本（保留空白，用于图片间分隔）
      if (matchStart > lastIndex) {
        const beforeText = input.slice(lastIndex, matchStart);
        parts.push({ type: 'text', text: beforeText });
        textWithoutImages += beforeText;
        displayText += beforeText;
      }

      if (!content) {
        // 未找到映射，保留原标记（不应该发生）
        textWithoutImages += match[0];
        displayText += match[0];
        parts.push({ type: 'text', text: match[0] });
      } else if (content.type === 'text') {
        // 文本粘贴：替换为原文（displayText 也显示原文）
        textWithoutImages += content.data;
        displayText += content.data;
        parts.push({ type: 'text', text: content.data });
      } else {
        // 图片：添加到 parts 和 images，从纯文本中移除
        const imageData = {
          id,
          base64: content.data,
          mimeType: content.mimeType,
        };
        images.push(imageData);
        parts.push({ type: 'image', ...imageData });
        // 图片不添加到 textWithoutImages，但在 displayText 中显示占位符
        displayText += `[Image #${id}]`;
      }

      lastIndex = matchEnd;
    }

    // 处理最后一个标记后的文本（保留空白）
    if (lastIndex < input.length) {
      const afterText = input.slice(lastIndex);
      parts.push({ type: 'text', text: afterText });
      textWithoutImages += afterText;
      displayText += afterText;
    }

    // 合并相邻的文本部分
    const mergedParts: ResolvedContentPart[] = [];
    for (const part of parts) {
      if (
        part.type === 'text' &&
        mergedParts.length > 0 &&
        mergedParts[mergedParts.length - 1].type === 'text'
      ) {
        // 合并相邻文本
        (mergedParts[mergedParts.length - 1] as { type: 'text'; text: string }).text +=
          part.text;
      } else {
        mergedParts.push(part);
      }
    }

    // 清理首尾的纯空白文本部分（保留中间的空白分隔符）
    let startIndex = 0;
    let endIndex = mergedParts.length;

    // 跳过开头的纯空白文本
    while (
      startIndex < mergedParts.length &&
      mergedParts[startIndex].type === 'text' &&
      (mergedParts[startIndex] as { type: 'text'; text: string }).text.trim() === ''
    ) {
      startIndex++;
    }

    // 跳过结尾的纯空白文本
    while (
      endIndex > startIndex &&
      mergedParts[endIndex - 1].type === 'text' &&
      (mergedParts[endIndex - 1] as { type: 'text'; text: string }).text.trim() === ''
    ) {
      endIndex--;
    }

    const cleanedParts = mergedParts.slice(startIndex, endIndex);

    return {
      displayText: displayText.trim(),
      text: textWithoutImages.trim(),
      images,
      parts: cleanedParts,
    };
  });

  return {
    value: state.value,
    cursorPosition: state.cursorPosition,
    setValue,
    setCursorPosition,
    clear,
    pasteMap: pasteMapRef.current,
    addPasteMapping,
    addImagePasteMapping,
    restorePasteMappings,
    resolveInput,
  };
}
