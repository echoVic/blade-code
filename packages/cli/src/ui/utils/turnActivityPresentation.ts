import type { TurnActivityProjection } from '../../api/turnActivitySchemas.js';

export interface TurnActivityPresentation {
  primary: string;
  secondary: string;
  compact: string;
  elapsed: string;
}

export function formatTurnActivityElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

export function formatTurnActivityPresentation(
  activity: TurnActivityProjection | null,
  now = Date.now()
): TurnActivityPresentation | null {
  const snapshot = activity?.snapshot;
  if (!snapshot) return null;

  const activeCount = snapshot.activeTools.length + snapshot.activeToolOverflow;
  const primary =
    snapshot.phase === 'starting'
      ? '正在启动任务'
      : snapshot.phase === 'thinking'
        ? '正在思考'
        : snapshot.phase === 'responding'
          ? '正在生成回复'
          : snapshot.phase === 'compacting'
            ? '正在压缩上下文'
            : snapshot.phase === 'continuing'
              ? '正在推进下一步'
              : `正在执行 ${activeCount} 个工具`;
  const tools = snapshot.activeTools
    .slice(0, 2)
    .map((tool) =>
      tool.progress !== undefined && tool.total !== undefined
        ? `${tool.name} ${tool.progress}/${tool.total}`
        : tool.name
    );
  const hidden = Math.max(
    0,
    snapshot.activeTools.length - tools.length + snapshot.activeToolOverflow
  );
  if (hidden > 0) tools.push(`+${hidden}`);
  const details = [
    ...tools,
    snapshot.toolCallsStarted > 0
      ? `工具 ${snapshot.toolCallsCompleted}/${snapshot.toolCallsStarted}`
      : undefined,
    snapshot.turn > 0
      ? `回合 ${snapshot.turn}${snapshot.maxTurns === null ? '' : `/${snapshot.maxTurns}`}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const elapsed = formatTurnActivityElapsed(now - snapshot.startedAt);

  return {
    primary,
    secondary: details.join(' · '),
    compact:
      snapshot.phase === 'executing_tools'
        ? `执行工具 · ${activeCount} 个 · ${elapsed}`
        : `${primary} · ${elapsed}`,
    elapsed,
  };
}
