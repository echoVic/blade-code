import { Box, Text } from 'ink';
import React from 'react';

interface HeaderProps {
  testMode: boolean;
}

/**
 * 应用头部组件
 * 显示应用标题、测试模式标识和退出提示
 */
export const Header: React.FC<HeaderProps> = ({ testMode }) => {
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginBottom={1}
      paddingX={2}
    >
      <Text color="cyan" bold>
        ⚡ Blade Code
      </Text>
      <Box flexDirection="row" gap={2}>
        {testMode && (
          <Text backgroundColor="red" color="white">
            {' '}
            TEST{' '}
          </Text>
        )}
        <Text color="gray" dimColor>
          Press Ctrl+C to exit
        </Text>
      </Box>
    </Box>
  );
};
