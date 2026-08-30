import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../../../src/agent/subagents/AgentSessionStore';

const mockSessions = new Map<string, Partial<AgentSession>>();
type StartedAgentOptions = {
  agentId: string;
  config: {
    name: string;
  };
  description: string;
  prompt: string;
  parentSessionId?: string;
  parentProjectPath?: string;
  teamId?: string;
  onStarted?: (agentId: string) => void | Promise<void>;
  onCompleted?: (session: AgentSession) => void | Promise<void>;
  agentResources?: unknown;
  modelResources?: unknown;
  lspResources?: unknown;
  reasoningEffort?: string;
  serviceTier?: string;
  responseVerbosity?: string;
  communicationStyle?: string;
  isolation?: 'none' | 'worktree';
  taskListId?: string;
  workspaceRoot?: string;
};
const startOptions = new Map<string, StartedAgentOptions>();
const mockManager = {
  startBackgroundAgent: vi.fn((options: StartedAgentOptions) => {
    const agentId = options.agentId;
    startOptions.set(agentId, options);
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
      parentProjectPath: options.parentProjectPath,
      teamId: options.teamId,
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
  enqueueSteering: vi.fn(async () => true),
};

vi.mock('../../../../../src/agent/subagents/BackgroundAgentManager', () => ({
  BackgroundAgentManager: {
    getInstance: () => mockManager,
  },
}));

import { subagentRegistry } from '../../../../../src/agent/subagents/SubagentRegistry';
import { TeamMailbox } from '../../../../../src/agent/teams/TeamMailbox';
import { TeamStore } from '../../../../../src/agent/teams/TeamStore';
import { TeamTaskGraph } from '../../../../../src/agent/teams/TeamTaskGraph';
import { Bus } from '../../../../../src/server/bus';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index';
import { createTeamTools } from '../../../../../src/tools/builtin/team/index';
import { executeToolInvocation } from '../../../../../src/tools/execution/ToolInvocationRunner';
import type { Tool } from '../../../../../src/tools/types';

type TeamToolOptions = NonNullable<Parameters<typeof createTeamTools>[0]>;

async function createTempConfigDir() {
  return fs.mkdtemp(path.join(tmpdir(), 'blade-team-tools-test-'));
}

function getTool(
  configDir: string,
  name: string,
  options: Partial<TeamToolOptions> = {}
): Tool<Record<string, unknown>> {
  const tool = createTeamTools({
    sessionId: 'session-a',
    configDir,
    ...options,
  }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as unknown as Tool<Record<string, unknown>>;
}

describe('agent team tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.clear();
    startOptions.clear();
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
    subagentRegistry.register({
      name: 'Implement',
      description: 'Implementation agent',
      systemPrompt: 'Implement changes',
      tools: ['Read', 'Edit', 'Bash'],
    });
  });

  it('does not retain stateless stores by config directory', async () => {
    const configDir = await createTempConfigDir();

    try {
      const first = TeamStore.getInstance(configDir);
      const second = TeamStore.getInstance(configDir);
      expect(second).not.toBe(first);

      const created = await first.createTeam({
        name: 'Stateless Team',
        members: [],
      });
      await expect(second.loadTeam(created.name)).resolves.toMatchObject({
        name: 'stateless-team',
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('propagates non-ENOENT team listing failures', async () => {
    const configDir = await createTempConfigDir();

    try {
      await fs.writeFile(path.join(configDir, 'teams'), 'not a directory');

      await expect(TeamStore.getInstance(configDir).listTeams()).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('retries a transient TeamStatus listing failure', async () => {
    const configDir = await createTempConfigDir();
    const listTeams = vi
      .spyOn(TeamStore.prototype, 'listTeams')
      .mockRejectedValueOnce(
        Object.assign(new Error('too many open files'), { code: 'EMFILE' })
      )
      .mockResolvedValueOnce([]);

    try {
      const result = await executeToolInvocation(
        getTool(configDir, 'TeamStatus').build({}),
        {
          sessionId: 'session-a',
          workspaceRoot: configDir,
        }
      );

      expect(result).toMatchObject({
        success: true,
        metadata: {
          retriedAttempts: 1,
          summary: '暂无 Agent Teams',
        },
      });
      expect(listTeams).toHaveBeenCalledTimes(2);
    } finally {
      listTeams.mockRestore();
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('creates a persistent team and launches initial teammate agents', async () => {
    const configDir = await createTempConfigDir();
    const registerBackgroundSubagent = vi.fn();
    const notifyBackgroundSubagentCompleted = vi.fn(async () => undefined);

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
          tasks: [
            {
              subject: 'Map flow',
              description: 'Map the checkout flow',
              assigned_to: 'researcher',
              priority: 'high',
            },
            {
              subject: 'Write plan',
              description: 'Plan from the completed map',
              assigned_to: 'planner',
              depends_on: ['1'],
            },
          ],
        },
        undefined,
        {
          sessionId: 'session-a',
          registerBackgroundSubagent,
          notifyBackgroundSubagentCompleted,
        }
      );

      expect(result.success).toBe(true);
      expect(mockManager.startBackgroundAgent).toHaveBeenCalledTimes(2);
      expect(mockManager.startBackgroundAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'team-researcher-checkout-refactor',
          parentSessionId: 'session-a',
          taskListId: 'checkout-refactor',
          config: expect.objectContaining({
            tools: expect.arrayContaining([
              'Read',
              'TeamTaskClaim',
              'TeamInbox',
              'SendMessage',
            ]),
          }),
        })
      );
      expect(registerBackgroundSubagent).toHaveBeenCalledTimes(2);

      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'teams', 'checkout-refactor', 'config.json'),
          'utf-8'
        )
      );
      expect(stored).toMatchObject({
        name: 'checkout-refactor',
        leadAgentId: 'team-lead-checkout-refactor',
      });
      expect(stored.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'team-lead',
            subagentType: 'tech-lead',
          }),
          expect.objectContaining({
            name: 'researcher',
            agentId: 'team-researcher-checkout-refactor',
          }),
        ])
      );
      expect(stored.members.every((member: object) => !('status' in member))).toBe(
        true
      );
      const teamContent = result.llmContent as {
        team: {
          tasks: Array<{
            id: string;
            owner?: string;
            status: string;
            dependsOn: string[];
          }>;
        };
      };
      expect(teamContent.team.tasks).toEqual([
        expect.objectContaining({
          id: '1',
          owner: 'team-researcher-checkout-refactor',
          status: 'pending',
        }),
        expect.objectContaining({
          id: '2',
          owner: 'team-planner-checkout-refactor',
          status: 'blocked',
          dependsOn: ['1'],
        }),
      ]);

      const graph = new TeamTaskGraph('checkout-refactor', configDir);
      await graph.claimNext('team-researcher-checkout-refactor');
      const researcher = mockSessions.get('team-researcher-checkout-refactor');
      if (!researcher) throw new Error('Missing researcher session');
      researcher.status = 'completed';
      researcher.result = { success: true, message: 'Mapped checkout flow' };
      const onCompleted = startOptions.get(
        'team-researcher-checkout-refactor'
      )?.onCompleted;
      await onCompleted?.(researcher as AgentSession);
      expect(notifyBackgroundSubagentCompleted).toHaveBeenCalledWith(
        'team-researcher-checkout-refactor'
      );

      await expect(graph.listTasks()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', status: 'completed' }),
          expect.objectContaining({ id: '2', status: 'pending' }),
        ])
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('publishes task completion and unblocked events before parent notification', async () => {
    const configDir = await createTempConfigDir();
    const notifyBackgroundSubagentCompleted = vi.fn(async () => undefined);
    const eventOrder: string[] = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== 'session-a') return;
      if (event.type === 'team.task.unblocked') eventOrder.push('team.task.unblocked');
      if (event.type === 'team.member.completed')
        eventOrder.push('team.member.completed');
      if (event.type === 'team.completed') eventOrder.push('team.completed');
    });
    notifyBackgroundSubagentCompleted.mockImplementation(async () => {
      eventOrder.push('parent.notify');
    });

    try {
      const teamCreateTool = getTool(configDir, 'TeamCreate');
      const result = await teamCreateTool.execute(
        {
          team_name: 'Completion Bridge',
          members: [
            {
              name: 'researcher',
              subagent_type: 'Explore',
              prompt: 'Complete the first task and unblock the next teammate.',
            },
            {
              name: 'planner',
              subagent_type: 'Plan',
              prompt: 'Wait for the unblocked task and then complete planning.',
            },
          ],
          tasks: [
            {
              subject: 'Map flow',
              description: 'Map the completion flow',
              assigned_to: 'researcher',
            },
            {
              subject: 'Plan follow-up',
              description: 'Continue after the map is complete',
              assigned_to: 'planner',
              depends_on: ['1'],
            },
          ],
        },
        undefined,
        {
          sessionId: 'session-a',
          workspaceRoot: '/workspace',
          notifyBackgroundSubagentCompleted,
        }
      );

      expect(result.success).toBe(true);
      const graph = new TeamTaskGraph('completion-bridge', configDir);
      await graph.claimNext('team-researcher-completion-bridge');
      const researcher = mockSessions.get('team-researcher-completion-bridge');
      if (!researcher) throw new Error('Missing researcher session');
      researcher.status = 'completed';
      researcher.result = { success: true, message: 'Mapped completion flow' };

      eventOrder.length = 0;
      const onCompleted = startOptions.get(
        'team-researcher-completion-bridge'
      )?.onCompleted;
      if (!onCompleted) throw new Error('Missing researcher completion callback');
      await onCompleted(researcher as AgentSession);

      expect(eventOrder).toEqual([
        'team.task.unblocked',
        'team.member.completed',
        'parent.notify',
      ]);
      expect(notifyBackgroundSubagentCompleted).toHaveBeenCalledWith(
        'team-researcher-completion-bridge'
      );
      await expect(graph.listTasks()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', status: 'completed' }),
          expect.objectContaining({
            id: '2',
            status: 'pending',
            owner: 'team-planner-completion-bridge',
          }),
        ])
      );

      await graph.claimNext('team-planner-completion-bridge');
      const planner = mockSessions.get('team-planner-completion-bridge');
      if (!planner) throw new Error('Missing planner session');
      planner.status = 'completed';
      planner.result = { success: true, message: 'Planned the follow-up' };

      eventOrder.length = 0;
      const plannerCompleted = startOptions.get(
        'team-planner-completion-bridge'
      )?.onCompleted;
      if (!plannerCompleted) throw new Error('Missing planner completion callback');
      await plannerCompleted(planner as AgentSession);

      expect(eventOrder).toEqual([
        'team.member.completed',
        'team.completed',
        'parent.notify',
      ]);
      expect(notifyBackgroundSubagentCompleted).toHaveBeenCalledTimes(2);
      await expect(graph.listTasks()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', status: 'completed' }),
          expect.objectContaining({ id: '2', status: 'completed' }),
        ])
      );
    } finally {
      unsubscribe();
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('passes the parent Session resources to every teammate runtime', async () => {
    const configDir = await createTempConfigDir();
    const agentResources = {
      projectRoot: '/workspace/source',
      subagents: subagentRegistry,
      skills: {},
      commands: {},
    } as never;
    const modelResources = {
      projectRoot: '/workspace/source',
      config: {},
      catalog: {},
    } as never;
    const lspResources = {
      projectRoot: '/workspace/source',
      servers: { typescript: { command: 'server' } },
    } as never;
    const teamCreateTool = getTool(configDir, 'TeamCreate', {
      subagentRegistry,
      agentResources,
      modelResources,
      lspResources,
      getReasoningEffort: () => 'high',
      getServiceTier: () => 'fast',
      getResponseVerbosity: () => 'high',
      getCommunicationStyle: () => 'friendly',
    });

    try {
      await teamCreateTool.execute(
        {
          team_name: 'Resource Team',
          members: [
            {
              name: 'researcher',
              subagent_type: 'Explore',
              prompt: 'Inspect the inherited project resource snapshot.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a', workspaceRoot: '/workspace/run' }
      );

      expect(mockManager.startBackgroundAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: '/workspace/run',
          agentResources,
          modelResources,
          lspResources,
          reasoningEffort: 'high',
          serviceTier: 'fast',
          responseVerbosity: 'high',
          communicationStyle: 'friendly',
        })
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('defaults write-capable teammates to managed worktree isolation', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Writer Team',
          members: [
            {
              name: 'implementer',
              subagent_type: 'Implement',
              prompt: 'Implement the requested change and run focused tests.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a', workspaceRoot: '/workspace' }
      );

      expect(mockManager.startBackgroundAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'team-implementer-writer-team',
          isolation: 'worktree',
        })
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

      mockSessions.set('team-researcher-search-work', {
        ...mockSessions.get('team-researcher-search-work'),
        status: 'completed',
        result: { success: true, message: 'Found modules' },
        completedAt: Date.now(),
      });

      const result = await getTool(configDir, 'TeamStatus').execute({
        team_name: 'search-work',
      });
      const content = result.llmContent as {
        team: {
          members: Array<{
            name: string;
            status: string;
            agentId?: string;
            result?: { success: boolean; message: string };
          }>;
        };
      };

      expect(result.success).toBe(true);
      expect(content.team.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'researcher',
            status: 'completed',
            agentId: 'team-researcher-search-work',
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
      expect(mockManager.killAgent).toHaveBeenCalledWith(
        'team-researcher-stop-me',
        expect.objectContaining({ sessionId: 'session-a' })
      );

      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'teams', 'stop-me', 'config.json'),
          'utf-8'
        )
      );
      expect(stored.deletedAt).toEqual(expect.any(Number));
      expect(stored.members[1]).not.toHaveProperty('status');
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown teammate subagent types', async () => {
    const configDir = await createTempConfigDir();
    const registerBackgroundSubagent = vi.fn();
    const notifyBackgroundSubagentCompleted = vi.fn(async () => undefined);

    try {
      const result = await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Invalid Team',
          members: [
            {
              name: 'writer',
              subagent_type: 'Missing',
              prompt: 'Try to run as a missing agent type.',
            },
          ],
        },
        undefined,
        {
          sessionId: 'session-a',
          workspaceRoot: '/workspace',
          registerBackgroundSubagent,
          notifyBackgroundSubagentCompleted,
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid subagent type');
      expect(mockManager.startBackgroundAgent).not.toHaveBeenCalled();
      expect(registerBackgroundSubagent).not.toHaveBeenCalled();
      expect(notifyBackgroundSubagentCompleted).not.toHaveBeenCalled();
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('atomically claims only unblocked tasks assigned to the caller', async () => {
    const configDir = await createTempConfigDir();

    try {
      const graph = new TeamTaskGraph('claim-team', configDir);
      await graph.createTask({
        subject: 'Research',
        description: 'Collect facts',
        assignedTo: 'agent-a',
        priority: 'high',
      });
      await graph.createTask({
        subject: 'Implement',
        description: 'Apply changes',
        dependsOn: ['1'],
      });

      await expect(graph.claimNext('agent-b')).resolves.toBeNull();
      const claims = await Promise.all([
        graph.claimNext('agent-a'),
        graph.claimNext('agent-a'),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)).toMatchObject({ id: '1', owner: 'agent-a' });

      await graph.completeTask('1', 'done');
      await expect(graph.claimNext('agent-b')).resolves.toMatchObject({
        id: '2',
        owner: 'agent-b',
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('persists and delivers peer messages without leader relaying', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Peer Team',
          members: [
            {
              name: 'researcher',
              subagent_type: 'Explore',
              prompt: 'Research the implementation and report findings.',
            },
            {
              name: 'planner',
              subagent_type: 'Plan',
              prompt: 'Plan the implementation and challenge assumptions.',
            },
          ],
        },
        undefined,
        {
          sessionId: 'session-a',
          workspaceRoot: '/workspace',
        }
      );

      const send = await getTool(configDir, 'SendMessage').execute(
        {
          team_name: 'peer-team',
          to: 'planner',
          message: 'Review the task boundary.',
        },
        undefined,
        {
          sessionId: 'team-researcher-peer-team',
          taskListId: 'peer-team',
          workspaceRoot: '/workspace/.blade/worktrees/researcher',
        }
      );

      expect(send.success).toBe(true);
      expect(mockManager.enqueueSteering).toHaveBeenCalledWith(
        'team-planner-peer-team',
        expect.stringContaining('"body":"Review the task boundary."'),
        {
          sessionId: 'session-a',
          projectPath: '/workspace',
        }
      );
      const messages = await new TeamMailbox('peer-team', configDir).list(
        'team-planner-peer-team'
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        from: 'researcher',
        to: 'planner',
        deliveredAt: expect.any(Number),
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('drains messages that arrive before a teammate runtime is ready', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Durable Mailbox',
          members: [
            {
              name: 'reviewer',
              subagent_type: 'Explore',
              prompt: 'Review the result after receiving a teammate message.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a', workspaceRoot: '/workspace' }
      );

      mockManager.enqueueSteering.mockResolvedValueOnce(false);
      const send = await getTool(configDir, 'SendMessage').execute(
        {
          team_name: 'durable-mailbox',
          to: 'reviewer',
          message: 'Inspect the pending changes.',
        },
        undefined,
        { sessionId: 'session-a', workspaceRoot: '/workspace' }
      );
      expect(send.success).toBe(true);

      mockManager.enqueueSteering.mockResolvedValueOnce(true);
      const onStarted = startOptions.get('team-reviewer-durable-mailbox')?.onStarted as
        | ((agentId: string) => Promise<void>)
        | undefined;
      expect(onStarted).toBeTypeOf('function');
      await onStarted?.('team-reviewer-durable-mailbox');

      const messages = await new TeamMailbox('durable-mailbox', configDir).list(
        'team-reviewer-durable-mailbox'
      );
      expect(messages[0]?.deliveredAt).toEqual(expect.any(Number));
      expect(mockManager.enqueueSteering).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('publishes teammate messages to the lead and keeps them in the lead inbox', async () => {
    const configDir = await createTempConfigDir();
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === 'session-a') events.push(event);
    });

    try {
      await getTool(configDir, 'TeamCreate').execute(
        {
          team_name: 'Lead Inbox',
          members: [
            {
              name: 'reviewer',
              subagent_type: 'Explore',
              prompt: 'Review the implementation and message the team lead.',
            },
          ],
        },
        undefined,
        { sessionId: 'session-a', workspaceRoot: '/workspace' }
      );

      const sent = await getTool(configDir, 'SendMessage').execute(
        {
          team_name: 'lead-inbox',
          to: 'team-lead',
          message: 'The dependency edge is unsafe.',
        },
        undefined,
        {
          sessionId: 'team-reviewer-lead-inbox',
          taskListId: 'lead-inbox',
          workspaceRoot: '/workspace/.blade/worktrees/reviewer',
        }
      );
      expect(sent.success).toBe(true);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'team.message.received',
            properties: expect.objectContaining({
              teamName: 'lead-inbox',
              content: expect.stringContaining('The dependency edge is unsafe.'),
            }),
          }),
        ])
      );

      const inbox = await getTool(configDir, 'TeamInbox').execute(
        { team_name: 'lead-inbox' },
        undefined,
        { sessionId: 'session-a', workspaceRoot: '/workspace' }
      );
      expect(inbox.success).toBe(true);
      const inboxContent = inbox.llmContent as {
        messages: Array<{ from: string; to: string; body: string }>;
      };
      expect(inboxContent.messages).toEqual([
        expect.objectContaining({
          from: 'reviewer',
          to: 'team-lead',
          body: 'The dependency edge is unsafe.',
        }),
      ]);
    } finally {
      unsubscribe();
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('builtin team tool registration', () => {
  it('registers team tools only when the feature is enabled', async () => {
    const configDir = await createTempConfigDir();

    try {
      const disabledNames = (
        await getBuiltinTools({ sessionId: 'session-a', configDir })
      ).map((tool) => tool.name);
      expect(disabledNames).not.toContain('TeamCreate');

      const names = (
        await getBuiltinTools({
          sessionId: 'session-a',
          configDir,
          agentTeamsEnabled: true,
        })
      ).map((tool) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'TeamCreate',
          'TeamStatus',
          'TeamTaskClaim',
          'SendMessage',
          'TeamInbox',
          'TeamDelete',
        ])
      );
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
