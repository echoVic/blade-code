import type {
  SessionEvent,
  SessionTurnAbortInfo,
  SessionTurnCompletionInfo,
  SessionTurnStartInfo,
} from '../types.js';

export type SessionTurnTerminalInfo =
  | { type: 'turn_completed'; data: SessionTurnCompletionInfo }
  | { type: 'turn_aborted'; data: SessionTurnAbortInfo };

export interface SessionTurnLifecycle {
  active: SessionTurnStartInfo | null;
  lastTerminal: SessionTurnTerminalInfo | null;
}

export function projectTurnLifecycle(
  events: readonly SessionEvent[]
): SessionTurnLifecycle {
  let active: SessionTurnStartInfo | null = null;
  let lastTerminal: SessionTurnTerminalInfo | null = null;

  for (const event of events) {
    if (event.type === 'turn_started') {
      active = event.data;
      continue;
    }
    if (event.type === 'turn_completed') {
      lastTerminal = { type: 'turn_completed', data: event.data };
    } else if (event.type === 'turn_aborted') {
      lastTerminal = { type: 'turn_aborted', data: event.data };
    } else {
      continue;
    }
    if (active?.turnId === lastTerminal.data.turnId) {
      active = null;
    }
  }

  return { active, lastTerminal };
}
