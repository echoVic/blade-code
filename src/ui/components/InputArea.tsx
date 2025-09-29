import { Box, Text } from 'ink';
import React from 'react';

interface InputAreaProps {
  input: string;
  isProcessing: boolean;
}

/**
 * 输入区域组件
 * 显示命令输入框和光标
 */
export const InputArea: React.FC<InputAreaProps> = ({ input, isProcessing }) => {
  return (
    <Box
      flexDirection="row"
      paddingX={2}
      paddingY={0}
      borderStyle="round"
      borderColor="gray"
    >
      <Text color="blue" bold>
        {'> '}
      </Text>
      <Text>{input}</Text>
      {isProcessing ? <Text color="yellow">█</Text> : <Text color="white">█</Text>}
    </Box>
  );
};
