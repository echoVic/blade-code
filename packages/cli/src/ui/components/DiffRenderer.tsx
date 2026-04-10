/**
 * Diff 渲染组件 - 渲染 unified diff 格式的差异
 */

import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';

interface DiffRendererProps {
  patch: string; // unified diff 格式的 patch
  startLine?: number; // 起始行号（保留用于向后兼容，但不再显示）
  matchLine?: number; // 变更所在行号（保留用于向后兼容，但不再显示）
  terminalWidth: number;
  maxLines?: number; // 默认显示的最大行数（默认 20 行）
}

/**
 * 解析 unified diff 格式的 patch
 */
function parsePatch(patch: string): Array<{
  type: 'context' | 'add' | 'remove' | 'header';
  content: string;
  lineNumber?: number;
}> {
  const lines = patch.split('\n');
  const result: Array<{
    type: 'context' | 'add' | 'remove' | 'header';
    content: string;
    lineNumber?: number;
  }> = [];

  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    // 跳过文件头信息（--- 和 +++ 开头的行）
    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    // 解析 hunk 头 (@@ -1,3 +1,3 @@)
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[3], 10);
      }
      result.push({
        type: 'header',
        content: line,
      });
      continue;
    }

    // 删除的行
    if (line.startsWith('-')) {
      result.push({
        type: 'remove',
        content: line.substring(1),
        lineNumber: oldLineNum,
      });
      oldLineNum++;
      continue;
    }

    // 添加的行
    if (line.startsWith('+')) {
      result.push({
        type: 'add',
        content: line.substring(1),
        lineNumber: newLineNum,
      });
      newLineNum++;
      continue;
    }

    // 上下文行（未改变）
    if (line.startsWith(' ') || line === '') {
      result.push({
        type: 'context',
        content: line.substring(1),
        lineNumber: newLineNum,
      });
      oldLineNum++;
      newLineNum++;
      continue;
    }
  }

  return result;
}

/**
 * DiffRenderer 组件
 */
export const DiffRenderer: React.FC<DiffRendererProps> = React.memo(
  ({
    patch,
    startLine,
    matchLine,
    terminalWidth,
    maxLines = 20, // 默认显示 20 行
  }) => {
    const theme = useTheme();
    const parsedLines = parsePatch(patch);

    // 计算行号列宽度
    const maxLineNum = Math.max(...parsedLines.map((l) => l.lineNumber || 0));
    const lineNumWidth = maxLineNum.toString().length + 1;

    // 判断是否需要折叠
    const totalLines = parsedLines.length;
    const needsCollapse = totalLines > maxLines;
    const displayLines = needsCollapse ? parsedLines.slice(0, maxLines) : parsedLines;
    const hiddenLines = totalLines - maxLines;

    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {/* 分隔符 */}
        <Text color={theme.colors.muted}>
          {'─'.repeat(Math.max(0, Math.min(60, terminalWidth)))}
        </Text>

        {/* diff 统计信息 */}
        {needsCollapse && (
          <Text color={theme.colors.info}>
            显示前 {maxLines} 行，共 {totalLines} 行 diff
          </Text>
        )}

        {/* 分隔符（仅在有统计信息时显示） */}
        {needsCollapse && (
          <Text color={theme.colors.muted}>
            {'─'.repeat(Math.max(0, Math.min(60, terminalWidth)))}
          </Text>
        )}

        {/* 渲染 diff 内容 */}
        {displayLines.map((line, index) => {
          if (line.type === 'header') {
            return (
              <Text key={index} color={theme.colors.muted} dimColor>
                {line.content}
              </Text>
            );
          }

          // 行号
          const lineNumStr = line.lineNumber
            ? line.lineNumber.toString().padStart(lineNumWidth, ' ')
            : ' '.repeat(lineNumWidth);

          // 前缀符号
          let prefix = ' ';
          let bgColor: string | undefined;
          let fgColor: string | undefined;

          if (line.type === 'add') {
            prefix = '+';
            fgColor = theme.colors.success;
            bgColor = undefined; // Ink 不支持背景色，使用前景色区分
          } else if (line.type === 'remove') {
            prefix = '-';
            fgColor = theme.colors.error;
            bgColor = undefined;
          } else {
            fgColor = theme.colors.text.primary;
          }

          // 截断过长的行（保留空间给行号和前缀）
          const maxContentWidth = Math.max(0, terminalWidth - lineNumWidth - 2);
          let content = line.content;
          if (content.length > maxContentWidth) {
            content = content.substring(0, maxContentWidth - 3) + '...';
          }

          return (
            <Text key={index} color={fgColor} backgroundColor={bgColor}>
              <Text dimColor>{lineNumStr}</Text>
              <Text>{prefix}</Text>
              <Text> {content}</Text>
            </Text>
          );
        })}

        {/* 折叠提示 */}
        {needsCollapse && (
          <Box marginTop={1}>
            <Text color={theme.colors.warning} dimColor>
              已隐藏剩余 {hiddenLines} 行 diff（总共 {totalLines} 行）
            </Text>
          </Box>
        )}

        {/* 分隔符 */}
        <Text color={theme.colors.muted}>
          {'─'.repeat(Math.max(0, Math.min(60, terminalWidth)))}
        </Text>
      </Box>
    );
  }
);
