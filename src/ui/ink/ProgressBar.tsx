/**
 * Ink ProgressBar 组件 - 进度条
 */
import React from 'react';
import { Box } from './Box.js';
import { Text } from './Text.js';

interface ProgressBarProps {
  progress: number; // 0-1 之间的值
  width?: number;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  showPercentage?: boolean;
  style?: React.CSSProperties;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  width = 20,
  color = 'green',
  backgroundColor = 'gray',
  borderColor = 'gray',
  showPercentage = false,
  style,
}) => {
  // 确保进度值在 0-1 范围内
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const filledWidth = Math.floor(width * normalizedProgress);
  const emptyWidth = width - filledWidth;

  // 创建进度条字符
  const filledBar = '█'.repeat(filledWidth);
  const emptyBar = '░'.repeat(emptyWidth);

  return (
    <Box flexDirection="column" style={style}>
      <Box borderColor={borderColor} borderStyle="round" paddingX={1} paddingY={0}>
        <Text color={color}>{filledBar}</Text>
        <Text color={backgroundColor}>{emptyBar}</Text>
      </Box>
      {showPercentage && (
        <Box justifyContent="center" marginTop={1}>
          <Text color="gray">{Math.round(normalizedProgress * 100)}%</Text>
        </Box>
      )}
    </Box>
  );
};
