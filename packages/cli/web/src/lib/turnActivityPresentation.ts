import type { TurnActivityProjection } from '@api/schemas';
import type { TranslationKey } from '@/i18n';

const PHASE_KEYS: Record<
  NonNullable<TurnActivityProjection['snapshot']>['phase'],
  TranslationKey
> = {
  starting: 'chat.turnActivity.starting',
  thinking: 'chat.turnActivity.thinking',
  responding: 'chat.turnActivity.responding',
  executing_tools: 'chat.turnActivity.executingTools',
  compacting: 'chat.turnActivity.compacting',
  continuing: 'chat.turnActivity.continuing',
};

export function formatTurnActivityElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

export function presentTurnActivity(
  activity: TurnActivityProjection | null,
  now = Date.now()
) {
  const snapshot = activity?.snapshot;
  if (!snapshot) return null;
  const activeCount = snapshot.activeTools.length + snapshot.activeToolOverflow;
  const visibleTools = snapshot.activeTools
    .slice(0, 2)
    .map((tool) =>
      tool.progress !== undefined && tool.total !== undefined
        ? `${tool.name} ${tool.progress}/${tool.total}`
        : tool.name
    );
  const hiddenTools = Math.max(
    0,
    snapshot.activeTools.length - visibleTools.length + snapshot.activeToolOverflow
  );

  return {
    phaseKey: PHASE_KEYS[snapshot.phase],
    phaseParams: { count: activeCount },
    tools: visibleTools,
    hiddenTools,
    completedTools: snapshot.toolCallsCompleted,
    startedTools: snapshot.toolCallsStarted,
    turn: snapshot.turn,
    maxTurns: snapshot.maxTurns,
    elapsed: formatTurnActivityElapsed(now - snapshot.startedAt),
  };
}
