import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import React from 'react';

interface HeaderProps {
  testMode: boolean;
  useBigText?: boolean; // 是否使用大标题
}

/**
 * 应用头部组件
 * 显示应用标题、测试模式标识和退出提示
 */
export const Header: React.FC<HeaderProps> = ({ testMode, useBigText = false }) => {
  // 渲染大标题版本
  if (useBigText) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Gradient name="rainbow">
          <BigText text="BLADE" font="block" />
        </Gradient>
        <Box flexDirection="row" justifyContent="space-between" paddingX={2}>
          <Text color="cyan">⚡ 现代化 AI 编码助手</Text>
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
      </Box>
    );
  }

  // 渲染紧凑版本
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginBottom={1}
      paddingX={2}
    >
      <Gradient name="pastel">
        <Text bold>⚡ Blade Code</Text>
      </Gradient>
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
