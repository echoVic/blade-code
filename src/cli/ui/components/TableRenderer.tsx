/**
 * 表格渲染器 - 支持 Markdown 表格
 */
import React from 'react';
import { Box, Text } from 'ink';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

/**
 * 计算列宽
 */
function calculateColumnWidths(headers: string[], rows: string[][], maxWidth: number): number[] {
  const columnCount = headers.length;
  const minWidths = headers.map(header => Math.max(header.length, 3)); // 最小宽度
  
  // 考虑所有行的内容
  rows.forEach(row => {
    row.forEach((cell, index) => {
      if (index < minWidths.length) {
        minWidths[index] = Math.max(minWidths[index], cell.length);
      }
    });
  });
  
  const totalMinWidth = minWidths.reduce((sum, width) => sum + width, 0);
  const separatorWidth = columnCount * 3 + 1; // 每列间隔3字符（' | '）+ 边框
  
  if (totalMinWidth + separatorWidth <= maxWidth) {
    return minWidths;
  }
  
  // 如果超出宽度，等比例压缩
  const availableWidth = maxWidth - separatorWidth;
  const ratio = availableWidth / totalMinWidth;
  
  return minWidths.map(width => Math.max(3, Math.floor(width * ratio)));
}

/**
 * 截断文本到指定长度
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 1) + '…';
}

/**
 * 表格渲染器组件
 */
export const TableRenderer: React.FC<TableRendererProps> = ({
  headers,
  rows,
  terminalWidth,
}) => {
  const maxTableWidth = Math.floor(terminalWidth * 0.9);
  const columnWidths = calculateColumnWidths(headers, rows, maxTableWidth);
  
  if (columnWidths.length === 0 || headers.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="gray" paddingX={1}>
      {/* 标题行 */}
      <Box flexDirection="row">
        {headers.map((header, index) => (
          <React.Fragment key={index}>
            <Box width={columnWidths[index]} justifyContent="center">
              <Text bold color="cyan">
                {truncateText(header, columnWidths[index])}
              </Text>
            </Box>
            {index < headers.length - 1 && (
              <Box width={3} justifyContent="center">
                <Text color="gray"> | </Text>
              </Box>
            )}
          </React.Fragment>
        ))}
      </Box>
      
      {/* 分隔线 */}
      <Box flexDirection="row">
        {headers.map((_, index) => (
          <React.Fragment key={index}>
            <Box width={columnWidths[index]} justifyContent="center">
              <Text color="gray">
                {'─'.repeat(columnWidths[index])}
              </Text>
            </Box>
            {index < headers.length - 1 && (
              <Box width={3} justifyContent="center">
                <Text color="gray">─┼─</Text>
              </Box>
            )}
          </React.Fragment>
        ))}
      </Box>
      
      {/* 数据行 */}
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} flexDirection="row">
          {row.map((cell, cellIndex) => (
            <React.Fragment key={cellIndex}>
              <Box width={columnWidths[cellIndex]} justifyContent="flex-start">
                <Text>
                  {truncateText(cell || '', columnWidths[cellIndex])}
                </Text>
              </Box>
              {cellIndex < headers.length - 1 && (
                <Box width={3} justifyContent="center">
                  <Text color="gray"> | </Text>
                </Box>
              )}
            </React.Fragment>
          ))}
        </Box>
      ))}
    </Box>
  );
};