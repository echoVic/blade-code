import { describe, expect, it } from 'vitest';
import type { LoopEvent, ToolCallRef } from '../../../../src/agent/loop/types.js';
import { TurnActivityState } from '../../../../src/agent/runtime/TurnActivityState.js';

function toolCall(id: string, name: string): ToolCallRef {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function toolStart(
  id: string,
  name: string,
  toolKind: 'readonly' | 'write' | 'execute' = 'execute'
): LoopEvent {
  return { kind: 'tool_start', toolCall: toolCall(id, name), toolKind };
}

function toolResult(id: string, name = 'Bash'): LoopEvent {
  return {
    kind: 'tool_result',
    toolCall: toolCall(id, name),
    result: { success: true, llmContent: 'PRIVATE_OUTPUT' },
  };
}

describe('TurnActivityState', () => {
  it('reports an explicit inactive snapshot before a turn begins', () => {
    const state = new TurnActivityState({
      now: () => 500,
      createGenerationId: () => 'inactive-activity',
    });

    expect(state.snapshot()).toEqual({
      version: 1,
      generation: 'inactive-activity',
      revision: 0,
      snapshot: null,
    });
    expect(state.snapshot()).toEqual({
      version: 1,
      generation: 'inactive-activity',
      revision: 0,
      snapshot: null,
    });
  });

  it('starts a new generation and tracks turn, output, and continuation phases', () => {
    let now = 1_000;
    const state = new TurnActivityState({
      now: () => now++,
      createGenerationId: () => 'activity-1',
    });
    const generation = state.begin();

    expect(state.snapshot()).toEqual({
      version: 1,
      generation: 'activity-1',
      revision: 0,
      snapshot: {
        phase: 'starting',
        startedAt: 1_000,
        updatedAt: 1_000,
        turn: 0,
        maxTurns: null,
        outputStarted: false,
        toolCallsStarted: 0,
        toolCallsCompleted: 0,
        activeTools: [],
        activeToolOverflow: 0,
      },
    });

    expect(
      state.observe(generation, { kind: 'turn_start', turn: 1, maxTurns: -1 })?.snapshot
    ).toMatchObject({ phase: 'thinking', turn: 1, maxTurns: null });
    expect(
      state.observe(generation, { kind: 'thinking_delta', delta: 'thought' })?.snapshot
    ).toMatchObject({ phase: 'thinking', outputStarted: true });
    expect(
      state.observe(generation, { kind: 'content_delta', delta: 'answer' })?.snapshot
    ).toMatchObject({ phase: 'responding', outputStarted: true });
    expect(
      state.observe(generation, {
        kind: 'follow_up_started',
        queued: 0,
        recovered: 0,
        messages: [],
        queue: {
          version: '0'.repeat(64),
          pending: 0,
          mutable: 0,
          locked: 0,
          internal: 0,
          items: [],
        },
      })?.snapshot
    ).toMatchObject({ phase: 'continuing' });
  });

  it('tracks parallel tools, bounded public entries, progress, and completion counts', () => {
    let now = 2_000;
    const state = new TurnActivityState({
      now: () => now++,
      createGenerationId: () => 'activity-1',
    });
    const generation = state.begin();
    state.observe(generation, { kind: 'turn_start', turn: 2, maxTurns: 20 });
    for (let index = 0; index < 10; index++) {
      state.observe(generation, toolStart(`tool-${index}`, `Tool-${index}`));
    }

    expect(state.snapshot().snapshot).toMatchObject({
      phase: 'executing_tools',
      toolCallsStarted: 10,
      toolCallsCompleted: 0,
      activeToolOverflow: 2,
    });
    expect(state.snapshot().snapshot?.activeTools).toHaveLength(8);

    expect(
      state.observe(generation, {
        kind: 'tool_progress',
        toolCall: toolCall('tool-0', 'Tool-0'),
        update: {
          message: 'PRIVATE_PROGRESS_TEXT',
          progress: 2,
          total: 5,
        },
      })?.snapshot?.activeTools[0]
    ).toEqual({
      name: 'Tool-0',
      kind: 'execute',
      startedAt: 2_002,
      progress: 2,
      total: 5,
    });
    expect(JSON.stringify(state.snapshot())).not.toContain('PRIVATE_PROGRESS_TEXT');

    state.observe(generation, toolResult('tool-0', 'Tool-0'));
    expect(state.snapshot().snapshot).toMatchObject({
      phase: 'executing_tools',
      toolCallsCompleted: 1,
      activeToolOverflow: 1,
    });
    for (let index = 1; index < 10; index++) {
      state.observe(generation, toolResult(`tool-${index}`, `Tool-${index}`));
    }
    expect(state.snapshot().snapshot).toMatchObject({
      phase: 'continuing',
      toolCallsCompleted: 10,
      activeTools: [],
      activeToolOverflow: 0,
    });
  });

  it('ignores structured output, duplicates, unknown results, and invalid progress', () => {
    const state = new TurnActivityState({
      now: () => 3_000,
      createGenerationId: () => 'activity-1',
    });
    const generation = state.begin();
    expect(
      state.observe(generation, toolStart('structured', 'StructuredOutput'))
    ).toBeUndefined();
    state.observe(generation, toolStart('one', 'Bash'));
    const revision = state.snapshot().revision;
    expect(state.observe(generation, toolStart('one', 'Bash'))).toBeUndefined();
    expect(state.observe(generation, toolResult('missing'))).toBeUndefined();
    expect(
      state.observe(generation, {
        kind: 'tool_progress',
        toolCall: toolCall('one', 'Bash'),
        update: { message: 'bad', progress: 5, total: 4 },
      })
    ).toBeUndefined();
    expect(state.snapshot().revision).toBe(revision);
  });

  it('tracks compaction and returns to thinking', () => {
    const state = new TurnActivityState({
      now: () => 4_000,
      createGenerationId: () => 'activity-1',
    });
    const generation = state.begin();

    expect(
      state.observe(generation, { kind: 'compaction', phase: 'start' })?.snapshot
    ).toMatchObject({ phase: 'compacting' });
    expect(
      state.observe(generation, { kind: 'compaction', phase: 'end' })?.snapshot
    ).toMatchObject({ phase: 'thinking' });
  });

  it('does not advance revisions for repeated semantic state', () => {
    const state = new TurnActivityState({
      now: () => 4_500,
      createGenerationId: () => 'activity-1',
    });
    const generation = state.begin();
    state.observe(generation, { kind: 'turn_start', turn: 1, maxTurns: 20 });
    state.observe(generation, { kind: 'thinking_delta', delta: 'first' });
    const revision = state.snapshot().revision;

    expect(
      state.observe(generation, { kind: 'thinking_delta', delta: 'second' })
    ).toBeUndefined();
    expect(state.snapshot().revision).toBe(revision);
  });

  it('rejects stale generations and returns defensive snapshots', () => {
    let nextGeneration = 0;
    const state = new TurnActivityState({
      now: () => 5_000,
      createGenerationId: () => `activity-${++nextGeneration}`,
    });
    const stale = state.begin();
    state.observe(stale, toolStart('one', 'Bash'));
    const current = state.begin();

    expect(state.observe(stale, toolResult('one'))).toBeUndefined();
    expect(state.clear(stale)).toBeUndefined();
    expect(state.snapshot()).toMatchObject({
      generation: current.id,
      revision: 0,
      snapshot: { phase: 'starting', activeTools: [] },
    });

    state.observe(current, toolStart('two', 'Read'));
    const copy = state.snapshot();
    if (!copy.snapshot) throw new Error('Expected activity snapshot');
    copy.snapshot.activeTools[0]!.name = 'mutated';
    expect(state.snapshot().snapshot?.activeTools[0]?.name).toBe('Read');
  });

  it('clears an active snapshot once and rejects the cleared token', () => {
    const state = new TurnActivityState({
      now: () => 6_000,
      createGenerationId: () => 'activity-1',
    });
    const generation = state.begin();
    state.observe(generation, toolStart('one', 'Bash'));

    expect(state.clear(generation)).toMatchObject({ revision: 2, snapshot: null });
    expect(state.clear(generation)).toBeUndefined();
    expect(state.observe(generation, toolResult('one'))).toBeUndefined();
    expect(state.snapshot()).toMatchObject({ revision: 2, snapshot: null });
  });
});
