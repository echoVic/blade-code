import { createSessionId } from '../../utils/sessionId.js';

export function ensureDurableToolIdentity(
  toolName: string,
  params: Record<string, unknown>
): void {
  if (
    toolName === 'Task' &&
    (typeof params.subagent_session_id !== 'string' ||
      params.subagent_session_id.length === 0)
  ) {
    params.subagent_session_id = createSessionId('agent');
  }
}
