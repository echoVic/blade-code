import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_SHELL_GLOBAL_MAX_ACTIVE,
  BACKGROUND_SHELL_SESSION_MAX_ACTIVE,
  BackgroundShellCapacityError,
  BackgroundShellManager,
} from '../../../../../src/tools/builtin/shell/BackgroundShellManager.js';

describe('BackgroundShellManager admission', () => {
  it('freezes production active-process limits', () => {
    expect(BACKGROUND_SHELL_GLOBAL_MAX_ACTIVE).toBe(16);
    expect(BACKGROUND_SHELL_SESSION_MAX_ACTIVE).toBe(4);
  });

  it('counts hidden candidates and reports Session before global saturation', () => {
    const manager = new BackgroundShellManager({
      globalMaxActive: 2,
      sessionMaxActive: 1,
    });
    const terminate = vi.fn(async () => undefined);
    const first = manager.startExternalForegroundCandidate({
      command: 'first',
      sessionId: 'session-a',
      terminate,
    });

    expect(manager.getProcess(first.id, 'session-a')).toBeUndefined();
    expect(manager.listForSession('session-a')).toEqual([]);
    expect(manager.getAdmissionStats()).toEqual({
      active: 1,
      maxActive: 2,
      sessions: {
        'session-a': { active: 1, maxActive: 1 },
      },
    });

    expect(() =>
      manager.startExternalForegroundCandidate({
        command: 'same-session',
        sessionId: 'session-a',
        terminate,
      })
    ).toThrowError(
      expect.objectContaining<Partial<BackgroundShellCapacityError>>({
        scope: 'session',
        limit: 1,
      })
    );

    const second = manager.startExternalForegroundCandidate({
      command: 'second',
      sessionId: 'session-b',
      terminate,
    });
    expect(() =>
      manager.startExternalForegroundCandidate({
        command: 'global-full',
        sessionId: 'session-c',
        terminate,
      })
    ).toThrowError(
      expect.objectContaining<Partial<BackgroundShellCapacityError>>({
        scope: 'global',
        limit: 2,
      })
    );

    manager.completeExternalProcess(first.id, 'session-a', {
      status: 'exited',
      exitCode: 0,
    });
    expect(manager.getAdmissionStats()).toMatchObject({
      active: 1,
      sessions: {
        'session-b': { active: 1 },
      },
    });

    manager.completeExternalProcess(second.id, 'session-b', {
      status: 'exited',
      exitCode: 0,
    });
    expect(manager.getAdmissionStats()).toEqual({
      active: 0,
      maxActive: 2,
      sessions: {},
    });
  });

  it('exposes a candidate only after promotion and releases it after owned kill', async () => {
    const manager = new BackgroundShellManager({
      globalMaxActive: 1,
      sessionMaxActive: 1,
    });
    let candidateId = '';
    const terminate = vi.fn(async (reason: 'timeout' | 'aborted' | 'killed') => {
      manager.completeExternalProcess(candidateId, 'session-a', {
        status:
          reason === 'timeout'
            ? 'timed_out'
            : reason === 'aborted'
              ? 'aborted'
              : 'killed',
      });
    });
    const candidate = manager.startExternalForegroundCandidate({
      command: 'remote-command',
      sessionId: 'session-a',
      terminate,
    });
    candidateId = candidate.id;

    expect(manager.getProcess(candidate.id, 'session-a')).toBeUndefined();
    expect(
      manager.promoteExternalForegroundCandidate(candidate.id, 'session-a', 15_000)
    ).toMatchObject({
      visible: true,
      autoBackgrounded: true,
      backgroundReason: 'foreground_budget',
      foregroundBudgetMs: 15_000,
    });
    expect(manager.getProcess(candidate.id, 'session-a')).toMatchObject({
      transport: 'acp',
      status: 'running',
    });

    await expect(manager.kill(candidate.id, 'session-a')).resolves.toMatchObject({
      success: true,
      status: 'killed',
    });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith('killed');
    expect(manager.getAdmissionStats().active).toBe(0);
  });

  it('rejects invalid limits', () => {
    expect(
      () =>
        new BackgroundShellManager({
          globalMaxActive: Number.POSITIVE_INFINITY,
        })
    ).toThrow('globalMaxActive must be a positive safe integer');
    expect(
      () =>
        new BackgroundShellManager({
          globalMaxActive: 1,
          sessionMaxActive: 2,
        })
    ).toThrow('sessionMaxActive must not exceed globalMaxActive');
  });
});
