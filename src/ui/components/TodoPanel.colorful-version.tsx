import { Box, Text } from 'ink';
import React from 'react';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import { useThemeColors } from '../hooks/useTheme.js';
import type { BaseColors } from '../themes/types.js';

interface TodoPanelProps {
  todos: TodoItem[];
  visible?: boolean;
  compact?: boolean;
}

/**
 * TODO 任务面板组件 - 彩色复杂版本（已废弃，保留作为参考）
 *
 * 这是原始的 Neovate 风格彩色版本，包含：
 * - 彩色进度百分比
 * - 优先级标签 (P0/P1/P2)
 * - 多色状态指示
 * - Emoji 装饰
 *
 * 当前使用的是简约版本 TodoPanel.tsx
 */
export const TodoPanel: React.FC<TodoPanelProps> = ({
  todos,
  visible = true,
  compact = false,
}) => {
  const colors = useThemeColors();

  if (!visible || todos.length === 0) {
    return null;
  }

  const stats = {
    total: todos.length,
    completed: todos.filter((t) => t.status === 'completed').length,
    inProgress: todos.filter((t) => t.status === 'in_progress').length,
    pending: todos.filter((t) => t.status === 'pending').length,
  };

  const percentage =
    stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  // 根据完成率选择颜色（使用主题颜色）
  const progressColor =
    percentage === 100
      ? colors.success
      : percentage >= 50
        ? colors.info
        : colors.warning;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border.light}
      paddingX={1}
      paddingY={compact ? 0 : 1}
      marginBottom={1}
    >
      {/* 标题和统计 */}
      <Box marginBottom={compact ? 0 : 1}>
        <Text bold color={colors.primary}>
          📋 TODO{' '}
        </Text>
        <Text color={progressColor}>
          ({stats.completed}/{stats.total} 完成，{percentage}%)
        </Text>
      </Box>

      {/* 任务列表 */}
      <Box flexDirection="column">
        {todos.map((todo, index) => (
          <TodoRow
            key={todo.id || index}
            todo={todo}
            colors={colors}
            compact={compact}
          />
        ))}
      </Box>

      {/* 底部提示 */}
      {!compact && stats.inProgress > 0 && (
        <Box marginTop={1}>
          <Text dimColor> ⚡ 正在进行</Text>
        </Box>
      )}
    </Box>
  );
};

interface TodoRowProps {
  todo: TodoItem;
  colors: BaseColors;
  compact?: boolean;
}

const TodoRow: React.FC<TodoRowProps> = ({ todo, colors, compact }) => {
  const icon = todo.status === 'completed' ? '☑' : '☐';

  const priorityLabel = `(P${todo.priority === 'high' ? 0 : todo.priority === 'medium' ? 1 : 2})`;

  const statusFlag = todo.status === 'in_progress' ? ' ⚡' : '';

  // 根据状态选择颜色（使用主题颜色）
  let color: string;
  let strikethrough = false;

  switch (todo.status) {
    case 'completed':
      color = colors.success;
      strikethrough = true;
      break;
    case 'in_progress':
      color = colors.info;
      break;
    case 'pending':
      color = colors.text.muted;
      break;
    default:
      color = colors.text.primary;
  }

  // 优先级颜色（使用主题颜色）
  const priorityColor =
    todo.priority === 'high'
      ? colors.error
      : todo.priority === 'medium'
        ? colors.warning
        : colors.muted;

  const content = `${icon} ${todo.content}${statusFlag}`;

  return (
    <Box paddingY={compact ? 0 : 0}>
      <Text color={priorityColor}>{priorityLabel} </Text>
      <Text color={color} strikethrough={strikethrough}>
        {content}
      </Text>
    </Box>
  );
};
