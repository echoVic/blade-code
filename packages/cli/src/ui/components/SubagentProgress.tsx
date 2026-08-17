import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { useBladeStore } from '@/store/index.js';
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
  const progressById = useBladeStore((state) => state.app.subagentProgresses);
  const legacyProgress = useBladeStore((state) => state.app.subagentProgress);
  const theme = useTheme();
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const progresses = useMemo(() => {
    const values = Object.values(progressById);
    return values.length > 0 ? values : legacyProgress ? [legacyProgress] : [];
  }, [legacyProgress, progressById]);
  const hasRunning = progresses.some((progress) => progress.status === 'running');

  useEffect(() => {
    if (!hasRunning) {
      setSpinnerFrame(0);
      return;
    }

    const spinnerTimer = setInterval(() => {
      setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);

    const timeTimer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(spinnerTimer);
      clearInterval(timeTimer);
    };
  }, [hasRunning]);

  if (progresses.length === 0) {
    return null;
  }

  return (
    <Box paddingX={2} paddingY={0} flexDirection="column">
      {progresses.map((progress) => {
        const statusIcon =
          progress.status === 'running'
            ? SPINNER_FRAMES[spinnerFrame]
            : progress.status === 'completed'
              ? '[OK]'
              : '[X]';
        const statusColor =
          progress.status === 'running'
            ? theme.colors.info
            : progress.status === 'completed'
              ? theme.colors.success
              : theme.colors.error;
        const elapsedTime = Math.max(0, now - progress.startTime);

        return (
          <Box key={progress.id} flexDirection="row" gap={1}>
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
            {progress.status === 'failed' && progress.terminalSummary && (
              <>
                <Text color={theme.colors.muted}>|</Text>
                <Text color={theme.colors.error}>{progress.terminalSummary}</Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
});
