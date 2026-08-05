import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '../../../../../src/services/SessionService.js';

function createSessionMetadata(
  overrides: Partial<SessionMetadata> = {}
): SessionMetadata {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
    gitBranch: 'main',
    rootId: 'root-1',
    parentId: undefined,
    relationType: undefined,
    title: 'Session One',
    agentType: 'default',
    model: 'gpt-5',
    taskStatus: 'completed',
    messageCount: 3,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('sessionSelectorModel', () => {
  it('returns intent-specific selector copy', async () => {
    const { getSessionSelectorCopy } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    expect(getSessionSelectorCopy('fork')).toEqual({
      title: '选择要 fork 的会话:',
      instructions:
        '(Left/Right to page | Up/Down to select | Enter to confirm | Esc to cancel)',
    });
    expect(getSessionSelectorCopy('resume')).toEqual({
      title: '选择要恢复的会话:',
      instructions:
        '(Left/Right to page | Up/Down to select | Enter to confirm | Esc to cancel)',
    });
  });

  it('filters out subagent sessions only for fork intent and preserves input order', async () => {
    const ordinary = createSessionMetadata({ sessionId: 'ordinary-1' });
    const subagent = createSessionMetadata({
      sessionId: 'subagent-1',
      relationType: 'subagent',
      rootId: 'root-subagent',
    });
    const forked = createSessionMetadata({
      sessionId: 'forked-1',
      relationType: 'fork',
      rootId: 'root-fork',
    });

    const { getVisibleSessionCandidates } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    expect(getVisibleSessionCandidates([ordinary, subagent, forked], 'fork')).toEqual([
      ordinary,
      forked,
    ]);
    expect(getVisibleSessionCandidates([ordinary, subagent, forked], 'resume')).toEqual(
      [ordinary, subagent, forked]
    );
  });

  it('builds stable distinct compound keys for session candidates', async () => {
    const sameIdOtherWorkspace = createSessionMetadata({
      sessionId: 'shared-id',
      projectPath: '/workspace/b',
      rootId: 'root-2',
    });
    const sameWorkspaceOtherId = createSessionMetadata({
      sessionId: 'different-id',
      projectPath: '/workspace/a',
      rootId: 'root-3',
    });

    const { getSessionCandidateKey } = await import(
      '../../../../../src/ui/components/sessionSelectorModel.js'
    );

    const ordinaryKey = getSessionCandidateKey(
      createSessionMetadata({ sessionId: 'shared-id' })
    );
    const otherWorkspaceKey = getSessionCandidateKey(sameIdOtherWorkspace);
    const otherIdKey = getSessionCandidateKey(sameWorkspaceOtherId);

    expect(ordinaryKey).toBe('/workspace/a\u0000shared-id');
    expect(
      getSessionCandidateKey(createSessionMetadata({ sessionId: 'shared-id' }))
    ).toBe(ordinaryKey);
    expect(new Set([ordinaryKey, otherWorkspaceKey, otherIdKey]).size).toBe(3);
  });
});
