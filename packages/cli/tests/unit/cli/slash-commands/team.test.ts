import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: true,
  list: vi.fn(),
  getSnapshot: vi.fn(),
  sendMessage: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  getState: () => ({
    config: {
      config: {
        agentTeamsEnabled: mocks.enabled,
      },
    },
  }),
}));

vi.mock('../../../../src/agent/subagents/SubagentRegistry.js', () => ({
  getSubagentRegistry: () => ({}),
}));

vi.mock('../../../../src/agent/teams/TeamRuntime.js', () => ({
  TeamRuntime: class {
    list = mocks.list;
    getSnapshot = mocks.getSnapshot;
    sendMessage = mocks.sendMessage;
    delete = mocks.delete;
  },
}));

import teamCommand from '../../../../src/slash-commands/team.js';

const context = {
  cwd: '/workspace',
  workspaceRoot: '/workspace',
  sessionId: 'session-a',
} as const;

const team = {
  name: 'review-team',
  description: 'Review the runtime',
  status: 'running',
  leadAgentId: 'team-lead-review-team',
  leadSessionId: 'session-a',
  workspaceRoot: '/workspace',
  peerMessagingEnabled: true,
  createdAt: 1,
  updatedAt: 2,
  members: [
    {
      id: 'team-lead-review-team',
      name: 'team-lead',
      subagentType: 'team-lead',
      description: 'Lead',
      status: 'leader',
    },
    {
      id: 'team-reviewer-review-team',
      name: 'reviewer',
      subagentType: 'Explore',
      description: 'Review',
      status: 'running',
      worktreePath: '/workspace/worktree',
    },
  ],
  tasks: [
    {
      id: '1',
      subject: 'Inspect runtime',
      description: 'Review runtime changes',
      status: 'running',
      owner: 'team-reviewer-review-team',
      priority: 'high',
      dependsOn: [],
      blocks: [],
      createdAt: '2026-08-22T00:00:00.000Z',
    },
  ],
};

describe('/team', () => {
  beforeEach(() => {
    mocks.enabled = true;
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([team]);
    mocks.getSnapshot.mockResolvedValue(team);
    mocks.sendMessage.mockResolvedValue([{ to: 'reviewer' }]);
    mocks.delete.mockResolvedValue({ ...team, status: 'deleted' });
  });

  it('lists and renders the current Session teams', async () => {
    const result = await teamCommand.handler([], context);

    expect(mocks.list).toHaveBeenCalledWith({
      sessionId: 'session-a',
      projectPath: '/workspace',
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('review-team');
    expect(result.content).toContain('Inspect runtime');
    expect(result.content).toContain('reviewer');
  });

  it('routes direct messages through the team runtime', async () => {
    const result = await teamCommand.handler(
      ['message', 'review-team', 'reviewer', 'Check', 'the', 'race'],
      context
    );

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      name: 'review-team',
      to: 'reviewer',
      body: 'Check the race',
      owner: {
        sessionId: 'session-a',
        projectPath: '/workspace',
      },
    });
    expect(result).toMatchObject({ success: true, content: 'Sent to reviewer.' });
  });

  it('fails closed while Agent Teams are disabled', async () => {
    mocks.enabled = false;

    await expect(teamCommand.handler([], context)).resolves.toEqual({
      success: false,
      error: 'Agent Teams are disabled. Set agentTeamsEnabled to true.',
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
