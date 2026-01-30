/**
 * Markdown 工具函数
 */

import stringWidth from 'string-width';

/**
 * 计算去除 Markdown 标记后的真实显示宽度
 * 用于表格列宽计算、文本对齐等场景
 *
 * @param text 包含 Markdown 标记的文本
 * @returns 终端显示宽度（考虑 Unicode、emoji、全角字符）
 *
 * @example
 * getPlainTextLength('**粗体**') // 返回 2（不包含 ** 标记）
 * getPlainTextLength('[链接](url)') // 返回 2（不包含 url 部分）
 */
export const getPlainTextLength = (text: string): number => {
  const cleanText = text
    // 移除粗体标记 **text**
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // 移除斜体标记 *text* 或 _text_
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    // 移除删除线标记 ~~text~~
    .replace(/~~(.*?)~~/g, '$1')
    // 移除内联代码标记 `text`
    .replace(/`(.*?)`/g, '$1')
    // 移除下划线标记 <u>text</u>
    .replace(/<u>(.*?)<\/u>/g, '$1')
    // 移除链接，只保留链接文本 [text](url) -> text
    .replace(/\[(.*?)\]\(.*?\)/g, '$1');

  // 使用 string-width 计算真实显示宽度
  // 能正确处理 Unicode、emoji、全角字符等
  return stringWidth(cleanText);
};

/**
 * 将文本截断到指定宽度（保留 Markdown 格式）
 * 使用二分搜索优化性能
 *
 * @param text 原始文本
 * @param maxWidth 最大显示宽度
 * @param ellipsis 省略号（默认 '...'）
 * @returns 截断后的文本
 *
 * @example
 * truncateText('**这是一段很长的粗体文本**', 10)
 * // 返回类似: '**这是一段很...**'
 */
export const truncateText = (
  text: string,
  maxWidth: number,
  ellipsis = '...'
): string => {
  const currentWidth = getPlainTextLength(text);

  // 无需截断
  if (currentWidth <= maxWidth) {
    return text;
  }

  // 宽度不足以显示省略号
  if (maxWidth <= ellipsis.length) {
    return ellipsis.substring(0, maxWidth);
  }

  // 二分搜索最佳截断点
  let left = 0;
  let right = text.length;
  let bestCandidate = '';

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const candidate = text.substring(0, mid);
    const candidateWidth = getPlainTextLength(candidate);

    // 为省略号预留空间
    if (candidateWidth <= maxWidth - ellipsis.length) {
      bestCandidate = candidate;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return bestCandidate + ellipsis;
};

/**
 * 检查文本是否包含 Markdown 格式标记
 * 用于性能优化：纯文本可以跳过复杂的解析逻辑
 *
 * @param text 待检查的文本
 * @returns 是否包含 Markdown 标记
 */
export const hasMarkdownFormat = (text: string): boolean => {
  // 快速检测常见的 Markdown 标记
  return /[*_~`<[\]https?:]/.test(text);
};

// ==================== 流式消息分割 ====================

/**
 * 检查给定索引是否在代码块内部
 *
 * @param content 完整内容
 * @param indexToTest 要测试的索引
 * @returns 如果索引在代码块内部返回 true
 */
const isIndexInsideCodeBlock = (content: string, indexToTest: number): boolean => {
  let fenceCount = 0;
  let searchPos = 0;
  while (searchPos < content.length) {
    const nextFence = content.indexOf('```', searchPos);
    if (nextFence === -1 || nextFence >= indexToTest) {
      break;
    }
    fenceCount++;
    searchPos = nextFence + 3;
  }
  return fenceCount % 2 === 1;
};

/**
 * 查找包含给定索引的代码块的起始位置
 *
 * @param content Markdown 内容
 * @param index 要检查的索引
 * @returns 代码块起始索引，如果不在代码块内返回 -1
 */
const findEnclosingCodeBlockStart = (content: string, index: number): number => {
  if (!isIndexInsideCodeBlock(content, index)) {
    return -1;
  }
  let currentSearchPos = 0;
  while (currentSearchPos < index) {
    const blockStartIndex = content.indexOf('```', currentSearchPos);
    if (blockStartIndex === -1 || blockStartIndex >= index) {
      break;
    }
    const blockEndIndex = content.indexOf('```', blockStartIndex + 3);
    if (blockStartIndex < index) {
      if (blockEndIndex === -1 || index < blockEndIndex + 3) {
        return blockStartIndex;
      }
    }
    if (blockEndIndex === -1) break;
    currentSearchPos = blockEndIndex + 3;
  }
  return -1;
};

/**
 * 查找最后一个安全的分割点
 *
 * 这是流式渲染性能优化的核心函数。
 * 在流式输出时，将已完成的内容片段移入 Static 组件，
 * 只保留最后未完成的片段在动态渲染区域。
 *
 * 分割策略（按优先级）：
 * 1. 如果内容末尾在代码块内，在代码块开始前分割
 * 2. 查找最后一个不在代码块内的双换行（段落边界）
 * 3. 如果没有安全分割点，返回 content.length（不分割）
 *
 *
 * @param content 要分割的内容
 * @returns 安全的分割点索引
 *
 * @example
 * // 在段落边界分割
 * findLastSafeSplitPoint('Hello\n\nWorld') // 返回 7（'World' 之前）
 *
 * // 不分割代码块
 * findLastSafeSplitPoint('```js\ncode\n```') // 返回 14（完整内容）
 *
 * // 代码块未闭合时，在代码块前分割
 * findLastSafeSplitPoint('text\n\n```js\ncode') // 返回 0（代码块开始前）
 */
export const findLastSafeSplitPoint = (content: string): number => {
  // 检查内容末尾是否在代码块内
  const enclosingBlockStart = findEnclosingCodeBlockStart(content, content.length);
  if (enclosingBlockStart !== -1) {
    // 内容末尾在代码块内，在代码块开始前分割
    return enclosingBlockStart;
  }

  // 查找最后一个不在代码块内的双换行（段落边界）
  let searchStartIndex = content.length;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf('\n\n', searchStartIndex);
    if (dnlIndex === -1) {
      // 没有更多双换行
      break;
    }

    const potentialSplitPoint = dnlIndex + 2;
    if (!isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }

    // 如果分割点在代码块内，继续向前搜索
    searchStartIndex = dnlIndex - 1;
  }

  // 没有找到安全分割点，返回完整内容长度（不分割）
  return content.length;
};
