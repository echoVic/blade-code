import React from 'react'
import Box from '../../ink/components/Box.js'
import Text from '../../ink/components/Text.js'
import type { SessionMessage } from '../../store/types.js'
import { MessageRenderer } from './MessageRenderer.js'

type StreamingTailProps = {
  streamingMessage: SessionMessage | null
  thinkingContent: string
  width: number
}

export default function StreamingTail({ streamingMessage, thinkingContent, width }: StreamingTailProps) {
  if (!streamingMessage) return null

  return (
    <Box flexDirection="column" width={width}>
      {thinkingContent && (
        <Box marginBottom={1}>
          <Text dimColor italic>{thinkingContent}</Text>
        </Box>
      )}
      <MessageRenderer
        content={streamingMessage.content}
        role={streamingMessage.role}
        terminalWidth={width}
        metadata={streamingMessage.metadata as Record<string, unknown>}
        isPending={true}
        messageId={streamingMessage.id}
      />
    </Box>
  )
}
