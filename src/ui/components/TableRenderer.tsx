/**
 * 表格渲染器 - 优化版
 *
 * 主要改进：
 * - 使用 getPlainTextLength() 计算真实显示宽度（考虑 Markdown 格式）
 * - 自动缩放表格以适应终端宽度
 * - 二分搜索智能截断（保留 Markdown 格式完整性）
 * - 支持内联 Markdown 渲染
 */

import { Box, Text } from 'ink';
import React from 'react';
import { themeManager } from '../themes/ThemeManager.js';
import { getPlainTextLength, truncateText } from '../utils/markdown.js';
import { InlineRenderer } from './InlineRenderer.js';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

/**
 * 表格渲染器组件
 *
 * 特性：
 * - 自动计算列宽（考虑 Markdown 格式后的真实显示宽度）
 * - 自动缩放以适应终端宽度
 * - 智能截断单元格内容（保留 Markdown 格式）
 * - 美观的 Unicode 边框
 * - 表头特殊样式
 */
export const TableRenderer: React.FC<TableRendererProps> = ({
  headers,
  rows,
  terminalWidth,
}) => {
  const theme = themeManager.getTheme();

  if (headers.length === 0 || rows.length === 0) {
    return null;
  }

  // 1. 计算列宽（使用真实显示宽度）
  const columnWidths = headers.map((header, index) => {
    const headerWidth = getPlainTextLength(header);
    const maxRowWidth = Math.max(
      ...rows.map((row) => getPlainTextLength(row[index] || ''))
    );
    return Math.max(headerWidth, maxRowWidth) + 2; // 加 2 作为内边距
  });

  // 2. 计算总宽度并应用缩放因子
  const borderWidth = headers.length + 1; // 左右边框 + 分隔符
  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0) + borderWidth;
  const scaleFactor = totalWidth > terminalWidth ? terminalWidth / totalWidth : 1;
  const adjustedWidths = columnWidths.map((w) => Math.floor(w * scaleFactor));

  /**
   * 渲染单元格（支持内联 Markdown）
   */
  const renderCell = (
    content: string,
    width: number,
    isHeader = false
  ): React.ReactNode => {
    const contentWidth = Math.max(0, width - 2); // 减去内边距
    const displayWidth = getPlainTextLength(content);

    // 截断过长的内容（保留 Markdown 格式）
    let cellContent = content;
    if (displayWidth > contentWidth) {
      cellContent = truncateText(content, contentWidth);
    }

    // 计算需要的填充空格
    const actualDisplayWidth = getPlainTextLength(cellContent);
    const paddingNeeded = Math.max(0, contentWidth - actualDisplayWidth);

    return (
      <Text>
        {isHeader ? (
          <Text bold color={theme.colors.primary}>
            <InlineRenderer text={cellContent} />
          </Text>
        ) : (
          <InlineRenderer text={cellContent} />
        )}
        {' '.repeat(paddingNeeded)}
      </Text>
    );
  };

  /**
   * 渲染边框
   */
  const renderBorder = (type: 'top' | 'middle' | 'bottom'): React.ReactNode => {
    const chars = {
      top: { left: '┌', middle: '┬', right: '┐', horizontal: '─' },
      middle: { left: '├', middle: '┼', right: '┤', horizontal: '─' },
      bottom: { left: '└', middle: '┴', right: '┘', horizontal: '─' },
    };

    const char = chars[type];
    const borderParts = adjustedWidths.map((w) => char.horizontal.repeat(w));
    const border = char.left + borderParts.join(char.middle) + char.right;

    return (
      <Text color={theme.colors.text.muted} dimColor>
        {border}
      </Text>
    );
  };

  /**
   * 渲染表格行
   */
  const renderRow = (cells: string[], isHeader = false): React.ReactNode => {
    const renderedCells = cells.map((cell, index) => {
      const width = adjustedWidths[index] || 0;
      return renderCell(cell || '', width, isHeader);
    });

    return (
      <Text>
        <Text color={theme.colors.text.muted}>│ </Text>
        {renderedCells.map((cell, index) => (
          <React.Fragment key={index}>
            {cell}
            {index < renderedCells.length - 1 && (
              <Text color={theme.colors.text.muted}> │ </Text>
            )}
          </React.Fragment>
        ))}
        <Text color={theme.colors.text.muted}> │</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* 顶部边框 */}
      {renderBorder('top')}

      {/* 表头行 */}
      {renderRow(headers, true)}

      {/* 中间边框 */}
      {renderBorder('middle')}

      {/* 数据行 */}
      {rows.map((row, index) => (
        <React.Fragment key={index}>{renderRow(row)}</React.Fragment>
      ))}

      {/* 底部边框 */}
      {renderBorder('bottom')}
    </Box>
  );
};
