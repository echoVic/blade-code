import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appActions, getState, vanillaStore } from '../../../../src/store/vanilla.js';

describe('TUI parallel subagent progress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vanillaStore.setState((state) => ({
      app: {
        ...state.app,
        subagentProgress: null,
        subagentProgresses: {},
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates and clears each child independently', () => {
    appActions().startSubagentProgress('agent-a', 'Explore', 'Inspect API');
    appActions().startSubagentProgress('agent-b', 'reviewer', 'Review tests');
    appActions().updateSubagentTool('agent-a', 'Read');
    appActions().completeSubagentProgress('agent-b', true);

    expect(getState().app.subagentProgresses).toMatchObject({
      'agent-a': {
        status: 'running',
        currentTool: 'Read',
      },
      'agent-b': {
        status: 'completed',
      },
    });

    vi.advanceTimersByTime(1_500);

    expect(getState().app.subagentProgresses).toEqual({
      'agent-a': expect.objectContaining({
        status: 'running',
        currentTool: 'Read',
      }),
    });
    expect(getState().app.subagentProgress?.id).toBe('agent-a');
  });

  it('retains a bounded failure summary until terminal progress cleanup', () => {
    const diagnostic = `Provider request admission class pending_bytes queue is full ${'x'.repeat(300)}`;
    appActions().startSubagentProgress(
      'agent-failed',
      'background-memory',
      'Read hidden marker'
    );
    appActions().completeSubagentProgress('agent-failed', false, `  ${diagnostic}  `);

    const progress = getState().app.subagentProgresses['agent-failed'];
    expect(progress).toMatchObject({
      status: 'failed',
      terminalSummary: expect.stringContaining(
        'Provider request admission class pending_bytes queue is full'
      ),
    });
    expect(progress?.terminalSummary).toHaveLength(200);

    vi.advanceTimersByTime(1_500);
    expect(getState().app.subagentProgresses).toEqual({});
  });
});
