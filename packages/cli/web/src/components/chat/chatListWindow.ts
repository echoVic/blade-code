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
