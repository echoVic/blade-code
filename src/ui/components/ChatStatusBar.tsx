import { Box, Text } from 'ink';
import React from 'react';
import { PermissionMode } from '../../config/types.js';

interface ChatStatusBarProps {
  messageCount: number;
  hasApiKey: boolean;
  isProcessing: boolean;
  permissionMode: PermissionMode;
}

/**
 * 聊天状态栏组件
 * 显示消息计数、API状态和处理状态
 */
export const ChatStatusBar: React.FC<ChatStatusBarProps> = React.memo(({
  messageCount,
  hasApiKey,
  isProcessing,
  permissionMode,
}) => {
  // 渲染模式提示（仅非 DEFAULT 模式显示）
  const renderModeIndicator = () => {
    if (permissionMode === PermissionMode.DEFAULT) {
      return null; // DEFAULT 模式不显示任何提示
    }

    if (permissionMode === PermissionMode.AUTO_EDIT) {
      return (
        <Text color="magenta">▶▶ auto edit on <Text color="gray">(shift+tab to cycle)</Text></Text>
      );
    }

    if (permissionMode === PermissionMode.PLAN) {
      return (
        <Text color="cyan">‖ plan mode on <Text color="gray">(shift+tab to cycle)</Text></Text>
      );
    }

    if (permissionMode === PermissionMode.YOLO) {
      return (
        <Text color="red">⚡ yolo mode on <Text color="gray">(all tools auto-approved)</Text></Text>
      );
    }

    return null;
  };

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={0}>
      <Box flexDirection="row" gap={2}>
        {renderModeIndicator()}
        {messageCount > 0 && <Text color="white">{messageCount} messages</Text>}
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
});
