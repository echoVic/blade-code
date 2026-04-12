/**
 * 表格渲染器
 *
 * 特性：
 * - 三层宽度策略（理想宽度 / 按比例收缩 / 强制断词）
 * - 多行单元格换行（非截断），保留 Markdown 格式完整性
 * - 窄终端垂直格式降级（key-value 格式）
 * - Unicode 边框 + 安全余量防闪烁
 */

import { Text } from 'ink';
import React, { useMemo } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '../../store/selectors/index.js';
import {
  getPlainTextLength,
  getLongestWordWidth,
  wrapCellText,
  padAligned,
} from '../utils/markdown.js';
import { InlineRenderer } from './InlineRenderer.js';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

const SAFETY_MARGIN = 4;
const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;

/**
 * 表格渲染器组件
 */
export const TableRenderer: React.FC<TableRendererProps> = React.memo(
  ({ headers, rows, terminalWidth }) => {
    const theme = useTheme();

    const tableOutput = useMemo(() => {
      if (headers.length === 0 || rows.length === 0) {
        return null;
      }

      const numCols = headers.length;

      // Step 1: 计算每列的最小宽度（最长单词）和理想宽度（完整内容）
      const minWidths = headers.map((header, colIndex) => {
        let maxMin = Math.max(getLongestWordWidth(header), MIN_COLUMN_WIDTH);
        for (const row of rows) {
          maxMin = Math.max(maxMin, getLongestWordWidth(row[colIndex] || ''));
        }
        return maxMin;
      });

      const idealWidths = headers.map((header, colIndex) => {
        let maxIdeal = Math.max(getPlainTextLength(header), MIN_COLUMN_WIDTH);
        for (const row of rows) {
          maxIdeal = Math.max(
            maxIdeal,
            getPlainTextLength(row[colIndex] || '')
          );
        }
        return maxIdeal;
      });

      // Step 2: 计算可用空间
      // 边框开销: │ content │ content │ = 1 + (width + 3) per column
      const borderOverhead = 1 + numCols * 3;
      const availableWidth = Math.max(
        terminalWidth - borderOverhead - SAFETY_MARGIN,
        numCols * MIN_COLUMN_WIDTH
      );

      // Step 3: 三层宽度策略
      const totalMin = minWidths.reduce((sum, w) => sum + w, 0);
      const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);

      let needsHardWrap = false;
      let columnWidths: number[];

      if (totalIdeal <= availableWidth) {
        columnWidths = idealWidths;
      } else if (totalMin <= availableWidth) {
        const extraSpace = availableWidth - totalMin;
        const overflows = idealWidths.map(
          (ideal, i) => ideal - minWidths[i]
        );
        const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);
        columnWidths = minWidths.map((min, i) => {
          if (totalOverflow === 0) return min;
          const extra = Math.floor(
            (overflows[i] / totalOverflow) * extraSpace
          );
          return min + extra;
        });
      } else {
        needsHardWrap = true;
        const scaleFactor = availableWidth / totalMin;
        columnWidths = minWidths.map((w) =>
          Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH)
        );
      }

      // Step 4: 检查是否需要垂直格式降级
      function calculateMaxRowLines(): number {
        let maxLines = 1;
        for (let i = 0; i < headers.length; i++) {
          const wrapped = wrapCellText(
            headers[i],
            columnWidths[i],
            needsHardWrap
          );
          maxLines = Math.max(maxLines, wrapped.length);
        }
        for (const row of rows) {
          for (let i = 0; i < row.length; i++) {
            const wrapped = wrapCellText(
              row[i] || '',
              columnWidths[i],
              needsHardWrap
            );
            maxLines = Math.max(maxLines, wrapped.length);
          }
        }
        return maxLines;
      }

      const maxRowLines = calculateMaxRowLines();
      const useVerticalFormat = maxRowLines > MAX_ROW_LINES;

      if (useVerticalFormat) {
        return { type: 'vertical' as const, columnWidths, needsHardWrap };
      }

      return {
        type: 'horizontal' as const,
        columnWidths,
        needsHardWrap,
      };
    }, [headers, rows, terminalWidth]);

    if (!tableOutput) {
      return null;
    }

    // 垂直格式降级：key-value 格式
    if (tableOutput.type === 'vertical') {
      const separatorWidth = Math.min(terminalWidth - 1, 40);
      const separator = '─'.repeat(separatorWidth);

      return (
        <Text>
          {rows
            .map((row, rowIndex) => {
              const rowLines: string[] = [];
              if (rowIndex > 0) {
                rowLines.push(separator);
              }
              row.forEach((cell, colIndex) => {
                const label = headers[colIndex] || `Column ${colIndex + 1}`;
                const value = (cell || '').replace(/\n+/g, ' ').trim();
                rowLines.push(`\x1b[1m${label}:\x1b[22m ${value}`);
              });
              return rowLines.join('\n');
            })
            .join('\n')}
        </Text>
      );
    }

    // 水平格式：Unicode 边框表格
    const { columnWidths, needsHardWrap } = tableOutput;

    function renderBorderLine(
      type: 'top' | 'middle' | 'bottom'
    ): string {
      const chars = {
        top: { left: '┌', mid: '┬', right: '┐', h: '─' },
        middle: { left: '├', mid: '┼', right: '┤', h: '─' },
        bottom: { left: '└', mid: '┴', right: '┘', h: '─' },
      };
      const c = chars[type];
      let line = c.left;
      columnWidths.forEach((w, i) => {
        line += c.h.repeat(w + 2);
        line += i < columnWidths.length - 1 ? c.mid : c.right;
      });
      return line;
    }

    function renderRowLines(
      cells: string[],
      isHeader: boolean
    ): string[] {
      const cellLines = cells.map((cell, colIndex) => {
        const width = columnWidths[colIndex] || MIN_COLUMN_WIDTH;
        return wrapCellText(cell || '', width, needsHardWrap);
      });

      const maxLines = Math.max(
        ...cellLines.map((lines) => lines.length),
        1
      );

      // 单元格内容垂直居中
      const verticalOffsets = cellLines.map((lines) =>
        Math.floor((maxLines - lines.length) / 2)
      );

      const result: string[] = [];
      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        let line = '│';
        for (let colIndex = 0; colIndex < cells.length; colIndex++) {
          const lines = cellLines[colIndex];
          const offset = verticalOffsets[colIndex];
          const contentLineIdx = lineIdx - offset;
          const lineText =
            contentLineIdx >= 0 && contentLineIdx < lines.length
              ? lines[contentLineIdx]
              : '';
          const width = columnWidths[colIndex] || MIN_COLUMN_WIDTH;
          const displayWidth = stringWidth(lineText);
          const aligned = padAligned(
            isHeader ? `\x1b[1m${lineText}\x1b[22m` : lineText,
            displayWidth,
            width,
            isHeader ? 'center' : 'left'
          );
          line += ` ${aligned} │`;
        }
        result.push(line);
      }
      return result;
    }

    // 构建完整表格
    const tableLines: string[] = [];
    tableLines.push(renderBorderLine('top'));
    tableLines.push(...renderRowLines(headers, true));
    tableLines.push(renderBorderLine('middle'));
    rows.forEach((row, rowIndex) => {
      tableLines.push(...renderRowLines(row, false));
      if (rowIndex < rows.length - 1) {
        tableLines.push(renderBorderLine('middle'));
      }
    });
    tableLines.push(renderBorderLine('bottom'));

    // 安全检查：如果最大行宽超出终端宽度，降级为垂直格式
    const maxLineWidth = Math.max(
      ...tableLines.map((line) => stringWidth(line))
    );
    if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
      const separatorWidth = Math.min(terminalWidth - 1, 40);
      const separator = '─'.repeat(separatorWidth);

      return (
        <Text>
          {rows
            .map((row, rowIndex) => {
              const rowLines: string[] = [];
              if (rowIndex > 0) {
                rowLines.push(separator);
              }
              row.forEach((cell, colIndex) => {
                const label = headers[colIndex] || `Column ${colIndex + 1}`;
                const value = (cell || '').replace(/\n+/g, ' ').trim();
                rowLines.push(`\x1b[1m${label}:\x1b[22m ${value}`);
              });
              return rowLines.join('\n');
            })
            .join('\n')}
        </Text>
      );
    }

    return (
      <Text color={theme.colors.text.primary}>
        {tableLines.join('\n')}
      </Text>
    );
  }
);
