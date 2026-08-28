export function anchoredScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number
): number {
  return Math.max(0, previousScrollTop + (nextScrollHeight - previousScrollHeight));
}

export function nextVisibleMessageCount(
  currentVisibleCount: number,
  totalMessages: number,
  batchSize: number
): number {
  return Math.min(
    totalMessages,
    Math.max(0, currentVisibleCount) + Math.max(0, batchSize)
  );
}

export function collectUnreadMessageIds<T extends { id?: string }>(
  previousMessages: readonly T[],
  nextMessages: readonly T[],
  currentUnreadIds: ReadonlySet<string>,
  getRevision?: (message: T) => string
): Set<string> {
  const previousById = new Map(
    previousMessages
      .filter((message): message is T & { id: string } => Boolean(message.id))
      .map((message) => [message.id, message])
  );
  const nextUnreadIds = new Set(currentUnreadIds);

  for (const message of nextMessages) {
    if (!message.id) continue;
    const previous = previousById.get(message.id);
    if (
      previous !== message &&
      (!previous || !getRevision || getRevision(previous) !== getRevision(message))
    ) {
      nextUnreadIds.add(message.id);
    }
  }

  return nextUnreadIds;
}
