import { Box, Text } from 'ink';
import React from 'react';
import type { CommandSuggestion } from '../../slash-commands/types.js';

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  visible: boolean;
  maxDisplay?: number;
}

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  suggestions,
  selectedIndex,
  visible,
  maxDisplay = 8,
}) => {
  if (!visible || suggestions.length === 0) {
    return null;
  }

  const displaySuggestions = suggestions.slice(0, maxDisplay);

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={0}
    >
      {displaySuggestions.map((suggestion, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Box
            key={suggestion.command}
            justifyContent="space-between"
            paddingX={1}
          >
            <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {suggestion.command}
            </Text>
            <Text color={isSelected ? 'cyan' : 'gray'} dimColor={!isSelected}>
              {suggestion.description}
            </Text>
          </Box>
        );
      })}

      {suggestions.length > maxDisplay && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            ... and {suggestions.length - maxDisplay} more
          </Text>
        </Box>
      )}
    </Box>
  );
};
