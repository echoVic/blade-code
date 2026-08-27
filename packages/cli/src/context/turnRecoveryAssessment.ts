import type { SessionTurnRecovery } from './storage/PersistentStore.js';

export type SessionTurnRecoveryAssessment =
  | { state: 'none' }
  | {
      state: 'completed';
      turnId: string;
      inputMessageCount: number;
    }
  | {
      state: 'resumable';
      turnId: string;
      inputMessageCount: number;
    }
  | {
      state: 'requires_attention';
      turnId: string;
      inputMessageCount: number;
      reason: 'successful_tool_result' | 'interrupted_tool_call';
    };

/**
 * Turns raw durable recovery data into an entry-point-neutral continuation
 * decision. A recovery with any tool evidence is intentionally conservative:
 * callers must surface it before trying to continue the model loop.
 */
export function assessSessionTurnRecovery(
  recovery?: SessionTurnRecovery
): SessionTurnRecoveryAssessment {
  if (!recovery) return { state: 'none' };

  const inputMessageCount = recovery.inputMessageIds.length;
  if (recovery.outcome === 'completed') {
    return {
      state: 'completed',
      turnId: recovery.turnId,
      inputMessageCount,
    };
  }

  if ((recovery.interruptedToolCallCount ?? 0) > 0) {
    return {
      state: 'requires_attention',
      turnId: recovery.turnId,
      inputMessageCount,
      reason: 'interrupted_tool_call',
    };
  }

  if (recovery.hadSuccessfulToolResult) {
    return {
      state: 'requires_attention',
      turnId: recovery.turnId,
      inputMessageCount,
      reason: 'successful_tool_result',
    };
  }

  return {
    state: 'resumable',
    turnId: recovery.turnId,
    inputMessageCount,
  };
}
