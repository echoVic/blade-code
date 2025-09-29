/**
 * 代码高亮组件 - 使用 lowlight 进行语法高亮
 */

import { Box, Text } from 'ink';
import { common, createLowlight } from 'lowlight';
import React from 'react';
import { themeManager } from '../themes/theme-manager.js';
import type { SyntaxColors } from '../themes/types.js';

// 创建 lowlight 实例
const lowlight = createLowlight(common);

interface CodeHighlighterProps {
  content: string;
  language?: string;
  showLineNumbers?: boolean;
  terminalWidth: number;
}

/**
 * 将 lowlight 的 HAST 节点转换为 React 组件
 */
function renderHastNode(
  node: any,
  syntaxColors: SyntaxColors,
  key: number = 0
): React.ReactNode {
  if (node.type === 'text') {
    return <Text key={key}>{node.value}</Text>;
  }

  if (node.type === 'element') {
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

    const children = node.children?.map((child: any, index: number) =>
      renderHastNode(child, syntaxColors, index)
    );

    return (
      <Text key={key} color={color}>
        {children}
      </Text>
    );
  }

  // Root 节点
  if (node.type === 'root' && node.children) {
    return (
      <React.Fragment key={key}>
        {node.children.map((child: any, index: number) =>
          renderHastNode(child, syntaxColors, index)
        )}
      </React.Fragment>
    );
  }

  return <Text key={key}></Text>;
}

/**
 * 高亮单行代码
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
      return renderHastNode(result, colors);
    }

    const result = lowlight.highlight(language, line);
    return renderHastNode(result, colors);
  } catch (error) {
    // 高亮失败，返回原始文本
    return <Text color={colors.default}>{line}</Text>;
  }
}

/**
 * 代码高亮器组件
 */
export const CodeHighlighter: React.FC<CodeHighlighterProps> = ({
  content,
  language,
  showLineNumbers = true,
  terminalWidth,
}) => {
  const theme = themeManager.getTheme();
  const lines = content.split('\n');
  const lineNumberWidth = String(lines.length).length + 1;
  const maxCodeWidth = Math.max(20, terminalWidth - lineNumberWidth - 4); // 预留边框和间距

  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.border.light}
      paddingX={1}
      paddingY={0}
      marginY={1}
      flexDirection="column"
      width={Math.min(terminalWidth, maxCodeWidth + lineNumberWidth + 4)}
    >
      {/* 语言标签 */}
      {language && (
        <Box marginBottom={0}>
          <Text color={theme.colors.text.muted} dimColor>
            {language}
          </Text>
        </Box>
      )}

      {/* 代码内容 */}
      {lines.map((line, index) => (
        <Box key={index} flexDirection="row">
          {/* 行号 */}
          {showLineNumbers && (
            <Box width={lineNumberWidth}>
              <Text color={theme.colors.text.muted} dimColor>
                {String(index + 1).padStart(lineNumberWidth - 1, ' ')}
              </Text>
            </Box>
          )}

          {/* 代码内容 */}
          <Box flexShrink={1}>
            {line.trim() === '' ? (
              <Text> </Text>
            ) : (
              highlightLine(line, language, theme.colors.syntax)
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
};
