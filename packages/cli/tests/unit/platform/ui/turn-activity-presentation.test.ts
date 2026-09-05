import { describe, expect, it } from 'vitest';
import type { TurnActivityProjection } from '../../../../src/api/turnActivitySchemas.js';
import { formatTurnActivityPresentation } from '../../../../src/ui/utils/turnActivityPresentation.js';

function projection(
  overrides: Partial<NonNullable<TurnActivityProjection['snapshot']>> = {}
): TurnActivityProjection {
  return {
    version: 1,
    generation: 'activity-1',
    revision: 3,
    snapshot: {
      phase: 'executing_tools',
      startedAt: 1_000,
      updatedAt: 2_000,
      turn: 2,
      maxTurns: 20,
      outputStarted: true,
      toolCallsStarted: 5,
      toolCallsCompleted: 3,
      activeTools: [
        { name: 'Read', kind: 'readonly', startedAt: 1_500, progress: 1, total: 4 },
        { name: 'Bash', kind: 'execute', startedAt: 1_700 },
      ],
      activeToolOverflow: 2,
      ...overrides,
    },
  };
}

describe('Turn activity presentation', () => {
  it('formats bounded parallel tool details and elapsed time', () => {
    expect(formatTurnActivityPresentation(projection(), 66_000)).toEqual({
      primary: '正在执行 4 个工具',
      secondary: 'Read 1/4 · Bash · +2 · 工具 3/5 · 回合 2/20',
      compact: '执行工具 · 4 个 · 1m 5s',
      elapsed: '1m 5s',
    });
  });

  it.each([
    ['starting', '正在启动任务'],
    ['thinking', '正在思考'],
    ['responding', '正在生成回复'],
    ['compacting', '正在压缩上下文'],
    ['continuing', '正在推进下一步'],
  ] as const)('formats the %s phase', (phase, primary) => {
    expect(
      formatTurnActivityPresentation(
        projection({ phase, activeTools: [], activeToolOverflow: 0 }),
        2_000
      )
    ).toMatchObject({ primary });
  });

  it('returns null for a clear and never includes private text', () => {
    expect(
      formatTurnActivityPresentation({
        version: 1,
        generation: 'activity-1',
        revision: 4,
        snapshot: null,
      })
    ).toBeNull();
    expect(JSON.stringify(formatTurnActivityPresentation(projection()))).not.toContain(
      'PRIVATE_PROGRESS_TEXT'
    );
  });
});
