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
