import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React, { useEffect, useState } from 'react';

interface InputAreaProps {
  input: string;
  isProcessing: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

/**
 * 加载动画帧
 * 使用 Braille 点字符创建平滑的旋转动画
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 输入区域组件
 * 使用 TextInput 组件处理光标和基本编辑
 */
export const InputArea: React.FC<InputAreaProps> = ({
  input,
  isProcessing,
  onChange,
  onSubmit,
}) => {
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // 动画效果：每 80ms 切换一帧
  useEffect(() => {
    if (!isProcessing) {
      setSpinnerFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => clearInterval(timer);
  }, [isProcessing]);

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
      {isProcessing && <Text color="yellow"> {SPINNER_FRAMES[spinnerFrame]}</Text>}
    </Box>
  );
};
