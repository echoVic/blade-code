/**
 * MaxSizedBox - 尺寸约束组件（专用于 CodeHighlighter）
 *
 * 提供内容感知的截断和智能换行功能。
 *
 * ⚠️ 使用限制：
 * - 专为 CodeHighlighter 设计，期望的子元素结构是 `<Box><Text>...</Text></Box>`
 * - 每个 Box 代表一行，Box 内的 Text 元素会被提取样式并智能换行
 * - 顶层直接 Text 会丢失嵌套子 Text 的样式（仅保留顶层 props）
 * - 不支持 wrap="truncate" 语义（统一按 wrap="wrap" 处理）
 *
 * 如果需要通用的尺寸约束组件，请直接使用 Ink 的 Box + Text wrap 属性
 */

import { Box, Text } from 'ink';
import React, { Fragment } from 'react';
import { useTheme } from '../../store/selectors/index.js';
import {
  getCachedStringWidth,
  type StyledText,
  toCodePoints,
} from '../utils/textUtils.js';

/**
 * 最小高度，确保至少显示一行内容和截断提示
 */
export const MINIMUM_MAX_HEIGHT = 2;

interface MaxSizedBoxProps {
  children?: React.ReactNode;
  maxWidth: number;
  maxHeight?: number;
  /** 溢出方向：'top' 隐藏顶部，'bottom' 隐藏底部 */
  overflowDirection?: 'top' | 'bottom';
  /** 额外的隐藏行数（用于上层组件已处理的行） */
  additionalHiddenLinesCount?: number;
}

/**
 * 行数据结构
 */
interface Row {
  /** 不换行的片段（如行号、前缀） */
  noWrapSegments: StyledText[];
  /** 可换行的片段（主要内容） */
  segments: StyledText[];
}

/**
 * MaxSizedBox 组件
 *
 * 约束子元素的尺寸，并提供：
 * 1. 智能换行 - 超长行按字符拆分到多行
 * 2. 高度截断 - 超出高度时显示截断提示
 * 3. 样式保留 - 换行后保留原有样式（颜色等）
 *
 * @example
 * <MaxSizedBox maxWidth={80} maxHeight={10}>
 *   <Box>
 *     <Text color="cyan">Line number: </Text>
 *     <Text>This is a very long line that will wrap...</Text>
 *   </Box>
 * </MaxSizedBox>
 */
export const MaxSizedBox: React.FC<MaxSizedBoxProps> = React.memo(
  ({
    children,
    maxWidth,
    maxHeight,
    overflowDirection = 'top',
    additionalHiddenLinesCount = 0,
  }) => {
    const theme = useTheme();
    const laidOutLines: StyledText[][] = [];
    const targetMaxHeight = Math.max(
      Math.round(maxHeight ?? Number.MAX_SAFE_INTEGER),
      MINIMUM_MAX_HEIGHT
    );

    // 遍历子元素，将每个 Box 转换为布局后的行
    // 注意：仅支持 Box 子元素，不支持顶层 Text（会丢失嵌套样式）
    function visitRows(element: React.ReactNode) {
      if (!React.isValidElement<{ children?: React.ReactNode }>(element)) {
        return;
      }

      if (element.type === Fragment) {
        React.Children.forEach(element.props.children, visitRows);
        return;
      }

      if (element.type === Box) {
        layoutBoxAsStyledText(element, maxWidth, laidOutLines);
        return;
      }

      // 其他元素类型（包括顶层 Text）忽略
      // 如果需要处理纯文本，请用 <Box><Text>...</Text></Box> 包装
    }

    React.Children.forEach(children, visitRows);

    // 计算是否需要截断
    const contentWillOverflow =
      laidOutLines.length > targetMaxHeight || additionalHiddenLinesCount > 0;
    const visibleContentHeight = contentWillOverflow
      ? targetMaxHeight - 1 // 留一行给截断提示
      : targetMaxHeight;

    const hiddenLinesCount =
      visibleContentHeight !== undefined
        ? Math.max(0, laidOutLines.length - visibleContentHeight)
        : 0;
    const totalHiddenLines = hiddenLinesCount + additionalHiddenLinesCount;

    // 根据溢出方向选择显示的行
    const visibleLines =
      hiddenLinesCount > 0
        ? overflowDirection === 'top'
          ? laidOutLines.slice(hiddenLinesCount)
          : laidOutLines.slice(0, visibleContentHeight)
        : laidOutLines;

    // 渲染行
    const renderedLines = visibleLines.map((line, index) => (
      <Box key={index}>
        {line.length > 0 ? (
          line.map((segment, segIndex) => (
            <Text key={segIndex} {...segment.props}>
              {segment.text}
            </Text>
          ))
        ) : (
          <Text> </Text>
        )}
      </Box>
    ));

    return (
      <Box flexDirection="column" width={maxWidth} flexShrink={0}>
        {totalHiddenLines > 0 && overflowDirection === 'top' && (
          <Text color={theme.colors.text.muted} dimColor>
            ... {totalHiddenLines} line{totalHiddenLines === 1 ? '' : 's'} hidden ...
          </Text>
        )}
        {renderedLines}
        {totalHiddenLines > 0 && overflowDirection === 'bottom' && (
          <Text color={theme.colors.text.muted} dimColor>
            ... {totalHiddenLines} line{totalHiddenLines === 1 ? '' : 's'} hidden ...
          </Text>
        )}
      </Box>
    );
  }
);

/**
 * 从 Box 元素中提取行数据
 */
function visitBoxRow(element: React.ReactNode): Row {
  if (
    !React.isValidElement<{ children?: React.ReactNode }>(element) ||
    element.type !== Box
  ) {
    return { noWrapSegments: [], segments: [] };
  }

  const row: Row = {
    noWrapSegments: [],
    segments: [],
  };

  let hasSeenWrapped = false;

  function visitRowChild(
    child: React.ReactNode,
    parentProps: Record<string, unknown> | undefined
  ) {
    if (child === null || child === undefined) {
      return;
    }

    // 字符串或数字直接作为文本
    if (typeof child === 'string' || typeof child === 'number') {
      const text = String(child);
      if (!text) return;

      const segment: StyledText = { text, props: parentProps ?? {} };

      // 根据 wrap 属性决定放入哪个数组
      if (parentProps === undefined || parentProps['wrap'] === 'wrap') {
        hasSeenWrapped = true;
        row.segments.push(segment);
      } else {
        if (!hasSeenWrapped) {
          row.noWrapSegments.push(segment);
        } else {
          row.segments.push(segment);
        }
      }
      return;
    }

    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) {
      return;
    }

    if (child.type === Fragment) {
      React.Children.forEach(child.props.children, (c) =>
        visitRowChild(c, parentProps)
      );
      return;
    }

    if (child.type !== Text) {
      return;
    }

    // 合并父子 props
    const { children, ...currentProps } = child.props;
    const mergedProps =
      parentProps === undefined ? currentProps : { ...parentProps, ...currentProps };

    React.Children.forEach(children, (c) => visitRowChild(c, mergedProps));
  }

  React.Children.forEach(element.props.children, (child) =>
    visitRowChild(child, undefined)
  );

  return row;
}

/**
 * 将 Box 元素布局为带样式的文本行
 */
function layoutBoxAsStyledText(
  element: React.ReactElement,
  maxWidth: number,
  output: StyledText[][]
) {
  const row = visitBoxRow(element);

  if (row.segments.length === 0 && row.noWrapSegments.length === 0) {
    output.push([]);
    return;
  }

  // 计算不换行部分的宽度
  let noWrapWidth = 0;
  for (const segment of row.noWrapSegments) {
    noWrapWidth += getCachedStringWidth(segment.text);
  }

  // 如果没有可换行的内容，直接处理不换行部分
  if (row.segments.length === 0) {
    const lines: StyledText[][] = [];
    let currentLine: StyledText[] = [];

    for (const segment of row.noWrapSegments) {
      const textLines = segment.text.split('\n');
      for (let i = 0; i < textLines.length; i++) {
        if (i > 0) {
          lines.push(currentLine);
          currentLine = [];
        }
        if (textLines[i]) {
          currentLine.push({ text: textLines[i], props: segment.props });
        }
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    for (const line of lines) {
      output.push(line);
    }
    return;
  }

  // 计算可用于换行内容的宽度
  const availableWidth = maxWidth - noWrapWidth;

  // 没有空间换行，截断处理
  if (availableWidth < 1) {
    handleNoSpaceForWrapping(row.noWrapSegments, maxWidth, output);
    return;
  }

  // 布局可换行内容
  const lines: StyledText[][] = [];
  let wrappingPart: StyledText[] = [];
  let wrappingPartWidth = 0;

  function pushWrappingLine() {
    if (lines.length === 0) {
      // 第一行：不换行部分 + 换行部分
      lines.push([...row.noWrapSegments, ...wrappingPart]);
    } else {
      // 后续行：用空格填充不换行部分的宽度
      if (noWrapWidth > 0) {
        lines.push([{ text: ' '.repeat(noWrapWidth), props: {} }, ...wrappingPart]);
      } else {
        lines.push(wrappingPart);
      }
    }
    wrappingPart = [];
    wrappingPartWidth = 0;
  }

  function addToWrappingPart(text: string, props: Record<string, unknown>) {
    // 合并相同样式的连续片段
    if (
      wrappingPart.length > 0 &&
      wrappingPart[wrappingPart.length - 1].props === props
    ) {
      wrappingPart[wrappingPart.length - 1].text += text;
    } else {
      wrappingPart.push({ text, props });
    }
  }

  for (const segment of row.segments) {
    const textLines = segment.text.split('\n');

    for (let lineIndex = 0; lineIndex < textLines.length; lineIndex++) {
      // 换行符后开始新行
      if (lineIndex > 0) {
        pushWrappingLine();
      }

      const lineText = textLines[lineIndex];
      const words = lineText.split(/(\s+)/);

      for (const word of words) {
        if (!word) continue;

        const wordWidth = getCachedStringWidth(word);

        // 检查是否需要换行
        if (wrappingPartWidth + wordWidth > availableWidth && wrappingPartWidth > 0) {
          pushWrappingLine();
          // 跳过纯空格
          if (/^\s+$/.test(word)) {
            continue;
          }
        }

        // 单词超过可用宽度，需要拆分
        if (wordWidth > availableWidth) {
          const wordCodePoints = toCodePoints(word);
          let remainingCodePoints = wordCodePoints;

          while (remainingCodePoints.length > 0) {
            let splitIndex = 0;
            let splitWidth = 0;

            for (const char of remainingCodePoints) {
              const charWidth = getCachedStringWidth(char);
              if (wrappingPartWidth + splitWidth + charWidth > availableWidth) {
                break;
              }
              splitWidth += charWidth;
              splitIndex++;
            }

            if (splitIndex > 0) {
              const part = remainingCodePoints.slice(0, splitIndex).join('');
              addToWrappingPart(part, segment.props);
              wrappingPartWidth += getCachedStringWidth(part);
              remainingCodePoints = remainingCodePoints.slice(splitIndex);
            }

            if (remainingCodePoints.length > 0) {
              pushWrappingLine();
            }
          }
        } else {
          addToWrappingPart(word, segment.props);
          wrappingPartWidth += wordWidth;
        }
      }
    }

    // 处理末尾换行符
    if (segment.text.endsWith('\n')) {
      pushWrappingLine();
    }
  }

  // 添加最后一行
  if (wrappingPart.length > 0) {
    pushWrappingLine();
  }

  for (const line of lines) {
    output.push(line);
  }
}

/**
 * 处理没有空间换行的情况 - 截断并添加省略号
 */
function handleNoSpaceForWrapping(
  noWrapSegments: StyledText[],
  maxWidth: number,
  output: StyledText[][]
) {
  const lines: StyledText[][] = [];
  let currentLine: StyledText[] = [];
  let currentLineWidth = 0;

  for (const segment of noWrapSegments) {
    const textLines = segment.text.split('\n');

    for (let index = 0; index < textLines.length; index++) {
      if (index > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;
      }

      const text = textLines[index];
      if (!text) continue;

      const textWidth = getCachedStringWidth(text);
      const maxContentWidth = Math.max(0, maxWidth - getCachedStringWidth('…'));

      if (textWidth <= maxContentWidth && currentLineWidth === 0) {
        currentLine.push({ text, props: segment.props });
        currentLineWidth += textWidth;
      } else {
        // 需要截断
        const codePoints = toCodePoints(text);
        let truncatedWidth = currentLineWidth;
        let sliceEndIndex = 0;

        for (const char of codePoints) {
          const charWidth = getCachedStringWidth(char);
          if (truncatedWidth + charWidth > maxContentWidth) {
            break;
          }
          truncatedWidth += charWidth;
          sliceEndIndex++;
        }

        const slice = codePoints.slice(0, sliceEndIndex).join('');
        if (slice) {
          currentLine.push({ text: slice, props: segment.props });
        }
        currentLine.push({ text: '…', props: {} });
        currentLineWidth = truncatedWidth + getCachedStringWidth('…');
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  if (lines.length === 0) {
    lines.push([{ text: '…', props: {} }]);
  }

  for (const line of lines) {
    output.push(line);
  }
}
