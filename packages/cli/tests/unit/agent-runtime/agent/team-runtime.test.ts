import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../../src/agent/subagents/AgentSessionStore.js';
import type { StartBackgroundAgentOptions } from '../../../../src/agent/subagents/BackgroundAgentManager.js';

const mocks = vi.hoisted(() => ({
  callbacks: new Map<
    string,
    Pick<StartBackgroundAgentOptions, 'onStarted' | 'onCompleted'>
  >(),
  enqueueSteering: vi.fn<(agentId: string, content: string) => Promise<boolean>>(),
  getAgent: vi.fn<(agentId: string) => AgentSession | undefined>(),
  killAgent: vi.fn<(agentId: string) => boolean>(),
  sessions: new Map<string, AgentSession>(),
  startBackgroundAgent: vi.fn<(options: StartBackgroundAgentOptions) => string>(),
}));

vi.mock('../../../../src/agent/subagents/BackgroundAgentManager.js', () => ({
  BackgroundAgentManager: {
    getInstance: () => ({
      enqueueSteering: mocks.enqueueSteering,
      getAgent: mocks.getAgent,
      killAgent: mocks.killAgent,
      startBackgroundAgent: mocks.startBackgroundAgent,
    }),
  },
}));

import { SubagentRegistry } from '../../../../src/agent/subagents/SubagentRegistry.js';
import {
  MAX_TEAM_MEMBERS,
  MAX_TEAM_TASKS,
  type TeamMemberInput,
  TeamRuntime,
  type TeamTaskInput,
} from '../../../../src/agent/teams/TeamRuntime.js';
import { TeamTaskGraph } from '../../../../src/agent/teams/TeamTaskGraph.js';
import { Bus, type BusEvent } from '../../../../src/server/bus.js';

const owner = { sessionId: 'lead-session', projectPath: '/workspace/project' };
const prompt = 'Complete the assigned team task carefully.';
let configDir: string;
let events: BusEvent[];
let unsubscribe: () => void;
let registry: SubagentRegistry;
let runtime: TeamRuntime;

function session(options: StartBackgroundAgentOptions): AgentSession {
  const id = options.agentId ?? 'generated-agent';
  return {
    schemaVersion: 2,
    id,
    subagentType: options.config.name,
    description: options.description,
    prompt: options.prompt,
    messages: [],
    status: 'running',
    background: true,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    parentSessionId: options.parentSessionId,
    providerAdmissionOwnerId: options.providerAdmissionOwnerId,
    parentProjectPath: options.parentProjectPath,
    rootAgentId: id,
    resumeDepth: 0,
    taskListId: options.taskListId,
    teamId: options.teamId,
    workspaceRoot: options.workspaceRoot,
    isolation: options.isolation,
  };
}

function start(options: StartBackgroundAgentOptions): string {
  const child = session(options);
  mocks.sessions.set(child.id, child);
  mocks.callbacks.set(child.id, {
    onStarted: options.onStarted,
    onCompleted: options.onCompleted,
  });
  return child.id;
}

function member(name: string, subagentType = 'reader'): TeamMemberInput {
  return { name, subagentType, prompt };
}

async function create(
  members: TeamMemberInput[],
  tasks: TeamTaskInput[] = [],
  peerMessagingEnabled = true
) {
  return runtime.create({
    name: 'review-team',
    description: 'Review the runtime',
    owner,
    modelId: 'parent-model',
    peerMessagingEnabled,
    members,
    tasks,
  });
}

describe('TeamRuntime', () => {
  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'blade-team-runtime-'));
    events = [];
    unsubscribe = Bus.subscribe((event) => events.push(event));
    registry = new SubagentRegistry(owner.projectPath);
    registry.register({
      name: 'reader',
      description: 'Read-only reviewer',
      tools: ['Read'],
      model: 'inherit',
    });
    registry.register({
      name: 'writer',
      description: 'Editing worker',
      tools: ['Edit'],
      model: 'worker-model',
    });
    runtime = new TeamRuntime({
      configDir,
      subagentRegistry: registry,
      getReasoningEffort: () => 'high',
      getServiceTier: () => 'fast',
      getResponseVerbosity: () => 'high',
      getCommunicationStyle: () => 'explanatory',
    });
    mocks.callbacks.clear();
    mocks.sessions.clear();
    vi.clearAllMocks();
    mocks.startBackgroundAgent.mockImplementation(start);
    mocks.getAgent.mockImplementation((agentId) => mocks.sessions.get(agentId));
    mocks.enqueueSteering.mockResolvedValue(true);
    mocks.killAgent.mockImplementation((agentId) => {
      const child = mocks.sessions.get(agentId);
      if (child) child.status = 'cancelled';
      return Boolean(child);
    });
  });

  afterEach(async () => {
    unsubscribe();
    await rm(configDir, { recursive: true, force: true });
  });

  it('creates members with effective tools, models, isolation, and task dependencies', async () => {
    const snapshot = await create(
      [member('reader'), member('writer', 'writer')],
      [
        { subject: 'Inspect', description: 'Inspect code', assignedTo: 'reader' },
        { subject: 'Edit', description: 'Apply edits', dependsOn: ['1'] },
      ]
    );

    expect(snapshot.status).toBe('running');
    expect(
      snapshot.tasks.map(({ status, owner: taskOwner }) => [status, taskOwner])
    ).toEqual([
      ['pending', 'team-reader-review-team'],
      ['blocked', undefined],
    ]);
    const [readerStart, writerStart] = mocks.startBackgroundAgent.mock.calls.map(
      ([options]) => options
    );
    expect(readerStart.config).toMatchObject({
      model: 'parent-model',
      isolation: 'none',
      tools: ['Read', 'TeamTaskClaim', 'TeamInbox', 'SendMessage'],
    });
    expect(writerStart.config).toMatchObject({
      model: 'worker-model',
      isolation: 'worktree',
    });
    expect(readerStart).toMatchObject({
      parentSessionId: owner.sessionId,
      providerAdmissionOwnerId: owner.sessionId,
      reasoningEffort: 'high',
      serviceTier: 'fast',
      responseVerbosity: 'high',
      communicationStyle: 'explanatory',
    });
    expect(readerStart.prompt).toContain('Shared task graph: review-team');
    expect(events.map((event) => event.type)).toEqual([
      'team.created',
      'team.member.spawned',
      'team.member.spawned',
    ]);
  });

  it('rejects invalid members and task declarations before launching workers', async () => {
    const tooManyMembers = Array.from({ length: MAX_TEAM_MEMBERS + 1 }, (_, index) =>
      member(`member-${index}`)
    );
    await expect(create(tooManyMembers)).rejects.toThrow('cannot exceed');
    await expect(create([member('Team Lead')])).rejects.toThrow('reserved');
    await expect(create([member('same'), member('SAME')])).rejects.toThrow('Duplicate');
    await expect(create([{ ...member('short'), prompt: 'short' }])).rejects.toThrow(
      '10-32768'
    );
    await expect(create([member('missing', 'unknown')])).rejects.toThrow(
      'Invalid subagent'
    );
    await expect(
      create(
        [member('reader')],
        [{ subject: 'Invalid', description: 'Invalid', assignedTo: 'missing' }]
      )
    ).rejects.toThrow('Unknown assigned teammate');
    await expect(
      create(
        [member('reader')],
        Array.from({ length: MAX_TEAM_TASKS + 1 }, (_, index) => ({
          subject: `Task ${index}`,
          description: 'Task',
        }))
      )
    ).rejects.toThrow('cannot exceed');
    expect(mocks.startBackgroundAgent).not.toHaveBeenCalled();
    expect(await runtime.list(owner)).toEqual([]);
  });

  it('rolls back a partially started team and loads an empty registry once', async () => {
    const emptyRegistry = new SubagentRegistry('/empty');
    vi.spyOn(emptyRegistry, 'loadFromStandardLocations').mockImplementation(() => {
      emptyRegistry.register({
        name: 'reader',
        description: 'Loaded reader',
        tools: ['Read'],
      });
      return 1;
    });
    runtime = new TeamRuntime({ configDir, subagentRegistry: emptyRegistry });
    mocks.startBackgroundAgent
      .mockImplementationOnce(start)
      .mockImplementationOnce(() => {
        throw new Error('start failed');
      });

    await expect(create([member('one'), member('two')])).rejects.toThrow(
      'start failed'
    );
    expect(emptyRegistry.loadFromStandardLocations).toHaveBeenCalledOnce();
    expect(mocks.killAgent).toHaveBeenCalledWith('team-one-review-team', owner);
    expect(await runtime.list(owner)).toEqual([]);
    expect((await runtime.getSnapshot('review-team', owner)).status).toBe('deleted');
    expect(events.at(-1)?.properties).toMatchObject({ reason: 'startup_failed' });
  });

  it('enforces ownership and projects task and member lifecycle states', async () => {
    const snapshot = await create(
      [member('reader')],
      [{ subject: 'Inspect', description: 'Inspect code' }]
    );
    const agentId = snapshot.members[1].agentId as string;
    await expect(
      runtime.getSnapshot('review-team', {
        sessionId: 'other',
        projectPath: owner.projectPath,
      })
    ).rejects.toThrow('Team not found');
    await expect(runtime.claimTask('review-team', 'team-lead', owner)).rejects.toThrow(
      'Unknown teammate'
    );
    await expect(
      runtime.claimTask('review-team', agentId, undefined, 'impostor')
    ).rejects.toThrow('Team not found');

    const task = await runtime.claimTask('review-team', agentId, owner);
    expect(task?.status).toBe('running');
    const child = mocks.sessions.get(agentId) as AgentSession;
    child.status = 'failed';
    expect((await runtime.getSnapshot('review-team', owner)).status).toBe('failed');
    child.status = 'completed';
    child.result = { success: true, message: 'done' };
    await new TeamTaskGraph('review-team', configDir).completeTask(task?.id ?? '');
    expect((await runtime.getSnapshot('review-team', owner)).status).toBe('completed');
    mocks.sessions.delete(agentId);
    expect((await runtime.getSnapshot('review-team', owner)).status).toBe('idle');
    const deleted = await runtime.delete('review-team', {
      owner,
      killRunning: false,
    });
    expect(deleted.status).toBe('deleted');
    expect(await runtime.list(owner)).toEqual([]);
  });

  it('persists, delivers, acknowledges, and publishes teammate messages', async () => {
    const snapshot = await create([member('alpha'), member('beta')]);
    const alphaId = snapshot.members[1].agentId as string;
    const betaId = snapshot.members[2].agentId as string;

    const [direct] = await runtime.sendMessage({
      name: 'review-team',
      to: 'alpha',
      body: 'lead review',
      owner,
    });
    expect(
      (await runtime.inbox({ name: 'review-team', recipient: alphaId, owner }))[0]
    ).toMatchObject({ id: direct.id, deliveredAt: expect.any(Number) });

    mocks.enqueueSteering.mockResolvedValueOnce(false);
    const broadcast = await runtime.sendMessage({
      name: 'review-team',
      fromAgentId: alphaId,
      to: '*',
      body: 'peer update',
    });
    expect(broadcast.map((message) => message.to)).toEqual(['team-lead', 'beta']);
    await mocks.callbacks.get(betaId)?.onStarted?.(betaId);
    const betaInbox = await runtime.inbox({
      name: 'review-team',
      recipient: betaId,
      actorAgentId: betaId,
      acknowledge: [broadcast[1].id],
    });
    expect(betaInbox.at(-1)).toMatchObject({
      deliveredAt: expect.any(Number),
      acknowledgedAt: expect.any(Number),
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['team.message.received', 'team.message.sent'])
    );
    await expect(
      runtime.sendMessage({
        name: 'review-team',
        fromAgentId: 'impostor',
        to: 'alpha',
        body: 'no',
      })
    ).rejects.toThrow('sender is unavailable');
  });

  it('completes owned work, unblocks dependencies, and emits terminal state', async () => {
    const completed = vi.fn();
    const snapshot = await runtime.create({
      name: 'review-team',
      owner,
      members: [member('reader')],
      tasks: [
        { subject: 'First', description: 'First' },
        { subject: 'Second', description: 'Second', dependsOn: ['1'] },
      ],
      onMemberCompleted: completed,
    });
    const agentId = snapshot.members[1].agentId as string;
    await runtime.claimTask('review-team', agentId, owner);
    const child = mocks.sessions.get(agentId) as AgentSession;
    child.status = 'completed';
    child.result = { success: true, message: 'finished' };

    await mocks.callbacks.get(agentId)?.onCompleted?.(child);

    const final = await runtime.getSnapshot('review-team', owner);
    expect(
      Object.fromEntries(final.tasks.map(({ id, status }) => [id, status]))
    ).toEqual({ 1: 'completed', 2: 'pending' });
    expect(final.status).toBe('failed');
    expect(completed).toHaveBeenCalledWith(child);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'team.task.claimed',
        'team.task.unblocked',
        'team.member.completed',
        'team.completed',
      ])
    );
  });
});
