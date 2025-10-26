/**
 * Diff 渲染组件 - 渲染 unified diff 格式的差异
 */

import { Box, Text } from 'ink';
import React from 'react';
import { themeManager } from '../themes/ThemeManager.js';

interface DiffRendererProps {
  patch: string; // unified diff 格式的 patch
  startLine: number; // 起始行号
  matchLine: number; // 变更所在行号
  terminalWidth: number;
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
export const DiffRenderer: React.FC<DiffRendererProps> = ({
  patch,
  startLine,
  matchLine,
  terminalWidth,
}) => {
  const theme = themeManager.getTheme();
  const parsedLines = parsePatch(patch);

  // 计算行号列宽度
  const maxLineNum = Math.max(...parsedLines.map((l) => l.lineNumber || 0));
  const lineNumWidth = maxLineNum.toString().length + 1;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* 分隔符 */}
      <Text color={theme.colors.muted}>{'─'.repeat(Math.min(60, terminalWidth))}</Text>

      {/* 变更位置提示 */}
      <Text color={theme.colors.info}>
        📍 变更位置：第 {matchLine} 行（从第 {startLine} 行开始显示）
      </Text>

      {/* 分隔符 */}
      <Text color={theme.colors.muted}>{'─'.repeat(Math.min(60, terminalWidth))}</Text>

      {/* 渲染 diff 内容 */}
      {parsedLines.map((line, index) => {
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
          fgColor = theme.colors.text;
        }

        // 截断过长的行（保留空间给行号和前缀）
        const maxContentWidth = terminalWidth - lineNumWidth - 2;
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

      {/* 分隔符 */}
      <Text color={theme.colors.muted}>{'─'.repeat(Math.min(60, terminalWidth))}</Text>
    </Box>
  );
};
