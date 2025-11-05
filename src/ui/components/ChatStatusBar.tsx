import { Box, Text } from 'ink';
import React from 'react';
import { PermissionMode } from '../../config/types.js';

interface ChatStatusBarProps {
  hasApiKey: boolean;
  isProcessing: boolean;
  permissionMode: PermissionMode;
  showShortcuts: boolean;
}

/**
 * 聊天状态栏组件
 * 显示权限模式、快捷键提示、API状态和处理状态
 */
export const ChatStatusBar: React.FC<ChatStatusBarProps> = React.memo(
  ({ hasApiKey, isProcessing, permissionMode, showShortcuts }) => {
    // 渲染模式提示（仅非 DEFAULT 模式显示）
    const renderModeIndicator = () => {
      if (permissionMode === PermissionMode.DEFAULT) {
        return null; // DEFAULT 模式不显示任何提示
      }

      if (permissionMode === PermissionMode.AUTO_EDIT) {
        return (
          <Text color="magenta">
            ▶▶ auto edit on <Text color="gray">(shift+tab to cycle)</Text>
          </Text>
        );
      }

      if (permissionMode === PermissionMode.PLAN) {
        return (
          <Text color="cyan">
            ‖ plan mode on <Text color="gray">(shift+tab to cycle)</Text>
          </Text>
        );
      }

      if (permissionMode === PermissionMode.YOLO) {
        return (
          <Text color="red">
            ⚡ yolo mode on <Text color="gray">(all tools auto-approved)</Text>
          </Text>
        );
      }

      return null;
    };

    const modeIndicator = renderModeIndicator();
    const hasModeIndicator = modeIndicator !== null;

    // 快捷键列表 - 紧凑三列布局
    const shortcutRows = [
      ['Enter:发送', 'Shift+Enter:换行', 'Esc:中止'],
      ['Shift+Tab:切换模式', '↑/↓:历史', 'Tab:补全'],
      ['Ctrl+A:行首', 'Ctrl+E:行尾', 'Ctrl+K:删到尾'],
      ['Ctrl+U:删到首', 'Ctrl+W:删单词', 'Ctrl+C:退出'],
    ];

    return (
      <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={0}>
        {showShortcuts ? (
          <Box flexDirection="column" gap={0}>
            {shortcutRows.map((row, rowIndex) => (
              <Box key={rowIndex} flexDirection="row">
                {row.map((shortcut, index) => {
                  const [key, desc] = shortcut.split(':');
                  return (
                    <Box key={index} flexDirection="row" width={20}>
                      <Text color="yellow">{key}</Text>
                      <Text color="gray">:</Text>
                      <Text color="white">{desc}</Text>
                    </Box>
                  );
                })}
                {rowIndex === shortcutRows.length - 1 && (
                  <Text color="cyan">  ? 关闭</Text>
                )}
              </Box>
            ))}
          </Box>
        ) : (
          <Box flexDirection="row" gap={1}>
            {modeIndicator}
            {hasModeIndicator && <Text color="gray">·</Text>}
            <Text color="gray">? for shortcuts</Text>
          </Box>
        )}
        {!hasApiKey ? (
          <Text color="red">⚠ API 密钥未配置</Text>
        ) : isProcessing ? (
          <Text color="yellow">Processing...</Text>
        ) : (
          <Text color="green">Ready</Text>
        )}
      </Box>
    );
  }
);
