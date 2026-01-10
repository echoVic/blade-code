import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';

interface TodoPanelProps {
  todos: TodoItem[];
  visible?: boolean;
  compact?: boolean;
}

/**
 * TODO 任务面板组件
 * 极简设计,清晰的层次感,最少的视觉干扰
 */
export const TodoPanel: React.FC<TodoPanelProps> = React.memo(
  ({ todos, visible = true, compact = false }) => {
    const { colors } = useTheme();

    if (!visible || todos.length === 0) {
      return null;
    }

    const stats = {
      total: todos.length,
      completed: todos.filter((t) => t.status === 'completed').length,
      inProgress: todos.filter((t) => t.status === 'in_progress').length,
    };

    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={colors.border.light}
        paddingX={1}
        paddingY={compact ? 0 : 1}
        marginBottom={1}
      >
        {/* 标题 - 极简风格 */}
        <Box marginBottom={compact ? 0 : 1}>
          <Text dimColor>Tasks </Text>
          <Text color={colors.text.muted}>
            {stats.completed}/{stats.total}
          </Text>
        </Box>

        {/* 任务列表 */}
        <Box flexDirection="column">
          {todos.map((todo, index) => (
            <TodoRow key={todo.id || index} todo={todo} compact={compact} />
          ))}
        </Box>
      </Box>
    );
  }
);

interface TodoRowProps {
  todo: TodoItem;
  compact?: boolean;
}

const TodoRow: React.FC<TodoRowProps> = React.memo(({ todo, compact }) => {
  // 简约符号：✓ (completed), ▶ (in progress), ○ (pending)
  let icon: string;
  let dimmed = false;
  let text: string;

  switch (todo.status) {
    case 'completed':
      icon = '✓';
      dimmed = true;
      text = todo.content;
      break;
    case 'in_progress':
      icon = '▶';
      dimmed = false;
      text = todo.activeForm;
      break;
    case 'pending':
    default:
      icon = '○';
      dimmed = true;
      text = todo.content;
      break;
  }

  return (
    <Box paddingY={compact ? 0 : 0}>
      <Text dimColor={dimmed}>
        {icon} {text}
      </Text>
    </Box>
  );
});
