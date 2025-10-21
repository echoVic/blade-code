/**
 * 会话选择器组件
 * 用于交互式选择历史会话
 */

import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useEffect, useMemo, useState } from 'react';
import { type SessionMetadata, SessionService } from '../../services/SessionService.js';
import { FocusId, useFocusContext } from '../contexts/FocusContext.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

interface SessionSelectorProps {
  sessions?: SessionMetadata[]; // 可选，如果不提供则自动加载
  onSelect: (sessionId: string) => void;
  onCancel?: () => void; // 可选，用于 --resume CLI 模式，在 /resume 斜杠命令模式下由全局处理器处理
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
  sessions: propSessions,
  onSelect,
  onCancel,
}) => {
  const [loadedSessions, setLoadedSessions] = useState<SessionMetadata[]>([]);
  const [loading, setLoading] = useState(false);

  // 使用 FocusContext 管理焦点
  const { state: focusState } = useFocusContext();
  const isFocused = focusState.currentFocus === FocusId.SESSION_SELECTOR;

  // 使用智能 Ctrl+C 处理（没有任务，所以直接退出）
  const handleCtrlC = useCtrlCHandler(false);

  // 处理键盘输入
  useInput(
    (input, key) => {
      // Ctrl+C 或 Cmd+C: 智能退出应用
      if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        handleCtrlC();
        return;
      }

      // Esc: 调用 onCancel 关闭选择器
      if (key.escape && onCancel) {
        onCancel();
      }
    },
    { isActive: isFocused } // 只在有焦点时激活
  );

  // 如果没有提供 sessions，则自动加载
  useEffect(() => {
    if (propSessions) {
      setLoadedSessions(propSessions);
      return;
    }

    const loadSessions = async () => {
      setLoading(true);
      try {
        const sessions = await SessionService.listSessions();
        setLoadedSessions(sessions);
      } catch (error) {
        console.error('[SessionSelector] Failed to load sessions:', error);
        setLoadedSessions([]);
      } finally {
        setLoading(false);
      }
    };

    loadSessions();
  }, [propSessions]);

  const sessions = propSessions || loadedSessions;

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

  if (loading) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>⏳ 正在加载会话列表...</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠️ 没有找到历史会话</Text>
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
      <Text dimColor>
        {'\n'}(↑↓ 选择 | Enter 确认 | Esc 取消 | Ctrl+C 退出){'\n'}
      </Text>

      <SelectInput
        items={items}
        onSelect={handleSelect}
        indicatorComponent={Indicator}
        itemComponent={Item}
      />

      <Text dimColor>
        {'\n'}共 {sessions.length} 个历史会话
      </Text>
    </Box>
  );
};
