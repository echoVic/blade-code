import React, { useRef } from 'react'
import Box from '../../ink/components/Box.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { SessionMessage } from '../../store/types.js'
import { useVirtualScroll } from '../hooks/useVirtualScroll.js'
import MessageRow from './MessageRow.js'

type MessageListProps = {
  messages: SessionMessage[]
  width: number
  height: number
}

export default function MessageList({ messages, width, height }: MessageListProps) {
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const itemKeys = messages.map((m, i) => m.id ?? String(i))

  const { range, topSpacer, bottomSpacer, measureRef, spacerRef } = useVirtualScroll(
    scrollRef,
    itemKeys,
    width,
  )

  const [startIdx, endIdx] = range
  const visibleMessages = messages.slice(startIdx, endIdx)

  return (
    <ScrollBox ref={scrollRef} stickyScroll height={height} flexDirection="column">
      {topSpacer > 0 && <Box ref={spacerRef} height={topSpacer} />}
      {topSpacer <= 0 && <Box ref={spacerRef} height={0} />}
      {visibleMessages.map((msg, i) => {
        const actualIdx = startIdx + i
        const key = itemKeys[actualIdx]!
        return (
          <Box key={key} ref={measureRef(key)}>
            <MessageRow message={msg} width={width} />
          </Box>
        )
      })}
      {bottomSpacer > 0 && <Box height={bottomSpacer} />}
    </ScrollBox>
  )
}
