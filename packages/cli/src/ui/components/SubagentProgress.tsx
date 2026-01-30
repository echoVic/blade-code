import { useBladeStore } from '@/store/index.js';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { useTheme } from '../../store/selectors/index.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export const SubagentProgress: React.FC = React.memo(() => {
  const progress = useBladeStore((state) => state.app.subagentProgress);
  const theme = useTheme();
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (!progress || progress.status !== 'running') {
      setSpinnerFrame(0);
      setElapsedTime(0);
      return;
    }

    const spinnerTimer = setInterval(() => {
      setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);

    const timeTimer = setInterval(() => {
      setElapsedTime(Date.now() - progress.startTime);
    }, 1000);

    return () => {
      clearInterval(spinnerTimer);
      clearInterval(timeTimer);
    };
  }, [progress]);

  if (!progress) {
    return null;
  }

  const statusIcon =
    progress.status === 'running'
      ? SPINNER_FRAMES[spinnerFrame]
      : progress.status === 'completed'
        ? '✓'
        : '✗';

  const statusColor =
    progress.status === 'running'
      ? theme.colors.info
      : progress.status === 'completed'
        ? theme.colors.success
        : theme.colors.error;

  return (
    <Box paddingX={2} paddingY={0} flexDirection="row" gap={1}>
      <Text color={statusColor} bold>
        {statusIcon}
      </Text>
      <Text color={theme.colors.muted}>Subagent</Text>
      <Text color={theme.colors.text.primary} bold>
        {progress.type}
      </Text>
      <Text color={theme.colors.muted}>|</Text>
      <Text color={theme.colors.text.secondary}>{progress.description}</Text>
      {progress.currentTool && (
        <>
          <Text color={theme.colors.muted}>|</Text>
          <Text color={theme.colors.warning}>{progress.currentTool}</Text>
        </>
      )}
      {progress.status === 'running' && elapsedTime > 0 && (
        <>
          <Text color={theme.colors.muted}>|</Text>
          <Text color={theme.colors.info}>{formatElapsedTime(elapsedTime)}</Text>
        </>
      )}
    </Box>
  );
});
