/**
 * Markdown 列表项渲染器
 * 支持有序列表和无序列表，以及嵌套列表
 */

import { Box, Text } from 'ink';
import React from 'react';
import { InlineRenderer } from './InlineRenderer.js';

interface ListItemProps {
  /** 列表项文本内容 */
  itemText: string;
  /** 列表类型：有序 (ol) 或无序 (ul) */
  type: 'ul' | 'ol';
  /** 列表标记（如 '-', '*', '+', '1', '2' 等） */
  marker: string;
  /** 前导空格（用于计算嵌套层级） */
  leadingWhitespace?: string;
}

/**
 * 列表项组件
 *
 * 支持：
 * - 无序列表：`- 项目` / `* 项目` / `+ 项目`
 * - 有序列表：`1. 项目` / `2. 项目`
 * - 嵌套列表（通过前导空格计算缩进层级）
 * - 列表项内容支持内联 Markdown 格式
 *
 * @example
 * // 无序列表
 * <ListItem type="ul" marker="-" itemText="列表项 1" />
 *
 * // 有序列表
 * <ListItem type="ol" marker="1" itemText="第一项" />
 *
 * // 嵌套列表
 * <ListItem type="ul" marker="-" itemText="子项" leadingWhitespace="  " />
 */
const ListItemInternal: React.FC<ListItemProps> = ({
  itemText,
  type,
  marker,
  leadingWhitespace = '',
}) => {
  // 构造前缀（有序列表：'1. '，无序列表：'- '）
  const prefix = type === 'ol' ? `${marker}. ` : `${marker} `;
  const prefixWidth = prefix.length;

  // 计算缩进层级（每 2 个空格为一层）
  const indentation = leadingWhitespace.length;

  return (
    <Box paddingLeft={indentation + 1} flexDirection="row">
      {/* 列表标记 */}
      <Box width={prefixWidth}>
        <Text>{prefix}</Text>
      </Box>

      {/* 列表项内容（支持内联 Markdown） */}
      <Box flexGrow={1}>
        <Text wrap="wrap">
          <InlineRenderer text={itemText} />
        </Text>
      </Box>
    </Box>
  );
};

export const ListItem = React.memo(ListItemInternal);
