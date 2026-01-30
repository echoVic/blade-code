/**
 * 折叠历史消息汇总组件
 *
 * 将多条折叠的历史消息合并为一行显示
 * 格式: ▶ 8 条历史消息 [Ctrl+O 展开]
 */

import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';

interface CollapsedHistorySummaryProps {
  /** 折叠的消息数量 */
  collapsedCount: number;
}

/**
 * 折叠历史汇总组件
 *
 * 只显示一行汇总信息，大幅减少终端渲染负担
 */
export const CollapsedHistorySummary: React.FC<CollapsedHistorySummaryProps> =
  React.memo(({ collapsedCount }) => {
    const theme = useTheme();

    if (collapsedCount <= 0) {
      return null;
    }
    const mutedColor = theme.colors.text.muted;

    return (
      <Box flexDirection="row" marginBottom={1}>
        <Text color={mutedColor}>▶ {collapsedCount} 条历史消息</Text>
        <Text color={mutedColor}> [Ctrl+O 展开]</Text>
      </Box>
    );
  });

CollapsedHistorySummary.displayName = 'CollapsedHistorySummary';
