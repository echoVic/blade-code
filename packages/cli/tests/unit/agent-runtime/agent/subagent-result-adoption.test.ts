import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentSession,
  AgentSessionOwner,
} from '../../../../src/agent/subagents/AgentSessionStore.js';
import { buildSubagentResultAdoption } from '../../../../src/agent/subagents/SubagentResultAdoption.js';
import type { SessionInterruptedToolCall } from '../../../../src/context/storage/PersistentStore.js';

const owner: AgentSessionOwner = {
  sessionId: 'parent-session',
  projectPath: path.resolve('/tmp/subagent-adoption-project'),
};

function completedSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    schemaVersion: 2,
    id: 'agent-adopted-child',
    subagentType: 'Explore',
    description: 'Inspect the durable marker',
    prompt: 'Find the durable marker and report it.',
    messages: [],
    status: 'completed',
    result: {
      success: true,
      message: 'CHILD_DURABLE_MARKER',
      modifiedFiles: ['src/marker.ts'],
    },
    stats: { tokens: 120, toolCalls: 2, duration: 450 },
    createdAt: 1,
    lastActiveAt: 2,
    completedAt: 3,
    parentSessionId: owner.sessionId,
    parentProjectPath: owner.projectPath,
    rootAgentId: 'agent-adopted-child',
    resumeDepth: 0,
    workspaceRoot: owner.projectPath,
    isolation: 'none',
    configSnapshot: {
      name: 'Explore',
      description: 'Explore agent',
      systemPrompt: 'Inspect code.',
      source: 'builtin',
    },
    ...overrides,
  };
}

function taskCall(input: Record<string, unknown> = {}): SessionInterruptedToolCall {
  return {
    toolCallId: 'tool-task-adoption',
    messageId: 'assistant-task-adoption',
    toolName: 'Task',
    input: {
      description: 'Inspect the durable marker',
      prompt: 'Find the durable marker and report it.',
      subagent_type: 'Explore',
      subagent_session_id: 'agent-adopted-child',
      ...input,
    },
  };
}

describe('completed subagent result adoption', () => {
  it('builds the canonical successful Task result and completed child reference', () => {
    const adoption = buildSubagentResultAdoption(taskCall(), completedSession(), owner);

    expect(adoption).toMatchObject({
      toolCallId: 'tool-task-adoption',
      toolName: 'Task',
      output: expect.stringContaining('CHILD_DURABLE_MARKER'),
      metadata: {
        processRestartRecovery: true,
        subagentResultAdopted: true,
        sideEffectsUncertain: false,
        subagentSessionId: 'agent-adopted-child',
        subagentType: 'Explore',
        subagentStatus: 'completed',
        subagentSummary: 'CHILD_DURABLE_MARKER',
        subagentRootId: 'agent-adopted-child',
        subagentResumeDepth: 0,
      },
      subagentRef: {
        subagentSessionId: 'agent-adopted-child',
        subagentType: 'Explore',
        subagentStatus: 'completed',
        subagentSummary: 'CHILD_DURABLE_MARKER',
        subagentRootId: 'agent-adopted-child',
        subagentResumeDepth: 0,
      },
    });
  });

  it('adopts a known failed child without marking its side effects uncertain', () => {
    const adoption = buildSubagentResultAdoption(
      taskCall(),
      completedSession({
        status: 'failed',
        result: {
          success: false,
          message: '',
          error: 'Verifier rejected the change',
        },
      }),
      owner
    );

    expect(adoption).toMatchObject({
      output: null,
      error: 'Verifier rejected the change',
      metadata: {
        processRestartRecovery: true,
        subagentResultAdopted: true,
        sideEffectsUncertain: false,
        subagentStatus: 'failed',
      },
      subagentRef: {
        subagentStatus: 'failed',
      },
    });
  });

  it.each([
    {
      name: 'non-Task tool',
      call: { ...taskCall(), toolName: 'Bash' },
      session: completedSession(),
    },
    {
      name: 'cross-workspace owner',
      call: taskCall(),
      session: completedSession({
        parentProjectPath: path.resolve('/tmp/other-project'),
      }),
    },
    {
      name: 'different description',
      call: taskCall({ description: 'Different task' }),
      session: completedSession(),
    },
    {
      name: 'different explicit type',
      call: taskCall({ subagent_type: 'Plan' }),
      session: completedSession(),
    },
    {
      name: 'unexpected resume lineage',
      call: taskCall(),
      session: completedSession({
        resumedFrom: 'agent-earlier-source',
        resumeDepth: 1,
      }),
    },
    {
      name: 'wrong resume source',
      call: taskCall({ resume_from: 'agent-other-source' }),
      session: completedSession({
        resumedFrom: 'agent-earlier-source',
        resumeDepth: 1,
      }),
    },
    {
      name: 'still running',
      call: taskCall(),
      session: completedSession({ status: 'running', result: undefined }),
    },
    {
      name: 'cancelled',
      call: taskCall(),
      session: completedSession({ status: 'cancelled', result: undefined }),
    },
    {
      name: 'background child',
      call: taskCall({ run_in_background: true }),
      session: completedSession({ background: true }),
    },
    {
      name: 'oversized result',
      call: taskCall(),
      session: completedSession({
        result: {
          success: true,
          message: 'x'.repeat(1_000_001),
        },
      }),
    },
    {
      name: 'malformed result',
      call: taskCall(),
      session: completedSession({
        result: {
          success: true,
          message: 42,
        } as unknown as AgentSession['result'],
      }),
    },
  ])(
    'rejects $name instead of manufacturing an adopted result',
    ({ call, session }) => {
      expect(buildSubagentResultAdoption(call, session, owner)).toBeUndefined();
    }
  );
});
