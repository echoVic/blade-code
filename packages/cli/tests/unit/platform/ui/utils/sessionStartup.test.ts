import { describe, expect, it, vi } from 'vitest';
import {
  getInitialLocalSessionId,
  initializeLocalSessionIdentity,
} from '../../../../../src/ui/utils/sessionStartup.js';

describe('session startup identity', () => {
  it('preserves an explicit id for a new local session', () => {
    expect(getInitialLocalSessionId({ resumeSessionId: 'local-session' })).toBe(
      'local-session'
    );
  });

  it('does not write a fork target id before the source workspace is resolved', () => {
    expect(
      getInitialLocalSessionId({
        resumeSessionId: 'fork-child',
        forkSession: true,
      })
    ).toBeUndefined();
  });

  it('applies only a resolved local startup id to the live store boundary', () => {
    const restoreSession = vi.fn<(sessionId: string) => void>();

    initializeLocalSessionIdentity(
      { resumeSessionId: 'local-session' },
      restoreSession
    );
    initializeLocalSessionIdentity(
      { resumeSessionId: 'fork-child', forkSession: true },
      restoreSession
    );

    expect(restoreSession).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledWith('local-session');
  });
});
