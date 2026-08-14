import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_SUBAGENT_COMPLETION_ERROR_CHARS,
  BACKGROUND_SUBAGENT_COMPLETION_RESULT_CHARS,
  backgroundSubagentCompletionInboxId,
  buildBackgroundSubagentCompletion,
} from '../../../../src/agent/subagents/BackgroundSubagentCompletion.js';
import type {
  AgentSession,
  AgentSessionOwner,
} from '../../../../src/agent/subagents/AgentSessionStore.js';

const owner: AgentSessionOwner = {
  sessionId: 'background-completion-parent',
  projectPath: path.resolve('/tmp/background-completion-project'),
};

function completedSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    schemaVersion: 2,
    id: 'agent-background-child',
    subagentType: 'Explore',
    description: 'Inspect background marker',
    prompt: 'Inspect the project and return the background marker.',
    messages: [],
    status: 'completed',
    background: true,
    result: {
      success: true,
      message: 'BACKGROUND_CHILD_MARKER',
      modifiedFiles: ['src/marker.ts'],
    },
    stats: { tokens: 50, toolCalls: 2, duration: 400 },
    createdAt: 1,
    lastActiveAt: 2,
    completedAt: 3,
    parentSessionId: owner.sessionId,
    parentProjectPath: owner.projectPath,
    rootAgentId: 'agent-background-child',
    resumeDepth: 0,
    workspaceRoot: owner.projectPath,
    isolation: 'none',
    configSnapshot: {
      name: 'Explore',
      description: 'Explore agent',
      source: 'builtin',
    },
    ...overrides,
  };
}

describe('durable background subagent completion', () => {
  it('builds one bounded hidden parent input with immutable child identity', () => {
    const completion = buildBackgroundSubagentCompletion(completedSession(), owner);

    expect(completion).toMatchObject({
      inboxMessageId: 'background-subagent-completion:agent-background-child',
      childSessionId: 'agent-background-child',
      content: expect.stringContaining('BACKGROUND_CHILD_MARKER'),
      metadata: {
        clientVisible: false,
        backgroundSubagentCompletion: {
          childSessionId: 'agent-background-child',
          subagentType: 'Explore',
          description: 'Inspect background marker',
          status: 'completed',
          rootAgentId: 'agent-background-child',
          resumeDepth: 0,
          resultTruncated: false,
        },
      },
      subagentRef: {
        subagentSessionId: 'agent-background-child',
        subagentType: 'Explore',
        subagentDescription: 'Inspect background marker',
        subagentStatus: 'completed',
        subagentSummary: 'BACKGROUND_CHILD_MARKER',
        subagentRootId: 'agent-background-child',
        subagentResumeDepth: 0,
      },
    });
    expect(completion?.content).toContain('untrusted data');
    expect(completion?.content).toContain('TaskOutput');
    expect(backgroundSubagentCompletionInboxId('agent-background-child')).toBe(
      completion?.inboxMessageId
    );
  });

  it('truncates model notification content without changing the child sidecar', () => {
    const marker = 'x'.repeat(BACKGROUND_SUBAGENT_COMPLETION_RESULT_CHARS * 2);
    const session = completedSession({
      result: { success: true, message: marker },
    });

    const completion = buildBackgroundSubagentCompletion(session, owner);

    expect(completion?.metadata).toMatchObject({
      backgroundSubagentCompletion: {
        resultTruncated: true,
      },
    });
    const metadata = completion?.metadata.backgroundSubagentCompletion as
      | { result?: string }
      | undefined;
    expect(metadata?.result?.length).toBeLessThanOrEqual(
      BACKGROUND_SUBAGENT_COMPLETION_RESULT_CHARS
    );
    expect(completion?.content.length).toBeLessThan(marker.length);
    expect(session.result?.message).toBe(marker);
  });

  it('includes the truncation marker inside the bounded error budget', () => {
    const completion = buildBackgroundSubagentCompletion(
      completedSession({
        status: 'failed',
        result: {
          success: false,
          message: '',
          error: 'e'.repeat(BACKGROUND_SUBAGENT_COMPLETION_ERROR_CHARS * 2),
        },
      }),
      owner
    );
    const metadata = completion?.metadata.backgroundSubagentCompletion as
      | { error?: string; resultTruncated?: boolean }
      | undefined;

    expect(metadata?.resultTruncated).toBe(true);
    expect(metadata?.error).toContain('...[truncated]');
    expect(metadata?.error?.length).toBeLessThanOrEqual(
      BACKGROUND_SUBAGENT_COMPLETION_ERROR_CHARS
    );
  });

  it('accepts a valid resumed lineage and preserves its immutable root', () => {
    const source = completedSession({
      id: 'agent-background-source',
      rootAgentId: 'agent-background-root',
      resumeDepth: 2,
    });
    const child = completedSession({
      id: 'agent-background-resumed',
      resumedFrom: source.id,
      rootAgentId: source.rootAgentId,
      resumeDepth: 3,
    });

    expect(buildBackgroundSubagentCompletion(child, owner, source)).toMatchObject({
      inboxMessageId: 'background-subagent-completion:agent-background-resumed',
      metadata: {
        backgroundSubagentCompletion: {
          resumedFrom: 'agent-background-source',
          rootAgentId: 'agent-background-root',
          resumeDepth: 3,
        },
      },
    });
  });

  it.each([
    false,
    undefined,
  ])('accepts a new background resume from a terminal source with background=%s', (background) => {
    const source = completedSession({
      id: 'agent-terminal-source',
      background,
      rootAgentId: 'agent-shared-root',
      resumeDepth: 1,
    });
    const child = completedSession({
      id: 'agent-background-resume',
      resumedFrom: source.id,
      rootAgentId: source.rootAgentId,
      resumeDepth: 2,
    });

    expect(buildBackgroundSubagentCompletion(child, owner, source)).toMatchObject({
      childSessionId: child.id,
      subagentRef: {
        subagentResumedFrom: source.id,
        subagentRootId: source.rootAgentId,
        subagentResumeDepth: 2,
      },
    });
  });

  it.each([
    {
      status: 'failed' as const,
      result: {
        success: false,
        message: '',
        error: 'BACKGROUND_CHILD_FAILED',
      },
      marker: 'BACKGROUND_CHILD_FAILED',
    },
    {
      status: 'cancelled' as const,
      result: undefined,
      marker: 'Background subagent was cancelled.',
    },
  ])('builds a bounded $status terminal notification', ({ status, result, marker }) => {
    const completion = buildBackgroundSubagentCompletion(
      completedSession({ status, result }),
      owner
    );

    expect(completion).toMatchObject({
      content: expect.stringContaining(marker),
      subagentRef: {
        subagentStatus: status,
      },
      metadata: {
        backgroundSubagentCompletion: {
          status,
        },
      },
    });
  });

  it.each([
    {
      name: 'foreground child',
      session: completedSession({ background: false }),
      source: undefined,
    },
    {
      name: 'legacy child',
      session: completedSession({ background: undefined }),
      source: undefined,
    },
    {
      name: 'running child',
      session: completedSession({ status: 'running', result: undefined }),
      source: undefined,
    },
    {
      name: 'cross-workspace owner',
      session: completedSession({
        parentProjectPath: path.resolve('/tmp/other-project'),
      }),
      source: undefined,
    },
    {
      name: 'invalid fresh root',
      session: completedSession({ rootAgentId: 'agent-other-root' }),
      source: undefined,
    },
    {
      name: 'missing resume source',
      session: completedSession({
        resumedFrom: 'agent-missing-source',
        resumeDepth: 1,
      }),
      source: undefined,
    },
    {
      name: 'wrong resume depth',
      session: completedSession({
        id: 'agent-resumed-depth',
        resumedFrom: 'agent-source-depth',
        rootAgentId: 'agent-source-depth',
        resumeDepth: 2,
      }),
      source: completedSession({
        id: 'agent-source-depth',
        rootAgentId: 'agent-source-depth',
        resumeDepth: 0,
      }),
    },
    {
      name: 'changed resumed type',
      session: completedSession({
        id: 'agent-resumed-type',
        subagentType: 'Plan',
        resumedFrom: 'agent-source-type',
        rootAgentId: 'agent-source-type',
        resumeDepth: 1,
      }),
      source: completedSession({
        id: 'agent-source-type',
        rootAgentId: 'agent-source-type',
        resumeDepth: 0,
      }),
    },
    {
      name: 'oversized durable result',
      session: completedSession({
        result: {
          success: true,
          message: 'x'.repeat(1_000_001),
        },
      }),
      source: undefined,
    },
  ])('rejects $name', ({ session, source }) => {
    expect(buildBackgroundSubagentCompletion(session, owner, source)).toBeUndefined();
  });
});
