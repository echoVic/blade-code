/**
 * Blockquote 渲染器
 * 使用 ▎ (U+258E) 竖条 + italic 样式显示引用内容
 */

import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';
import { InlineRenderer } from './InlineRenderer.js';

interface BlockquoteRendererProps {
  lines: string[];
  level: number;
}

const BLOCKQUOTE_BAR = '\u258e'; // ▎ left one-quarter block

export const BlockquoteRenderer: React.FC<BlockquoteRendererProps> = React.memo(
  ({ lines, level }) => {
    const theme = useTheme();
    const bar = BLOCKQUOTE_BAR.repeat(level);

    return (
      <Box flexDirection="column">
        {lines.map((line, i) => {
          if (line.trim() === '') {
            return <Box key={i} height={1} />;
          }
          return (
            <Box key={i} flexDirection="row">
              <Text dimColor color={theme.colors.text.muted}>
                {bar}{' '}
              </Text>
              <Text italic wrap="wrap">
                <InlineRenderer text={line} />
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }
);
