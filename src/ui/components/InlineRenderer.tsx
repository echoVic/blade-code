/**
 * 内联 Markdown 渲染器
 * 支持粗体、斜体、删除线、内联代码、链接等格式
 */

import { Text } from 'ink';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';
import { hasMarkdownFormat } from '../utils/markdown.js';

interface InlineRendererProps {
  text: string;
}

// Markdown 标记长度常量
const BOLD_MARKER_LENGTH = 2; // **
const ITALIC_MARKER_LENGTH = 1; // * 或 _
const STRIKETHROUGH_MARKER_LENGTH = 2; // ~~
const _INLINE_CODE_MARKER_LENGTH = 1; // `

/**
 * 生成稳定的 key（基于类型和局部序号）
 * 避免同一文本在多次渲染中 key 抖动导致重渲染
 */
function stableKey(kind: 'text' | 'match', seq: number): string {
  return `inline-${kind}-${seq}`;
}

/**
 * 内联 Markdown 渲染器组件
 *
 * 支持的格式：
 * - **粗体** → <Text bold>
 * - *斜体* 或 _斜体_ → <Text italic>
 * - ~~删除线~~ → <Text strikethrough>
 * - `内联代码` → <Text color={accent} backgroundColor="gray">
 * - [链接文本](URL) → 文本 + <Text color={link}>(URL)</Text>
 * - 自动识别 URL → <Text color={link}>
 *
 * @example
 * <InlineRenderer text="This is **bold** and *italic* text" />
 */
const InlineRendererInternal: React.FC<InlineRendererProps> = ({ text }) => {
  // 从 Store 获取主题（响应式）
  const theme = useTheme();

  // 性能优化：纯文本快速路径
  if (!hasMarkdownFormat(text)) {
    return <Text>{text}</Text>;
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let textSeq = 0; // 纯文本序号
  let matchSeq = 0; // 匹配项序号

  // 统一正则表达式匹配所有内联格式
  // 顺序很重要：粗体在斜体之前，以避免 **text** 被误识别为两个 *
  const inlineRegex =
    /(\*\*.*?\*\*|\*(?!\s).*?(?<!\s)\*|_(?!\s).*?(?<!\s)_|~~.*?~~|`+[^`]+`+|\[.*?\]\(.*?\)|https?:\/\/\S+)/g;

  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    // 添加匹配前的普通文本
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index);
      nodes.push(
        <Text key={stableKey('text', textSeq++)}>{plainText}</Text>
      );
    }

    const fullMatch = match[0];
    let renderedNode: React.ReactNode = null;
    const key = stableKey('match', matchSeq++);

    try {
      // 粗体：**text**
      if (
        fullMatch.startsWith('**') &&
        fullMatch.endsWith('**') &&
        fullMatch.length > BOLD_MARKER_LENGTH * 2
      ) {
        renderedNode = (
          <Text key={key} bold>
            {fullMatch.slice(BOLD_MARKER_LENGTH, -BOLD_MARKER_LENGTH)}
          </Text>
        );
      }
      // 斜体：*text* 或 _text_
      // 避免误判文件路径中的下划线（如 file_name.txt）
      else if (
        fullMatch.length > ITALIC_MARKER_LENGTH * 2 &&
        ((fullMatch.startsWith('*') && fullMatch.endsWith('*')) ||
          (fullMatch.startsWith('_') && fullMatch.endsWith('_')))
      ) {
        // 检查前后是否有字母/数字（避免误判文件路径）
        const beforeChar = text.substring(match.index - 1, match.index);
        const afterChar = text.substring(
          inlineRegex.lastIndex,
          inlineRegex.lastIndex + 1
        );

        // 避免误判：file_name 或 path/to_file
        const isFalsePath =
          /\w/.test(beforeChar) ||
          /\w/.test(afterChar) ||
          /[./\\]/.test(beforeChar + afterChar);

        if (!isFalsePath) {
          renderedNode = (
            <Text key={key} italic>
              {fullMatch.slice(ITALIC_MARKER_LENGTH, -ITALIC_MARKER_LENGTH)}
            </Text>
          );
        }
      }
      // 删除线：~~text~~
      else if (
        fullMatch.startsWith('~~') &&
        fullMatch.endsWith('~~') &&
        fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2
      ) {
        renderedNode = (
          <Text key={key} strikethrough>
            {fullMatch.slice(STRIKETHROUGH_MARKER_LENGTH, -STRIKETHROUGH_MARKER_LENGTH)}
          </Text>
        );
      }
      // 内联代码：`text` 或 ``text``
      else if (fullMatch.startsWith('`') && fullMatch.endsWith('`')) {
        const codeMatch = fullMatch.match(/^(`+)([^`]+)\1$/);
        if (codeMatch && codeMatch[2]) {
          renderedNode = (
            <Text
              key={key}
              color={theme.colors.syntax.keyword}
              backgroundColor={theme.colors.background.secondary}
              bold
            >
              {` ${codeMatch[2]} `}
            </Text>
          );
        }
      }
      // 链接：[text](url)
      else if (
        fullMatch.startsWith('[') &&
        fullMatch.includes('](') &&
        fullMatch.endsWith(')')
      ) {
        const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
          const linkText = linkMatch[1];
          const url = linkMatch[2];
          renderedNode = (
            <Text key={key}>
              {linkText}
              <Text color={theme.colors.info}> ({url})</Text>
            </Text>
          );
        }
      }
      // URL：https://... 或 http://...
      else if (fullMatch.match(/^https?:\/\//)) {
        renderedNode = (
          <Text key={key} color={theme.colors.info}>
            {fullMatch}
          </Text>
        );
      }
    } catch (e) {
      // 解析失败时回退到原始文本
      console.error('InlineRenderer 解析错误:', fullMatch, e);
      renderedNode = null;
    }

    // 如果渲染失败，显示原始文本
    nodes.push(renderedNode ?? <Text key={key}>{fullMatch}</Text>);
    lastIndex = inlineRegex.lastIndex;
  }

  // 添加最后剩余的普通文本
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    nodes.push(
      <Text key={stableKey('text', textSeq++)}>{remaining}</Text>
    );
  }

  return <>{nodes.filter((node) => node !== null)}</>;
};

export const InlineRenderer = React.memo(InlineRendererInternal);
