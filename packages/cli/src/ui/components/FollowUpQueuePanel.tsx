import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type {
  FollowUpQueueMutation,
  FollowUpQueueSnapshot,
} from '../../api/followUpQueueSchemas.js';
import type { FollowUpQueueMutationState } from '../../store/types.js';
import { useTerminalDimensions } from '../hooks/useTerminalDimensions.js';
import { useTerminalInput } from '../input/TerminalInputRouter.js';
import { truncateText } from '../utils/markdown.js';

interface FollowUpQueuePanelProps {
  queue: FollowUpQueueSnapshot | null;
  mutation: FollowUpQueueMutationState;
  onMutate: (operation: FollowUpQueueMutation) => boolean | Promise<boolean>;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}

function mutableSegment(
  queue: FollowUpQueueSnapshot,
  selectedIndex: number
): { start: number; end: number } {
  let start = selectedIndex;
  let end = selectedIndex;
  while (start > 0 && queue.items[start - 1]?.mutable) start--;
  while (end < queue.items.length - 1 && queue.items[end + 1]?.mutable) end++;
  return { start, end };
}

export function FollowUpQueuePanel({
  queue,
  mutation,
  onMutate,
  onRefresh,
  onClose,
}: FollowUpQueuePanelProps): React.ReactElement {
  const { width, height } = useTerminalDimensions();
  const [selectedId, setSelectedId] = useState(queue?.items[0]?.id ?? null);
  const selectedIndex = Math.max(
    0,
    queue?.items.findIndex((item) => item.id === selectedId) ?? 0
  );

  useEffect(() => {
    if (!queue || queue.items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !queue.items.some((item) => item.id === selectedId)) {
      setSelectedId(queue.items[Math.min(selectedIndex, queue.items.length - 1)]!.id);
    }
  }, [queue, selectedId, selectedIndex]);

  const invokeMutation = (operation: FollowUpQueueMutation): void => {
    void Promise.resolve(onMutate(operation)).catch(() => undefined);
  };

  useTerminalInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        onClose();
        return true;
      }
      if (input === 'r') {
        void Promise.resolve(onRefresh()).catch(() => undefined);
        return true;
      }
      if (!queue || queue.items.length === 0) return true;
      if (key.downArrow || input === 'j') {
        const nextIndex = Math.min(queue.items.length - 1, selectedIndex + 1);
        setSelectedId(queue.items[nextIndex]!.id);
        return true;
      }
      if (key.upArrow || input === 'k') {
        const nextIndex = Math.max(0, selectedIndex - 1);
        setSelectedId(queue.items[nextIndex]!.id);
        return true;
      }
      const selected = queue.items[selectedIndex];
      if (!selected?.mutable || mutation.pending) return true;
      const segment = mutableSegment(queue, selectedIndex);
      if (input === 'd') {
        invokeMutation({ type: 'remove', messageId: selected.id });
        return true;
      }
      const target =
        input === 'K'
          ? Math.max(segment.start, selectedIndex - 1)
          : input === 'J'
            ? Math.min(segment.end, selectedIndex + 1)
            : input === 'g'
              ? segment.start
              : input === 'G'
                ? segment.end
                : undefined;
      if (target !== undefined && target !== selectedIndex) {
        invokeMutation({ type: 'move', messageId: selected.id, toPosition: target });
      }
      return true;
    },
    { priority: 120 }
  );

  const visibleItems = useMemo(() => {
    if (!queue) return [];
    const maxRows = Math.max(1, height - 9);
    const start = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxRows / 2), queue.items.length - maxRows)
    );
    return queue.items.slice(start, start + maxRows);
  }, [height, queue, selectedIndex]);
  const previewWidth = Math.max(8, width - 38);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          Follow-up queue · {queue?.pending ?? 0}
        </Text>
        <Text dimColor>Esc/q close · r refresh</Text>
      </Box>
      <Text dimColor>j/k select · d delete · J/K move · g/G segment edge</Text>
      {(mutation.errorCode || mutation.errorMessage) && (
        <Text color="red">
          {mutation.errorCode === 'revision_conflict'
            ? 'Queue changed; showing the latest order'
            : mutation.errorMessage}
        </Text>
      )}
      {!queue || queue.items.length === 0 ? (
        <Text dimColor>No queued follow-ups.</Text>
      ) : (
        visibleItems.map((item) => {
          const selected = item.id === selectedId;
          const preview =
            item.kind === 'internal'
              ? 'Internal runtime item'
              : item.preview || 'Attachment-only follow-up';
          return (
            <Box key={item.id} gap={1}>
              <Text color={selected ? 'cyan' : undefined}>{selected ? '›' : ' '}</Text>
              <Text dimColor>{String(item.position + 1).padStart(2, ' ')}</Text>
              <Text color={item.mutable ? 'white' : 'gray'}>
                {truncateText(preview.replace(/\s+/g, ' '), previewWidth, '…')}
              </Text>
              {item.attachmentCount > 0 && (
                <Text color="cyan">[{item.attachmentCount} attachment]</Text>
              )}
              <Text color={item.mutable ? 'green' : 'yellow'}>
                {item.mutable ? item.delivery.replace('_', ' ') : 'locked'}
              </Text>
              {mutation.pending && mutation.messageId === item.id && (
                <Text color="yellow">updating…</Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}
