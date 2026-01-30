/**
 * ThinkingBlock 组件
 * 显示 Thinking 模型（如 DeepSeek R1）的推理过程内容
 *
 * 特性：
 * - 可折叠显示（默认折叠）
 * - 流式接收时显示 "Thinking..." 加载状态
 * - 折叠状态显示摘要（首行前60字符）
 * - Ctrl+T 快捷键控制展开/折叠（在父组件处理）
 */

import { Box, Text } from 'ink';
import React, { useMemo } from 'react';
import { useTheme } from '../../store/selectors/index.js';

interface ThinkingBlockProps {
  /** 思考过程内容 */
  content: string;
  /** 是否正在流式接收 */
  isStreaming?: boolean;
  /** 是否展开显示 */
  isExpanded: boolean;
  /** 展开/折叠回调（可选，用于显示提示） */
  onToggle?: () => void;
}

/**
 * 生成内容摘要
 * @param content 完整内容
 * @param maxLength 最大长度
 * @returns 摘要字符串
 */
function generateSummary(content: string, maxLength = 60): string {
  if (!content) return '';

  // 取第一行
  const firstLine = content.split('\n')[0] || '';
  // 截断到最大长度
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLength)}...`;
}

/**
 * 计算行数
 */
function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

/**
 * ThinkingBlock 组件
 */
export const ThinkingBlock: React.FC<ThinkingBlockProps> = React.memo(
  ({ content, isStreaming = false, isExpanded }) => {
    const theme = useTheme();

    const lineCount = useMemo(() => countLines(content), [content]);
    const summary = useMemo(() => generateSummary(content), [content]);

    // 标题栏颜色：使用 cyan 表示思考过程
    const thinkingColor = theme.colors.info;
    const mutedColor = theme.colors.muted;

    return (
      <Box flexDirection="column" marginBottom={1}>
        {/* 标题栏 */}
        <Box flexDirection="row">
          {/* 展开/折叠指示符 */}
          <Text color={thinkingColor}>{isExpanded ? '▼' : '▶'}</Text>
          <Text> </Text>

          {/* 标题文本 */}
          <Text color={mutedColor}>
            Thinking
            {isStreaming ? '...' : ` (${lineCount} lines)`}
          </Text>

          {/* 折叠状态下显示摘要 */}
          {!isExpanded && !isStreaming && summary && (
            <Text color={mutedColor}> - {summary}</Text>
          )}

          {/* 快捷键提示 */}
          <Text color={mutedColor} dimColor>
            {' '}
            [Ctrl+T]
          </Text>
        </Box>

        {/* 展开内容 */}
        {isExpanded && content && (
          <Box
            marginLeft={2}
            marginTop={1}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            paddingY={0}
          >
            <Text color={mutedColor}>{content}</Text>
          </Box>
        )}
      </Box>
    );
  }
);

ThinkingBlock.displayName = 'ThinkingBlock';
