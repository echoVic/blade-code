import { Box, Text } from 'ink';
import React from 'react';

interface ChatStatusBarProps {
  messageCount: number;
  hasApiKey: boolean;
  isProcessing: boolean;
}

/**
 * 聊天状态栏组件
 * 显示消息计数、API状态和处理状态
 */
export const ChatStatusBar: React.FC<ChatStatusBarProps> = ({
  messageCount,
  hasApiKey,
  isProcessing,
}) => {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={0}>
      <Box flexDirection="row" gap={2}>
        {messageCount > 0 && (
          <Text color="gray" dimColor>
            {messageCount} messages
          </Text>
        )}
      </Box>
      {!hasApiKey ? (
        <Text color="red">⚠ API 密钥未配置</Text>
      ) : isProcessing ? (
        <Text color="yellow">Processing...</Text>
      ) : (
        <Text color="green">Ready</Text>
      )}
    </Box>
  );
};