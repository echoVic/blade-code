import { describe, expect, it } from 'vitest';
import { assessSessionTurnRecovery } from '../../../../src/context/turnRecoveryAssessment.js';

describe('assessSessionTurnRecovery', () => {
  it('reports no recovery when the session has no durable recovery record', () => {
    expect(assessSessionTurnRecovery()).toEqual({ state: 'none' });
  });

  it('reports a completed final response without scheduling a continuation', () => {
    expect(
      assessSessionTurnRecovery({
        turnId: 'turn-completed',
        outcome: 'completed',
        inputMessageIds: ['input-1'],
        hadSuccessfulToolResult: false,
        interruptedToolCallCount: 0,
        emptyFinalCorrectionSpent: false,
        finalization: {
          turnId: 'turn-completed',
          inputMessageIds: ['input-1'],
          turnsCount: 2,
          toolCallsCount: 0,
          durationMs: 120,
        },
      })
    ).toEqual({
      state: 'completed',
      turnId: 'turn-completed',
      inputMessageCount: 1,
    });
  });

  it('marks an interrupted turn with no tool evidence as resumable', () => {
    expect(
      assessSessionTurnRecovery({
        turnId: 'turn-resumable',
        outcome: 'aborted',
        inputMessageIds: ['input-1', 'input-2'],
        hadSuccessfulToolResult: false,
        interruptedToolCallCount: 0,
        emptyFinalCorrectionSpent: false,
      })
    ).toEqual({
      state: 'resumable',
      turnId: 'turn-resumable',
      inputMessageCount: 2,
    });
  });

  it('requires attention after a successful tool result without durable adoption proof', () => {
    expect(
      assessSessionTurnRecovery({
        turnId: 'turn-tool-succeeded',
        outcome: 'aborted',
        inputMessageIds: ['input-1'],
        hadSuccessfulToolResult: true,
        interruptedToolCallCount: 0,
        emptyFinalCorrectionSpent: false,
      })
    ).toEqual({
      state: 'requires_attention',
      turnId: 'turn-tool-succeeded',
      inputMessageCount: 1,
      reason: 'successful_tool_result',
    });
  });

  it('resumes when every successful tool result has durable safe-adoption proof', () => {
    expect(
      assessSessionTurnRecovery({
        turnId: 'turn-safe-adopted-tool',
        outcome: 'aborted',
        inputMessageIds: ['input-1'],
        hadSuccessfulToolResult: true,
        interruptedToolCallCount: 0,
        allSuccessfulToolResultsSafeForResume: true,
        emptyFinalCorrectionSpent: false,
      })
    ).toEqual({
      state: 'resumable',
      turnId: 'turn-safe-adopted-tool',
      inputMessageCount: 1,
    });
  });

  it('requires attention when a process restart interrupted an in-flight tool', () => {
    expect(
      assessSessionTurnRecovery({
        turnId: 'turn-tool-interrupted',
        outcome: 'aborted',
        inputMessageIds: ['input-1'],
        hadSuccessfulToolResult: true,
        interruptedToolCallCount: 1,
        allSuccessfulToolResultsSafeForResume: true,
        emptyFinalCorrectionSpent: false,
      })
    ).toEqual({
      state: 'requires_attention',
      turnId: 'turn-tool-interrupted',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call',
    });
  });
});
