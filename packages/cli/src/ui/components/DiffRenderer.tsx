/**
 * Diff 渲染组件 - 渲染 unified diff 格式的差异
 * 支持交互式展开/折叠
 */

import { Box, Text } from 'ink';
import React, { useState } from 'react';
import { useTheme } from '../../store/selectors/index.js';
import { useTerminalInput as useInput } from '../input/TerminalInputRouter.js';

interface DiffRendererProps {
  patch: string; // unified diff 格式的 patch
  startLine?: number; // 起始行号（保留用于向后兼容，但不再显示）
  matchLine?: number; // 变更所在行号（保留用于向后兼容，但不再显示）
  terminalWidth: number;
  maxLines?: number; // 默认显示的最大行数（默认 20 行）
  isFocused?: boolean; // 是否激活键盘监听（避免多实例冲突）
}

/** 展开时显示的最大行数上限，防止性能问题 */
const MAX_EXPANDED_LINES = 400;

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
    maxLines = 20,
    isFocused = false,
  }) => {
    const theme = useTheme();
    const parsedLines = parsePatch(patch);
    const [isExpanded, setIsExpanded] = useState(false);

    // 键盘交互：按 E 切换展开/折叠
    useInput(
      (input) => {
        if (input.toLowerCase() === 'e') {
          setIsExpanded((prev) => !prev);
        }
      },
      { isActive: isFocused && parsedLines.length > maxLines }
    );

    // 计算行号列宽度
    const maxLineNum = Math.max(...parsedLines.map((l) => l.lineNumber || 0));
    const lineNumWidth = maxLineNum.toString().length + 1;

    // 统计变更行数
    const addedCount = parsedLines.filter((l) => l.type === 'add').length;
    const removedCount = parsedLines.filter((l) => l.type === 'remove').length;

    // 判断是否需要折叠
    const totalLines = parsedLines.length;
    const needsCollapse = totalLines > maxLines;

    // 根据展开状态决定显示行数
    let displayLines: typeof parsedLines;
    if (!needsCollapse) {
      displayLines = parsedLines;
    } else if (isExpanded) {
      displayLines = parsedLines.slice(0, MAX_EXPANDED_LINES);
    } else {
      displayLines = parsedLines.slice(0, maxLines);
    }

    const hiddenLines = totalLines - displayLines.length;

    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {/* 分隔符 */}
        <Text color={theme.colors.muted}>
          {'─'.repeat(Math.max(0, Math.min(60, terminalWidth)))}
        </Text>

        {/* diff 统计信息 */}
        {needsCollapse && (
          <Text color={theme.colors.info}>
            {isExpanded
              ? `已展开 ${displayLines.length}/${totalLines} 行`
              : `显示前 ${maxLines} 行，共 ${totalLines} 行`}
            {' · '}
            <Text color={theme.colors.success}>+{addedCount}</Text>{' '}
            <Text color={theme.colors.error}>-{removedCount}</Text>
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
            bgColor = undefined;
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

        {/* 折叠/展开提示 */}
        {needsCollapse && (
          <Box marginTop={1}>
            {isExpanded ? (
              <Text color={theme.colors.info} dimColor>
                {hiddenLines > 0
                  ? `已达显示上限 ${MAX_EXPANDED_LINES} 行，仍有 ${hiddenLines} 行未显示`
                  : '已显示全部内容'}
                {isFocused ? ' · 按 E 折叠' : ''}
              </Text>
            ) : (
              <Text color={theme.colors.info} dimColor>
                已隐藏剩余 {hiddenLines} 行{isFocused ? ' · 按 E 展开全部' : ''}
              </Text>
            )}
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
