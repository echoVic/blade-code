import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import { deriveAcpRemoteHostStateRoot } from '../../../../src/acp/AcpRemoteWorkspace.js';

const mocks = vi.hoisted(() => ({
  enabled: true,
  findSessionMetadata: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  getSnapshot: vi.fn(),
  sendMessage: vi.fn(),
  claimTask: vi.fn(),
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

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    findSessionMetadata: mocks.findSessionMetadata,
  },
}));

vi.mock('../../../../src/agent/subagents/SubagentRegistry.js', () => ({
  getSubagentRegistry: () => ({}),
}));

vi.mock('../../../../src/agent/teams/TeamRuntime.js', () => ({
  TeamRuntime: class {
    list = mocks.list;
    create = mocks.create;
    getSnapshot = mocks.getSnapshot;
    sendMessage = mocks.sendMessage;
    claimTask = mocks.claimTask;
    delete = mocks.delete;
  },
}));

import { BladeServerError } from '../../../../src/server/error.js';
import { TeamRoutes } from '../../../../src/server/routes/team.js';

const owner = {
  sessionId: 'session-a',
  projectPath: '/workspace/project',
};

describe('TeamRoutes', () => {
  beforeEach(() => {
    mocks.enabled = true;
    vi.clearAllMocks();
    mocks.findSessionMetadata.mockResolvedValue({
      sessionId: owner.sessionId,
      projectPath: owner.projectPath,
      selectedModelId: 'model-a',
    });
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ name: 'review-team' });
    mocks.sendMessage.mockResolvedValue([{ id: 'message-1' }]);
    mocks.claimTask.mockResolvedValue({ id: '1' });
    mocks.delete.mockResolvedValue({ name: 'review-team', status: 'deleted' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed when Agent Teams are disabled', async () => {
    mocks.enabled = false;
    const response = await TeamRoutes().request(
      `/?sessionId=${owner.sessionId}&projectPath=${encodeURIComponent(owner.projectPath)}`
    );

    expect(response.status).toBe(503);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('creates a team for the exact durable Session owner', async () => {
    const response = await TeamRoutes().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...owner,
        name: 'review-team',
        peerMessagingEnabled: true,
        members: [
          {
            name: 'reviewer',
            subagentType: 'Explore',
            prompt: 'Review the runtime implementation.',
          },
        ],
        tasks: [
          {
            subject: 'Inspect runtime',
            description: 'Review runtime changes',
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      name: 'review-team',
      description: undefined,
      leadAgentType: undefined,
      owner,
      modelId: 'model-a',
      peerMessagingEnabled: true,
      members: [
        {
          name: 'reviewer',
          subagentType: 'Explore',
          description: undefined,
          prompt: 'Review the runtime implementation.',
        },
      ],
      tasks: [
        {
          subject: 'Inspect runtime',
          description: 'Review runtime changes',
        },
      ],
    });
  });

  it('rejects missing and relative owner paths before runtime access', async () => {
    const missing = await TeamRoutes().request('/?sessionId=session-a');
    const relative = await TeamRoutes().request(
      '/?sessionId=session-a&projectPath=relative'
    );

    expect(missing.status).toBe(400);
    expect(relative.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('rejects a protected remote state root before resolving the Session owner', async () => {
    const descriptor = createAcpRemotePathProfile('/remote/team');
    const protectedRoot = deriveAcpRemoteHostStateRoot(
      descriptor.workspace.collisionIdentity
    );
    vi.stubEnv('BLADE_STORAGE_ROOT', path.dirname(path.dirname(protectedRoot)));

    const app = new Hono();
    app.onError((error, context) =>
      error instanceof BladeServerError
        ? context.json(error.toObject(), error.statusCode as 400)
        : context.json({ error: String(error) }, 500)
    );
    app.route('/teams', TeamRoutes());
    const response = await app.request(
      `/teams?sessionId=session-a&projectPath=${encodeURIComponent(protectedRoot)}`
    );

    expect(response.status).toBe(400);
    expect(mocks.findSessionMetadata).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
