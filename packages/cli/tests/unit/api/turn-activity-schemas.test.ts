import { describe, expect, it } from 'vitest';
import {
  normalizeTurnActivityToolName,
  TURN_ACTIVITY_TOOL_NAME_MAX_CHARS,
  TurnActivityProjectionSchema,
} from '../../../src/api/turnActivitySchemas.js';

function activityProjection() {
  return {
    version: 1 as const,
    generation: 'activity-1',
    revision: 4,
    snapshot: {
      phase: 'executing_tools' as const,
      startedAt: 1_780_000_000_000,
      updatedAt: 1_780_000_002_000,
      turn: 2,
      maxTurns: 20,
      outputStarted: true,
      toolCallsStarted: 3,
      toolCallsCompleted: 1,
      activeTools: [
        {
          name: 'Bash',
          kind: 'execute' as const,
          startedAt: 1_780_000_001_000,
          progress: 1,
          total: 4,
        },
      ],
      activeToolOverflow: 1,
    },
  };
}

describe('Turn activity schemas', () => {
  it('accepts a bounded active-tool projection', () => {
    expect(TurnActivityProjectionSchema.parse(activityProjection())).toEqual(
      activityProjection()
    );
  });

  it('accepts an explicit authoritative clear', () => {
    const clear = {
      version: 1 as const,
      generation: 'activity-2',
      revision: 5,
      snapshot: null,
    };

    expect(TurnActivityProjectionSchema.parse(clear)).toEqual(clear);
  });

  it.each([
    { field: 'revision', value: -1 },
    { field: 'revision', value: 1.5 },
    { field: 'revision', value: 1_000_001 },
  ])('rejects invalid $field counters', ({ field, value }) => {
    expect(() =>
      TurnActivityProjectionSchema.parse({
        ...activityProjection(),
        [field]: value,
      })
    ).toThrow();
  });

  it('rejects oversized generations and malformed tool names', () => {
    expect(() =>
      TurnActivityProjectionSchema.parse({
        ...activityProjection(),
        generation: 'x'.repeat(129),
      })
    ).toThrow();
    expect(() =>
      TurnActivityProjectionSchema.parse({
        ...activityProjection(),
        snapshot: {
          ...activityProjection().snapshot,
          activeTools: [
            {
              ...activityProjection().snapshot.activeTools[0],
              name: 'Bash\nPRIVATE_FAILURE_TEXT',
            },
          ],
        },
      })
    ).toThrow();
  });

  it('rejects invalid timestamps, counters, tool limits, and progress', () => {
    const base = activityProjection();
    const invalidSnapshots = [
      { ...base.snapshot, startedAt: -1 },
      { ...base.snapshot, updatedAt: 8_640_000_000_000_001 },
      { ...base.snapshot, turn: 1.5 },
      { ...base.snapshot, toolCallsStarted: -1 },
      {
        ...base.snapshot,
        activeTools: Array.from({ length: 9 }, (_, index) => ({
          name: `Tool${index}`,
          startedAt: base.snapshot.startedAt,
        })),
        activeToolOverflow: 0,
      },
      {
        ...base.snapshot,
        activeTools: [
          { name: 'Bash', startedAt: base.snapshot.startedAt, progress: 5 },
        ],
      },
      {
        ...base.snapshot,
        activeTools: [
          { name: 'Bash', startedAt: base.snapshot.startedAt, progress: 5, total: 4 },
        ],
      },
    ];

    for (const snapshot of invalidSnapshots) {
      expect(() => TurnActivityProjectionSchema.parse({ ...base, snapshot })).toThrow();
    }
  });

  it.each([
    'arguments',
    'message',
    'output',
    'path',
    'prompt',
    'error',
    'url',
    'apiKey',
  ])('rejects the unexpected sensitive field %s', (field) => {
    const base = activityProjection();
    expect(() =>
      TurnActivityProjectionSchema.parse({
        ...base,
        snapshot: {
          ...base.snapshot,
          activeTools: [
            {
              ...base.snapshot.activeTools[0],
              [field]: 'PRIVATE_FAILURE_TEXT',
            },
          ],
        },
      })
    ).toThrow();
  });

  it('normalizes tool identity before it enters the projection', () => {
    const normalized = normalizeTurnActivityToolName(
      `  Ba\u0000sh\n${'x'.repeat(TURN_ACTIVITY_TOOL_NAME_MAX_CHARS)}  `
    );

    expect(
      [...normalized].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      })
    ).toBe(true);
    expect(normalized).toHaveLength(TURN_ACTIVITY_TOOL_NAME_MAX_CHARS);
    expect(normalized.startsWith('Bash')).toBe(true);
  });

  it('rejects empty tool identity after normalization', () => {
    expect(() => normalizeTurnActivityToolName('\u0000\n\t')).toThrow(
      'Turn activity tool name is empty'
    );
  });
});
