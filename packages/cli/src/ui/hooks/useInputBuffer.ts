import { useMemoizedFn } from 'ahooks';
import { useRef, useState } from 'react';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '../../api/attachmentLimits.js';

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
const PASTE_MARKER_PATTERN = `${PASTE_MARKER_START}PASTE:(\\d+):[\\s\\S]*?${PASTE_MARKER_END}`;

/**
 * 检查字符串是否包含任何粘贴标记
 */
function containsPasteMarker(text: string): boolean {
  return text.includes(PASTE_MARKER_START) && text.includes(PASTE_MARKER_END);
}

/**
 * 文本粘贴内容
 */
interface TextPasteContent {
  type: 'text';
  data: string; // 原始文本
}

/**
 * 图片粘贴内容
 */
interface ImagePasteContent {
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

export function validateImageAttachment(
  pasteMap: PasteContentMap,
  base64: string,
  mimeType: string
): void {
  const existingImages = [...pasteMap.values()].filter(
    (content): content is ImagePasteContent => content.type === 'image'
  );
  if (existingImages.length >= MAX_INLINE_ATTACHMENT_COUNT) {
    throw new Error(`最多只能粘贴 ${MAX_INLINE_ATTACHMENT_COUNT} 张图片`);
  }
  const existingBytes = existingImages.reduce(
    (total, image) =>
      total + `data:${image.mimeType};base64,`.length + image.data.length,
    0
  );
  const nextBytes = `data:${mimeType};base64,`.length + base64.length;
  if (existingBytes + nextBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error('图片编码后总大小不能超过 5 MiB');
  }
}

export function resolveInput(input: string, pasteMap: PasteContentMap): ResolvedInput {
  const images: ResolvedInput['images'] = [];
  const parts: ResolvedContentPart[] = [];

  if (!containsPasteMarker(input)) {
    const trimmed = input.trim();
    if (trimmed) {
      parts.push({ type: 'text', text: trimmed });
    }
    return { displayText: input, text: input, images, parts };
  }

  const matches = Array.from(input.matchAll(new RegExp(PASTE_MARKER_PATTERN, 'g')));
  let lastIndex = 0;
  let textWithoutImages = '';
  let displayText = '';

  for (const match of matches) {
    const matchStart = match.index!;
    const matchEnd = matchStart + match[0].length;
    const id = parseInt(match[1], 10);
    const content = pasteMap.get(id);

    if (matchStart > lastIndex) {
      const beforeText = input.slice(lastIndex, matchStart);
      parts.push({ type: 'text', text: beforeText });
      textWithoutImages += beforeText;
      displayText += beforeText;
    }

    if (!content) {
      textWithoutImages += match[0];
      displayText += match[0];
      parts.push({ type: 'text', text: match[0] });
    } else if (content.type === 'text') {
      textWithoutImages += content.data;
      displayText += content.data;
      parts.push({ type: 'text', text: content.data });
    } else {
      const imageData = {
        id,
        base64: content.data,
        mimeType: content.mimeType,
      };
      images.push(imageData);
      parts.push({ type: 'image', ...imageData });
      displayText += `[Image #${id}]`;
    }

    lastIndex = matchEnd;
  }

  if (lastIndex < input.length) {
    const afterText = input.slice(lastIndex);
    parts.push({ type: 'text', text: afterText });
    textWithoutImages += afterText;
    displayText += afterText;
  }

  const mergedParts: ResolvedContentPart[] = [];
  for (const part of parts) {
    const previous = mergedParts[mergedParts.length - 1];
    if (part.type === 'text' && previous?.type === 'text') {
      previous.text += part.text;
    } else {
      mergedParts.push(part);
    }
  }

  let startIndex = 0;
  let endIndex = mergedParts.length;
  while (startIndex < mergedParts.length) {
    const part = mergedParts[startIndex];
    if (part.type !== 'text' || part.text.trim() !== '') break;
    startIndex++;
  }
  while (endIndex > startIndex) {
    const part = mergedParts[endIndex - 1];
    if (part.type !== 'text' || part.text.trim() !== '') break;
    endIndex--;
  }

  return {
    displayText: displayText.trim(),
    text: textWithoutImages.trim(),
    images,
    parts: mergedParts.slice(startIndex, endIndex),
  };
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
      validateImageAttachment(pasteMapRef.current, base64, mimeType);

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
  const resolveBufferedInput = useMemoizedFn(
    (input: string): ResolvedInput => resolveInput(input, pasteMapRef.current)
  );

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
    resolveInput: resolveBufferedInput,
  };
}
