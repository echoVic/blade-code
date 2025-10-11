import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

interface InputAreaProps {
  input: string;
  isProcessing: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

/**
 * 输入区域组件
 * 显示命令输入框和光标
 */
export const InputArea: React.FC<InputAreaProps> = ({
  input,
  isProcessing,
  onChange,
  onSubmit,
}) => {
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
      {onChange && onSubmit ? (
        <TextInput
          value={input}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="输入命令..."
          showCursor={!isProcessing}
        />
      ) : (
        <>
          <Text>{input}</Text>
          {isProcessing ? <Text color="yellow">█</Text> : <Text color="white">█</Text>}
        </>
      )}
    </Box>
  );
};
