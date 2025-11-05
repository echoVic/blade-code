import { Box, Text } from 'ink';
import React from 'react';

/**
 * 快捷键帮助组件
 * 显示所有可用的快捷键
 *
 * 注意：关闭操作由 useMainInput 处理（通过 ? 或 Esc 键）想·
 */
export const ShortcutsHelp: React.FC = () => {
  const shortcuts = [
    { key: 'Enter', description: '发送消息' },
    { key: 'Shift+Enter', description: '换行（多行输入）' },
    { key: 'Esc', description: '中止当前任务' },
    { key: 'Shift+Tab', description: '切换权限模式 (Default → Auto-Edit → Plan)' },
    { key: 'Ctrl+C', description: '退出应用' },
    { key: '↑ / ↓', description: '浏览历史命令' },
    { key: 'Tab', description: '自动补全斜杠命令' },
    { key: 'Ctrl+A', description: '移动到行首' },
    { key: 'Ctrl+E', description: '移动到行尾' },
    { key: 'Ctrl+K', description: '删除到行尾' },
    { key: 'Ctrl+U', description: '删除到行首' },
    { key: 'Ctrl+W', description: '删除前一个单词' },
    { key: '?', description: '显示此帮助' },
  ];

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor="cyan">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⌨️  快捷键帮助
        </Text>
      </Box>

      {shortcuts.map((shortcut, index) => (
        <Box key={index} marginY={0}>
          <Box width={20}>
            <Text bold color="yellow">
              {shortcut.key}
            </Text>
          </Box>
          <Text color="white">{shortcut.description}</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text color="gray">按 Esc 或 ? 关闭此帮助</Text>
      </Box>
    </Box>
  );
};
