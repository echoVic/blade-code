/**
 * 会话选择器组件
 * 用于交互式选择历史会话
 */

import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useMemo } from 'react';
import type { SessionMetadata } from '../../services/SessionService.js';

interface SessionSelectorProps {
  sessions: SessionMetadata[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

/**
 * 格式化时间戳为可读格式
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
  if (diffDays === 1) {
    return '昨天';
  }
  if (diffDays < 7) {
    return `${diffDays}天前`;
  }

  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 格式化项目路径（显示项目名称）
 */
function formatProjectPath(projectPath: string): string {
  const parts = projectPath.split('/');
  return parts[parts.length - 1] || projectPath;
}

/**
 * 自定义指示器组件 - 青色高亮
 */
const Indicator: React.FC<any> = ({ isSelected }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯' : ' '}</Text>
  </Box>
);

/**
 * 自定义选项组件 - 选中时青色加粗
 */
const Item: React.FC<any> = ({ isSelected, label }) => (
  <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
    {label}
  </Text>
);

/**
 * 会话选择器组件
 */
export const SessionSelector: React.FC<SessionSelectorProps> = ({
  sessions,
  onSelect,
  onCancel,
}) => {
  // 转换为 SelectInput 的 items 格式
  const items = useMemo(() => {
    return sessions.map((session) => {
      const projectName = formatProjectPath(session.projectPath);
      const timeStr = formatTimestamp(session.lastMessageTime);
      const branchStr = session.gitBranch ? ` (${session.gitBranch})` : '';
      const errorStr = session.hasErrors ? ' ⚠️' : '';

      return {
        label: `📅 ${timeStr} | ${projectName}${branchStr} | ${session.messageCount} 条消息${errorStr}`,
        value: session.sessionId,
      };
    });
  }, [sessions]);

  const handleSelect = (item: { label: string; value: string }) => {
    onSelect(item.value);
  };

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠️  没有找到历史会话</Text>
        <Text dimColor>
          {'\n'}提示: 开始一次对话后，会话历史将保存到 ~/.blade/projects/
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        📂 选择要恢复的会话:
      </Text>
      <Text dimColor>{'\n'}(↑↓ 选择 | Enter 确认 | Ctrl+C 取消){'\n'}</Text>

      <SelectInput
        items={items}
        onSelect={handleSelect}
        indicatorComponent={Indicator}
        itemComponent={Item}
      />

      <Text dimColor>{'\n'}共 {sessions.length} 个历史会话</Text>
    </Box>
  );
};
