import type { SessionSurfaceSelection } from './types';

export const HISTORY_SURFACE_READ_ONLY_ERROR = 'session_surface_read_only';

export function rejectHistorySurfaceAction(state: {
  historySurfaceSelection: SessionSurfaceSelection | null;
  setError: (error: string | null) => void;
}): boolean {
  if (state.historySurfaceSelection?.mode !== 'history-only') return false;
  state.setError(HISTORY_SURFACE_READ_ONLY_ERROR);
  return true;
}

export function isHistorySurfaceActive(
  selection: SessionSurfaceSelection | null | undefined
): boolean {
  return selection?.mode === 'history-only';
}
