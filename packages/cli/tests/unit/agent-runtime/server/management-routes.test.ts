import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRoutes } from '../../../../src/server/routes/mcp.js';
import { ModelsRoutes } from '../../../../src/server/routes/models.js';
import { SkillsRoutes } from '../../../../src/server/routes/skills.js';

const mocks = vi.hoisted(() => ({
  getAllServers: vi.fn(),
  getServerStatus: vi.fn(),
  registerServer: vi.fn(),
  beginOAuthLogin: vi.fn(),
  logoutOAuth: vi.fn(),
  getLogSnapshot: vi.fn(),
  setServerLoggingLevel: vi.fn(),
  complete: vi.fn(),
  getConfig: vi.fn(),
  initializeSkills: vi.fn(),
  getAllSkills: vi.fn(),
  getSkill: vi.fn(),
  refreshSkills: vi.fn(),
  resolveResources: vi.fn(),
  getAllModels: vi.fn(),
  getCurrentModel: vi.fn(),
  resolveModelConfig: vi.fn(),
}));

vi.mock('../../../../src/mcp/McpRegistry.js', () => ({
  McpRegistry: {
    getInstance: () => ({
      getAllServers: mocks.getAllServers,
      getServerStatus: mocks.getServerStatus,
      registerServer: mocks.registerServer,
      beginOAuthLogin: mocks.beginOAuthLogin,
      logoutOAuth: mocks.logoutOAuth,
      getLogSnapshot: mocks.getLogSnapshot,
      setServerLoggingLevel: mocks.setServerLoggingLevel,
      complete: mocks.complete,
    }),
  },
}));

vi.mock('../../../../src/skills/index.js', () => ({
  getSkillRegistry: () => ({
    initialize: mocks.initializeSkills,
    getAll: mocks.getAllSkills,
    get: mocks.getSkill,
    refresh: mocks.refreshSkills,
  }),
}));

vi.mock('../../../../src/agent/resources/WorkspaceAgentResources.js', () => ({
  resolveWorkspaceAgentResources: mocks.resolveResources,
  withWorkspaceAgentResources: async (
    _workspaceRoot: string,
    operation: (resources: unknown) => Promise<unknown>
  ) => operation(await mocks.resolveResources()),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  configActions: () => ({
    addModel: vi.fn(),
    updateModel: vi.fn(),
    removeModel: vi.fn(),
  }),
  getAllModels: mocks.getAllModels,
  getCurrentModel: mocks.getCurrentModel,
  getModelById: vi.fn(),
  getConfig: mocks.getConfig,
}));

vi.mock('../../../../src/services/pi/PiModelCatalog.js', () => ({
  getPiModelCatalog: () => ({
    resolveConfig: mocks.resolveModelConfig,
    getModel: vi.fn(),
    setApiKey: vi.fn(),
  }),
}));

describe('management routes', () => {
  beforeEach(() => {
    mocks.getAllServers.mockReset();
    mocks.getServerStatus.mockReset();
    mocks.registerServer.mockReset();
    mocks.beginOAuthLogin.mockReset();
    mocks.logoutOAuth.mockReset();
    mocks.getLogSnapshot.mockReset();
    mocks.setServerLoggingLevel.mockReset();
    mocks.complete.mockReset();
    mocks.getConfig.mockReset();
    mocks.initializeSkills.mockReset();
    mocks.getAllSkills.mockReset();
    mocks.getSkill.mockReset();
    mocks.refreshSkills.mockReset();
    mocks.resolveResources.mockReset();
    mocks.getAllModels.mockReset();
    mocks.getCurrentModel.mockReset();
    mocks.resolveModelConfig.mockReset();
    mocks.getAllServers.mockReturnValue(new Map());
    mocks.getServerStatus.mockReturnValue(null);
    mocks.registerServer.mockResolvedValue(undefined);
    mocks.getLogSnapshot.mockReturnValue({ revision: 0, entries: [] });
    mocks.setServerLoggingLevel.mockResolvedValue(undefined);
    mocks.complete.mockResolvedValue({
      values: ['production'],
      hasMore: false,
      sourceValueCount: 1,
      sourceBytes: 32,
      projectedBytes: 10,
      sha256: 'c'.repeat(64),
      truncated: false,
    });
    mocks.getConfig.mockReturnValue({ mcpServers: {} });
    mocks.initializeSkills.mockResolvedValue(undefined);
    mocks.getAllSkills.mockReturnValue([]);
    mocks.getSkill.mockReturnValue(undefined);
    mocks.refreshSkills.mockResolvedValue(undefined);
    mocks.resolveResources.mockImplementation(async () => {
      await mocks.initializeSkills();
      return {
        skills: {
          getAll: mocks.getAllSkills,
          get: mocks.getSkill,
          refresh: mocks.refreshSkills,
        },
      };
    });
    mocks.getAllModels.mockReturnValue([]);
    mocks.getCurrentModel.mockReturnValue(undefined);
  });

  it('returns a non-success status when MCP discovery fails', async () => {
    mocks.getAllServers.mockImplementation(() => {
      throw new Error('MCP registry unavailable');
    });

    const response = await McpRoutes().request('/');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'MCP registry unavailable',
    });
  });

  it('projects OAuth status without exposing credentials', async () => {
    mocks.getAllServers.mockReturnValue(
      new Map([
        [
          'remote',
          {
            status: 'error',
            config: {
              type: 'http',
              url: 'https://mcp.example.test/rpc',
              oauth: { enabled: true },
            },
            tools: [],
            contentCatalog: {
              resources: [],
              resourceTemplates: [],
              prompts: [],
            },
            lastError: new Error('authorization required'),
            instructions: {
              text: 'Use INSTRUCTION_CODE_42',
              sourceBytes: 23,
              projectedBytes: 23,
              sha256: 'b'.repeat(64),
              truncated: false,
              detailsOmitted: false,
            },
            client: {
              completionSupported: false,
              oauthEnabled: true,
              getOAuthStatus: vi.fn().mockResolvedValue('unauthenticated'),
            },
          },
        ],
      ])
    );

    const response = await McpRoutes().request('/');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([
      expect.objectContaining({
        id: 'remote',
        oauthEnabled: true,
        oauthStatus: 'unauthenticated',
        endpoint: 'https://mcp.example.test/rpc',
        instructions: expect.objectContaining({
          text: 'Use INSTRUCTION_CODE_42',
          sha256: 'b'.repeat(64),
        }),
      }),
    ]);
    expect(JSON.stringify(body).toLowerCase()).not.toContain('token');
  });

  it('projects MCP recovery progress without exposing raw transport URLs', async () => {
    mocks.getAllServers.mockReturnValue(
      new Map([
        [
          'recovering',
          {
            status: 'reconnecting',
            config: {
              type: 'stdio',
              command: 'node',
              args: ['server.mjs'],
            },
            tools: [],
            contentCatalog: {
              resources: [],
              resourceTemplates: [],
              prompts: [],
            },
            lastError: new Error('Connection closed'),
            recovery: {
              phase: 'reconnecting',
              reason: 'transport_closed',
              attempt: 2,
              maxAttempts: 5,
              nextRetryAt: 1_000,
              error: 'Connection closed',
            },
            client: {
              completionSupported: false,
              oauthEnabled: false,
              getOAuthStatus: vi.fn().mockResolvedValue('disabled'),
            },
          },
        ],
      ])
    );

    const response = await McpRoutes().request('/');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: 'recovering',
        status: 'reconnecting',
        recovery: expect.objectContaining({
          phase: 'reconnecting',
          attempt: 2,
          maxAttempts: 5,
        }),
      }),
    ]);
  });

  it('starts and clears OAuth only through explicit endpoints', async () => {
    mocks.getServerStatus.mockReturnValue({ config: { type: 'http' } });
    mocks.beginOAuthLogin.mockResolvedValue({
      flowId: 'flow-1',
      authorizationUrl: 'https://auth.example.test/authorize',
      callbackUrl: 'http://127.0.0.1:7777/oauth/callback',
      completion: new Promise<void>(() => undefined),
    });
    mocks.logoutOAuth.mockResolvedValue(undefined);

    const login = await McpRoutes().request('/remote/oauth/login', {
      method: 'POST',
    });
    expect(login.status).toBe(202);
    await expect(login.json()).resolves.toEqual({
      success: true,
      flowId: 'flow-1',
      authorizationUrl: 'https://auth.example.test/authorize',
    });
    expect(mocks.beginOAuthLogin).toHaveBeenCalledWith('remote');

    const logout = await McpRoutes().request('/remote/oauth/logout', {
      method: 'POST',
    });
    expect(logout.status).toBe(200);
    expect(mocks.logoutOAuth).toHaveBeenCalledWith('remote');
  });

  it('lists bounded MCP logs and validates explicit level changes', async () => {
    mocks.getServerStatus.mockReturnValue({ config: { type: 'stdio' } });
    mocks.getLogSnapshot.mockReturnValue({
      revision: 3,
      entries: [{ revision: 3, message: 'SAFE_LOG_MARKER' }],
    });

    const logs = await McpRoutes().request('/remote/logs?limit=10&afterRevision=1');
    expect(logs.status).toBe(200);
    expect(mocks.getLogSnapshot).toHaveBeenCalledWith('remote', {
      limit: 10,
      afterRevision: 1,
    });
    await expect(logs.json()).resolves.toMatchObject({ revision: 3 });

    const level = await McpRoutes().request('/remote/logging-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });
    expect(level.status).toBe(200);
    expect(mocks.setServerLoggingLevel).toHaveBeenCalledWith('remote', 'debug');

    const invalid = await McpRoutes().request('/remote/logging-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'verbose' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('completes MCP arguments only through the connected registry boundary', async () => {
    mocks.getServerStatus.mockReturnValue({ config: { type: 'stdio' } });
    const body = {
      reference: { type: 'prompt', name: 'deploy' },
      argument: { name: 'environment', value: 'pro' },
      context: { region: 'us-east-1' },
    };

    const response = await McpRoutes().request('/remote/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith('remote', body);
    await expect(response.json()).resolves.toMatchObject({
      values: ['production'],
      sha256: 'c'.repeat(64),
    });

    const invalid = await McpRoutes().request('/remote/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: { type: 'prompt' } }),
    });
    expect(invalid.status).toBe(400);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('returns a non-success status when skill discovery fails', async () => {
    mocks.initializeSkills.mockRejectedValue(new Error('Skill registry unavailable'));

    const response = await SkillsRoutes().request('/');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Skill registry unavailable',
    });
  });

  it('returns a non-success status when model discovery fails', async () => {
    mocks.getAllModels.mockImplementation(() => {
      throw new Error('Model registry unavailable');
    });

    const response = await ModelsRoutes().request('/');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get models',
      },
    });
  });

  it('returns a gateway error when the remote catalog is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    );

    const response = await SkillsRoutes().request('/catalog');

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'GitHub skills catalog returned 503',
    });
    vi.unstubAllGlobals();
  });

  it('loads catalog descriptions with bounded concurrency and stable order', async () => {
    let activeDescriptions = 0;
    let maxActiveDescriptions = 0;
    const directories = Array.from({ length: 8 }, (_, index) => ({
      name: `skill-${index}`,
      type: 'dir',
      path: `skills/skill-${index}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.github.com')) {
          return new Response(JSON.stringify(directories), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        activeDescriptions += 1;
        maxActiveDescriptions = Math.max(maxActiveDescriptions, activeDescriptions);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDescriptions -= 1;
        const name = url.split('/skills/')[1]?.split('/')[0] ?? 'unknown';
        return new Response(`# ${name}\n\nDescription for ${name}`, {
          status: 200,
        });
      })
    );

    const response = await SkillsRoutes().request('/catalog');
    const catalog = (await response.json()) as Array<{ name: string }>;

    expect(response.status).toBe(200);
    expect(maxActiveDescriptions).toBeGreaterThan(1);
    expect(maxActiveDescriptions).toBeLessThanOrEqual(6);
    expect(catalog.map((skill) => skill.name)).toEqual(
      directories.map((directory) => directory.name)
    );
    vi.unstubAllGlobals();
  });

  it('refuses to uninstall built-in or project skills', async () => {
    mocks.getSkill
      .mockReturnValueOnce({
        name: 'skill-creator',
        source: 'builtin',
        basePath: '',
      })
      .mockReturnValueOnce({
        name: 'project-skill',
        source: 'project',
        basePath: '/workspace/.blade/skills/project-skill',
      });
    const app = SkillsRoutes();

    const builtInResponse = await app.request('/skill-creator', {
      method: 'DELETE',
    });
    const projectResponse = await app.request('/project-skill', {
      method: 'DELETE',
    });

    expect(builtInResponse.status).toBe(400);
    expect(projectResponse.status).toBe(400);
    await expect(builtInResponse.json()).resolves.toMatchObject({
      success: false,
      error: 'Only Blade user skills can be uninstalled',
    });
    expect(mocks.refreshSkills).not.toHaveBeenCalled();
  });
});
