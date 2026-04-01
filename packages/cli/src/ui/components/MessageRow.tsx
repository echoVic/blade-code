import React, { memo } from 'react'
import Box from '../../ink/components/Box.js'
import type { SessionMessage } from '../../store/types.js'
import { MessageRenderer } from './MessageRenderer.js'

type MessageRowProps = {
  message: SessionMessage
  isCollapsed?: boolean
  width: number
}

const MessageRow = memo(function MessageRow({ message, isCollapsed, width }: MessageRowProps) {
  if (isCollapsed) {
    return null
  }
  return (
    <Box flexDirection="column" width={width}>
      <MessageRenderer
        content={message.content}
        role={message.role}
        terminalWidth={width}
        metadata={message.metadata as Record<string, unknown>}
        isPending={false}
        messageId={message.id}
      />
    </Box>
  )
})

export default MessageRow
