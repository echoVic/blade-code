import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

interface InputAreaProps {
  input: string;
  isProcessing: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

/**
 * 输入区域组件
 * 使用 TextInput 组件处理光标和基本编辑
 * 注意：加载动画已移至 LoadingIndicator 组件，显示在输入框上方
 */
export const InputArea: React.FC<InputAreaProps> = React.memo(
  ({ input, isProcessing, onChange, onSubmit }) => {
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
        <TextInput
          value={input}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder=" 输入命令..."
          showCursor={!isProcessing}
          focus={true}
        />
      </Box>
    );
  },
  (prevProps, nextProps) => {
    // 返回 true 表示 props 相同（跳过重渲染）
    return (
      prevProps.input === nextProps.input &&
      prevProps.isProcessing === nextProps.isProcessing
      // onChange 和 onSubmit 是函数引用，通常不变
    );
  }
);
