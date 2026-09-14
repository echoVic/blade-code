import { Box, type DOMElement, getInnerHeight, getScrollHeight, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import {
  useActiveModal,
  useCurrentFocus,
  useSideConversation,
  useTheme,
} from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useTerminalHeight } from '../hooks/useTerminalHeight.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';
import { useTerminalInput } from '../input/TerminalInputRouter.js';
import { MessageRenderer } from './MessageRenderer.js';

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

export const SideConversationPanel: React.FC = React.memo(() => {
  const sideConversation = useSideConversation();
  const theme = useTheme();
  const terminalWidth = useTerminalWidth();
  const terminalHeight = useTerminalHeight();
  const activeModal = useActiveModal();
  const focus = useCurrentFocus();
  const viewport = useRef<DOMElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const maxContentHeight = Math.max(1, Math.floor(terminalHeight / 2) - 3);
  const hasContent =
    sideConversation?.status === 'error' ||
    (sideConversation?.status === 'completed' && Boolean(sideConversation.response));

  useEffect(() => {
    setScrollTop(0);
  }, [sideConversation?.requestId]);

  useTerminalInput(
    (_input, key) => {
      if (!key.pageDown && !key.pageUp) return false;
      const element = viewport.current;
      if (!element) return false;
      const height = getInnerHeight(element);
      const maximum = Math.max(0, getScrollHeight(element) - height);
      setScrollTop((current) => {
        const actual = Math.min(current, maximum);
        const distance = Math.max(1, height - 1) * (key.pageDown ? 1 : -1);
        return Math.max(0, Math.min(maximum, actual + distance));
      });
      return true;
    },
    {
      isActive:
        Boolean(hasContent) && activeModal === 'none' && focus === FocusId.MAIN_INPUT,
      priority: 30,
    }
  );

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
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold color={theme.colors.info}>
            BTW
          </Text>
          <Text color={theme.colors.muted}>
            {' | '}
            {sideConversation.question.replace(/\s+/g, ' ')}
          </Text>
          {sideConversation.durationMs !== undefined && (
            <Text color={theme.colors.muted} dimColor>
              {' '}
              | {sideConversation.durationMs}ms
            </Text>
          )}
        </Text>
      </Box>

      {sideConversation.status === 'loading' && (
        <Text color={theme.colors.text.secondary}>
          {SPINNER_FRAMES[spinnerFrame]} Answering...
        </Text>
      )}
      {hasContent && (
        <>
          <Box
            ref={viewport}
            flexDirection="column"
            maxHeight={maxContentHeight}
            overflowY="scroll"
            scrollTop={scrollTop}
          >
            <Box flexDirection="column" flexShrink={0} width="100%">
              {sideConversation.status === 'error' ? (
                <Text color={theme.colors.error}>
                  {sideConversation.error ?? 'Side conversation failed'}
                </Text>
              ) : (
                <MessageRenderer
                  content={sideConversation.response ?? ''}
                  role="assistant"
                  terminalWidth={Math.max(1, terminalWidth - 9)}
                  hidePrefix
                  noMargin
                  messageId={`side-conversation-${sideConversation.requestId}`}
                />
              )}
            </Box>
          </Box>
          <Text color={theme.colors.muted} dimColor wrap="truncate-end">
            PgUp/PgDn: scroll side answer
          </Text>
        </>
      )}
    </Box>
  );
});

SideConversationPanel.displayName = 'SideConversationPanel';
