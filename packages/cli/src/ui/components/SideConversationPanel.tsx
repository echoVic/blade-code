import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { useSideConversation, useTheme } from '../../store/selectors/index.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { MessageRenderer } from './MessageRenderer.js';

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

export const SideConversationPanel: React.FC = React.memo(() => {
  const sideConversation = useSideConversation();
  const theme = useTheme();
  const terminalWidth = useTerminalWidth();
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  useEffect(() => {
    if (sideConversation?.status !== 'loading') {
      setSpinnerFrame(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(timer);
  }, [sideConversation?.status]);

  if (!sideConversation) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.info}
      marginX={2}
      marginBottom={1}
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.colors.info}>
          BTW
        </Text>
        <Text color={theme.colors.muted}> | {sideConversation.question}</Text>
        {sideConversation.durationMs !== undefined && (
          <Text color={theme.colors.muted} dimColor>
            {' '}
            | {sideConversation.durationMs}ms
          </Text>
        )}
      </Box>

      {sideConversation.status === 'loading' && (
        <Text color={theme.colors.text.secondary}>
          {SPINNER_FRAMES[spinnerFrame]} Answering...
        </Text>
      )}
      {sideConversation.status === 'error' && (
        <Text color={theme.colors.error}>
          {sideConversation.error ?? 'Side conversation failed'}
        </Text>
      )}
      {sideConversation.status === 'completed' && sideConversation.response && (
        <MessageRenderer
          content={sideConversation.response}
          role="assistant"
          terminalWidth={Math.max(20, terminalWidth - 8)}
          hidePrefix
          noMargin
          messageId={`side-conversation-${sideConversation.requestId}`}
        />
      )}
    </Box>
  );
});

SideConversationPanel.displayName = 'SideConversationPanel';
