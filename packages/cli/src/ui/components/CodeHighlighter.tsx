/**
 * 代码高亮组件 - 使用 lowlight 进行语法高亮
 *
 * 特性：
 * - 语法高亮（140+ 语言）
 * - 智能换行（超长行按字符拆分，保留样式）
 * - 行数截断（超出高度显示截断提示）
 * - Unicode 感知（正确处理 emoji、汉字等）
 */

import { Box, Text } from 'ink';
import { isPlainObject } from 'lodash-es';
import { common, createLowlight } from 'lowlight';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';
import { themeManager } from '../themes/ThemeManager.js';
import type { SyntaxColors } from '../themes/types.js';
import { MaxSizedBox, MINIMUM_MAX_HEIGHT } from './MaxSizedBox.js';

// 创建 lowlight 实例
const lowlight = createLowlight(common);

interface CodeHighlighterProps {
  content: string;
  language?: string;
  showLineNumbers?: boolean;
  terminalWidth: number;
  availableHeight?: number; // 可用的终端高度（用于智能截断）
}

type HastTextNode = { type: 'text'; value: string };
type HastElementNode = {
  type: 'element';
  properties?: { className?: string[] };
  children?: unknown[];
};
type HastRootNode = { type: 'root'; children: unknown[] };

function isHastTextNode(node: unknown): node is HastTextNode {
  return (
    isPlainObject(node) &&
    (node as HastTextNode).type === 'text' &&
    typeof (node as HastTextNode).value === 'string'
  );
}

function isHastElementNode(node: unknown): node is HastElementNode {
  return isPlainObject(node) && (node as HastElementNode).type === 'element';
}

function isHastRootNode(node: unknown): node is HastRootNode {
  return (
    isPlainObject(node) &&
    (node as HastRootNode).type === 'root' &&
    Array.isArray((node as HastRootNode).children)
  );
}

/**
 * 将 lowlight 的 HAST 节点转换为 React 组件
 */
function renderHastNode(
  node: unknown,
  syntaxColors: SyntaxColors,
  key: number = 0
): React.ReactNode {
  if (isHastTextNode(node)) {
    return (
      <Text key={key} wrap="wrap">
        {node.value}
      </Text>
    );
  }

  if (isHastElementNode(node)) {
    const className = node.properties?.className?.[0] || '';
    let color = syntaxColors.default;

    // 根据类名映射颜色
    if (className.includes('comment')) color = syntaxColors.comment;
    else if (className.includes('string')) color = syntaxColors.string;
    else if (className.includes('number')) color = syntaxColors.number;
    else if (className.includes('keyword')) color = syntaxColors.keyword;
    else if (className.includes('function')) color = syntaxColors.function;
    else if (className.includes('variable')) color = syntaxColors.variable;
    else if (className.includes('operator')) color = syntaxColors.operator;
    else if (className.includes('type')) color = syntaxColors.type;
    else if (className.includes('tag')) color = syntaxColors.tag;
    else if (className.includes('attr')) color = syntaxColors.attr;

    const children = node.children?.map((child: unknown, index: number) =>
      renderHastNode(child, syntaxColors, index)
    );

    return (
      <Text key={key} color={color} wrap="wrap">
        {children}
      </Text>
    );
  }

  // Root 节点
  if (isHastRootNode(node)) {
    return (
      <React.Fragment key={key}>
        {node.children.map((child: unknown, index: number) =>
          renderHastNode(child, syntaxColors, index)
        )}
      </React.Fragment>
    );
  }

  return <Text key={key}></Text>;
}

/**
 * 高亮单行代码（不截断，由 MaxSizedBox 处理换行）
 */
function highlightLine(
  line: string,
  language?: string,
  syntaxColors?: SyntaxColors
): React.ReactNode {
  const colors = syntaxColors || themeManager.getTheme().colors.syntax;

  try {
    if (!language || !lowlight.registered(language)) {
      // 尝试自动检测语言
      const result = lowlight.highlightAuto(line);
      if (!result.children || result.children.length === 0) {
        return (
          <Text color={colors.default} wrap="wrap">
            {line}
          </Text>
        );
      }
      return renderHastNode(result, colors);
    }

    const result = lowlight.highlight(language, line);
    if (!result.children || result.children.length === 0) {
      return (
        <Text color={colors.default} wrap="wrap">
          {line}
        </Text>
      );
    }
    return renderHastNode(result, colors);
  } catch (_error) {
    return (
      <Text color={colors.default} wrap="wrap">
        {line}
      </Text>
    );
  }
}

/**
 * 代码高亮器组件
 *
 * 使用 MaxSizedBox 实现：
 * - 智能换行：超长行按字符/单词拆分到多行，保留语法高亮样式
 * - 高度截断：超出 availableHeight 时显示截断提示
 * - Unicode 感知：正确处理 emoji、汉字等宽字符
 */
export const CodeHighlighter: React.FC<CodeHighlighterProps> = React.memo(
  ({ content, language, showLineNumbers = true, terminalWidth, availableHeight }) => {
    const theme = useTheme();
    let lines = content.split('\n');
    let hiddenLinesCount = 0;

    // 智能截断：仅高亮可见行（性能优化）
    if (availableHeight && lines.length > availableHeight) {
      const effectiveHeight = Math.max(availableHeight, MINIMUM_MAX_HEIGHT);

      if (lines.length > effectiveHeight) {
        hiddenLinesCount = lines.length - effectiveHeight;
        lines = lines.slice(hiddenLinesCount);
      }
    }

    const totalLines = lines.length + hiddenLinesCount;
    const lineNumberWidth = String(totalLines).length + 1;
    // 计算代码内容可用宽度（终端宽度 - 边框 - padding - 行号）
    // 最小宽度 20，防止终端过窄或 terminalWidth 异常时布局崩溃
    const boxMaxWidth = Math.max(20, terminalWidth - 4); // 4 = 边框(2) + paddingX(2)

    return (
      <Box
        borderStyle="round"
        borderColor={theme.colors.border.light}
        paddingX={1}
        paddingY={0}
        marginY={1}
        flexDirection="column"
      >
        {/* 语言标签 */}
        {language && (
          <Box marginBottom={0}>
            <Text color={theme.colors.text.secondary}>{language}</Text>
          </Box>
        )}

        {/* 隐藏行数提示 */}
        {hiddenLinesCount > 0 && (
          <Box marginBottom={0}>
            <Text color={theme.colors.text.muted} dimColor>
              ... {hiddenLinesCount} lines hidden ...
            </Text>
          </Box>
        )}

        {/* 代码内容 - 使用 MaxSizedBox 实现智能换行 */}
        <MaxSizedBox maxWidth={boxMaxWidth} maxHeight={availableHeight}>
          {lines.map((line, index) => {
            const actualLineNumber = index + hiddenLinesCount + 1;

            return (
              <Box key={index} flexDirection="row">
                {/* 行号 - 不换行 */}
                {showLineNumbers && (
                  <Text color={theme.colors.text.muted} dimColor wrap="truncate">
                    {String(actualLineNumber).padStart(lineNumberWidth - 1, ' ')}{' '}
                  </Text>
                )}

                {/* 代码内容 - 可换行 */}
                {line.trim() === '' ? (
                  <Text wrap="wrap"> </Text>
                ) : (
                  highlightLine(line, language, theme.colors.syntax)
                )}
              </Box>
            );
          })}
        </MaxSizedBox>
      </Box>
    );
  }
);
