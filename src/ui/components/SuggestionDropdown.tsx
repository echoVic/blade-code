/**
 * @ 文件建议下拉菜单组件
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface SuggestionItem {
  /** 文件路径 */
  path: string;
  /** 是否被选中 */
  selected: boolean;
}

export interface SuggestionDropdownProps {
  /** 建议列表 */
  items: SuggestionItem[];
  /** 是否显示 */
  visible: boolean;
  /** 最大显示数量，默认 10 */
  maxVisible?: number;
}

/**
 * @ 文件建议下拉菜单
 *
 * 用于显示 @ 文件提及的自动补全建议
 */
export function SuggestionDropdown({
  items,
  visible,
  maxVisible = 10,
}: SuggestionDropdownProps) {
  if (!visible || items.length === 0) {
    return null;
  }

  // 限制显示数量
  const visibleItems = items.slice(0, maxVisible);
  const hasMore = items.length > maxVisible;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          📁 File Suggestions
        </Text>
      </Box>

      {visibleItems.map((item, index) => (
        <Box key={item.path} paddingLeft={1}>
          {item.selected ? (
            <Text color="green" bold>
              ▶ {item.path}
            </Text>
          ) : (
            <Text color="gray">  {item.path}</Text>
          )}
        </Box>
      ))}

      {hasMore && (
        <Box marginTop={1} paddingLeft={1}>
          <Text color="gray" dimColor>
            ... and {items.length - maxVisible} more
          </Text>
        </Box>
      )}

      <Box marginTop={1} borderTop borderColor="gray">
        <Text color="gray" dimColor>
          ↑↓ Navigate • Tab/Enter Select • Esc Cancel
        </Text>
      </Box>
    </Box>
  );
}

/**
 * 简化的建议列表（仅显示路径）
 */
export interface SimpleSuggestionListProps {
  /** 建议路径数组 */
  suggestions: string[];
  /** 选中的索引 */
  selectedIndex: number;
  /** 最大显示数量 */
  maxVisible?: number;
}

export function SimpleSuggestionList({
  suggestions,
  selectedIndex,
  maxVisible = 10,
}: SimpleSuggestionListProps) {
  const items: SuggestionItem[] = suggestions.map((path, index) => ({
    path,
    selected: index === selectedIndex,
  }));

  return (
    <SuggestionDropdown items={items} visible={true} maxVisible={maxVisible} />
  );
}
