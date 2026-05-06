import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../../../src/agent/subagents/AgentSessionStore';

const mockSessions = new Map<string, Partial<AgentSession>>();
const mockManager = {
  startBackgroundAgent: vi.fn((options: any) => {
    const agentId = options.agentId;
    mockSessions.set(agentId, {
      id: agentId,
      subagentType: options.config.name,
      description: options.description,
      prompt: options.prompt,
      messages: [],
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentSessionId: options.parentSessionId,
    });
    return agentId;
  }),
  getAgent: vi.fn((agentId: string) => mockSessions.get(agentId)),
  killAgent: vi.fn((agentId: string) => {
    const session = mockSessions.get(agentId);
    if (!session || session.status !== 'running') return false;
    session.status = 'cancelled';
    session.completedAt = Date.now();
    return true;
  }),
};

vi.mock('../../../../../src/agent/subagents/BackgroundAgentManager', () => ({
  BackgroundAgentManager: {
    getInstance: () => mockManager,
  },
}));

import { subagentRegistry } from '../../../../../src/agent/subagents/SubagentRegistry';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index';
import { createTeamTools } from '../../../../../src/tools/builtin/team/index';

async function createTempConfigDir() {
  return fs.mkdtemp(path.join(tmpdir(), 'blade-team-tools-test-'));
}

function getTool(configDir: string, name: string) {
  const tool = createTeamTools({ sessionId: 'session-a', configDir }).find(
    (candidate) => candidate.name === name
  );
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as any;
}

describe('agent team tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.clear();
    subagentRegistry.clear();
    subagentRegistry.register({
      name: 'Explore',
      description: 'Read-only exploration agent',
      systemPrompt: 'Explore the repo',
      tools: ['Read', 'Grep', 'Glob'],
    });
    subagentRegistry.register({
      name: 'Plan',
      description: 'Planning agent',
      systemPrompt: 'Plan work',
      tools: ['Read', 'Grep', 'Glob', 'TaskCreate', 'TaskUpdate'],
    });
  });

  it('creates a persistent team and launches initial teammate agents', async () => {
    const configDir = await createTempConfigDir();

    try {
      const result = await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Checkout Refactor',
          description: 'Parallel checkout refactor',
          agent_type: 'tech-lead',
          members: [
            {
              name: 'researcher',
              subagent_type: 'Explore',
              description: 'Map checkout flow',
              prompt: 'Find checkout flow entry points and summarize risks.',
            },
            {
              name: 'planner',
              subagent_type: 'Plan',
              description: 'Plan implementation',
              prompt: 'Plan the checkout refactor with concrete file changes.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a' }
      );

      expect(result.success).toBe(true);
      expect(mockManager.startBackgroundAgent).toHaveBeenCalledTimes(2);
      expect(mockManager.startBackgroundAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'researcher@checkout-refactor',
          parentSessionId: 'session-a',
          taskListId: 'checkout-refactor',
        })
      );

      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'teams', 'checkout-refactor', 'config.json'),
          'utf-8'
        )
      );
      expect(stored).toMatchObject({
        name: 'checkout-refactor',
        leadAgentId: 'team-lead@checkout-refactor',
      });
      expect(stored.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'team-lead',
            subagentType: 'tech-lead',
            status: 'leader',
          }),
          expect.objectContaining({
            name: 'researcher',
            agentId: 'researcher@checkout-refactor',
            status: 'running',
          }),
        ])
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('reports teammate status and exposes TaskOutput IDs', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Search Work',
          members: [
            {
              name: 'researcher',
              subagent_type: 'Explore',
              prompt: 'Search for the relevant modules and report findings.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a' }
      );

      mockSessions.set('researcher@search-work', {
        ...mockSessions.get('researcher@search-work'),
        status: 'completed',
        result: { success: true, message: 'Found modules' },
        completedAt: Date.now(),
      });

      const result = await getTool(configDir, 'TeamStatus').execute({
        team_name: 'search-work',
      });
      const content = result.llmContent as any;

      expect(result.success).toBe(true);
      expect(content.team.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'researcher',
            status: 'completed',
            task_output_id: 'researcher@search-work',
            result: { success: true, message: 'Found modules' },
          }),
        ])
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('deletes a team and cancels running teammate agents', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Stop Me',
          members: [
            {
              name: 'researcher',
              subagent_type: 'Explore',
              prompt: 'Keep searching until cancelled by the lead.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a' }
      );

      const result = await getTool(configDir, 'TeamDelete').execute({
        team_name: 'stop-me',
      });

      expect(result.success).toBe(true);
      expect(mockManager.killAgent).toHaveBeenCalledWith('researcher@stop-me');

      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'teams', 'stop-me', 'config.json'),
          'utf-8'
        )
      );
      expect(stored.deletedAt).toEqual(expect.any(Number));
      expect(stored.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'researcher', status: 'cancelled' }),
        ])
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown teammate subagent types', async () => {
    const configDir = await createTempConfigDir();

    try {
      const result = await getTool(configDir, 'TeamCreate').execute({
        team_name: 'Invalid Team',
        members: [
          {
            name: 'writer',
            subagent_type: 'Missing',
            prompt: 'Try to run as a missing agent type.',
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid subagent type');
      expect(mockManager.startBackgroundAgent).not.toHaveBeenCalled();
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('builtin team tool registration', () => {
  it('exposes agent team tools', async () => {
    const configDir = await createTempConfigDir();

    try {
      const names = (await getBuiltinTools({ sessionId: 'session-a', configDir })).map(
        (tool) => tool.name
      );

      expect(names).toEqual(
        expect.arrayContaining(['TeamCreate', 'TeamStatus', 'TeamDelete'])
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
