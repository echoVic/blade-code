import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../../store/selectors/index.js';
import type { TaskListItem } from '../../tools/builtin/task/taskListTypes.js';

interface TaskPanelProps {
  tasks: TaskListItem[];
  visible?: boolean;
  compact?: boolean;
}

/**
 * Task 任务面板组件
 * 极简设计,清晰的层次感,最少的视觉干扰
 */
export const TaskPanel: React.FC<TaskPanelProps> = React.memo(
  ({ tasks, visible = true, compact = false }) => {
    const { colors } = useTheme();

    if (!visible || tasks.length === 0) {
      return null;
    }

    const stats = {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
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
          {tasks.map((task, index) => (
            <TaskRow key={task.id || index} task={task} compact={compact} />
          ))}
        </Box>
      </Box>
    );
  }
);

interface TaskRowProps {
  task: TaskListItem;
  compact?: boolean;
}

const TaskRow: React.FC<TaskRowProps> = React.memo(({ task, compact }) => {
  // Symbols: [OK] (completed), > (in progress), - (pending)
  let icon: string;
  let dimmed = false;
  let text: string;

  switch (task.status) {
    case 'completed':
      icon = '[OK]';
      dimmed = true;
      text = task.subject;
      break;
    case 'in_progress':
      icon = '>';
      dimmed = false;
      text = task.activeForm || task.subject;
      break;
    case 'pending':
    default:
      icon = '-';
      dimmed = true;
      text = task.subject;
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
