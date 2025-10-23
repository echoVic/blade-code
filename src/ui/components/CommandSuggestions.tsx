import { Box, Text } from 'ink';
import React from 'react';
import type { CommandSuggestion } from '../../slash-commands/types.js';

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  visible: boolean;
  maxDisplay?: number;
}

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = React.memo(({
  suggestions,
  selectedIndex,
  visible,
  maxDisplay = 8,
}) => {
  if (!visible || suggestions.length === 0) {
    return null;
  }

  // 计算显示范围，确保选中项总是可见
  let startIndex = 0;
  let endIndex = Math.min(maxDisplay, suggestions.length);

  // 如果选中的是隐藏项提示（超出了建议数量）
  const isMoreItemSelected = selectedIndex >= suggestions.length;

  // 如果选中项超出了显示范围，调整显示窗口
  if (selectedIndex >= maxDisplay && !isMoreItemSelected) {
    startIndex = selectedIndex - maxDisplay + 1;
    endIndex = selectedIndex + 1;
  }

  const displaySuggestions = suggestions.slice(startIndex, endIndex);
  const hasMoreItems = suggestions.length > maxDisplay;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={0}>
      {displaySuggestions.map((suggestion, displayIndex) => {
        const actualIndex = startIndex + displayIndex;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Box key={suggestion.command} justifyContent="space-between" paddingX={1}>
            <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {suggestion.command}
            </Text>
            <Text color={isSelected ? 'cyan' : 'gray'} dimColor={!isSelected}>
              {suggestion.description}
            </Text>
          </Box>
        );
      })}

      {hasMoreItems && (
        <Box paddingX={1}>
          <Text
            color={isMoreItemSelected ? 'cyan' : 'gray'}
            bold={isMoreItemSelected}
            dimColor={!isMoreItemSelected}
          >
            ... and {suggestions.length - maxDisplay} more
          </Text>
        </Box>
      )}
    </Box>
  );
});
