import { Box, Text } from 'ink';
import React from 'react';
import { useTeams, useTheme } from '../../store/selectors/index.js';

const STATUS_ICON = {
  idle: '-',
  running: '>',
  completed: '[OK]',
  failed: '[X]',
  deleted: '[X]',
  leader: '*',
  cancelled: '[X]',
  unknown: '?',
  pending: '-',
  blocked: 'x',
} as const;

export const TeamProgress: React.FC = React.memo(() => {
  const teams = useTeams().filter((team) => team.status !== 'deleted');
  const theme = useTheme();

  if (teams.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={2}>
      {teams.map((team) => {
        const completed = team.tasks.filter(
          (task) => task.status === 'completed'
        ).length;
        return (
          <Box key={team.name} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text
                bold
                color={
                  team.status === 'failed'
                    ? theme.colors.error
                    : team.status === 'completed'
                      ? theme.colors.success
                      : theme.colors.info
                }
              >
                {STATUS_ICON[team.status]} Team
              </Text>
              <Text bold color={theme.colors.text.primary}>
                {team.name}
              </Text>
              <Text color={theme.colors.muted}>
                | {team.members.length - 1} members | {completed}/{team.tasks.length}{' '}
                tasks
              </Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {team.members
                .filter((member) => member.status !== 'leader')
                .map((member) => (
                  <Box key={member.id} gap={1}>
                    <Text color={theme.colors.muted}>{STATUS_ICON[member.status]}</Text>
                    <Text color={theme.colors.text.secondary}>{member.name}</Text>
                    <Text color={theme.colors.muted}>
                      ({member.subagentType}, {member.status}
                      {member.worktreePath ? ', worktree' : ''})
                    </Text>
                  </Box>
                ))}
              {team.tasks.map((task) => (
                <Box key={task.id} gap={1}>
                  <Text color={theme.colors.muted}>{STATUS_ICON[task.status]}</Text>
                  <Text color={theme.colors.text.secondary}>
                    #{task.id} {task.subject}
                  </Text>
                  <Text color={theme.colors.muted}>
                    ({task.status}
                    {task.owner ? `, ${task.owner}` : ''})
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
});

TeamProgress.displayName = 'TeamProgress';
