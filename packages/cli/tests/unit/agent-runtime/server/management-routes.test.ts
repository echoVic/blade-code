import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRoutes } from '../../../../src/server/routes/mcp.js';
import { ModelsRoutes } from '../../../../src/server/routes/models.js';
import { SkillsRoutes } from '../../../../src/server/routes/skills.js';

const mocks = vi.hoisted(() => ({
  getAllServers: vi.fn(),
  initializeSkills: vi.fn(),
  getAllSkills: vi.fn(),
  getSkill: vi.fn(),
  refreshSkills: vi.fn(),
  getAllModels: vi.fn(),
  getCurrentModel: vi.fn(),
  resolveModelConfig: vi.fn(),
}));

vi.mock('../../../../src/mcp/McpRegistry.js', () => ({
  McpRegistry: {
    getInstance: () => ({
      getAllServers: mocks.getAllServers,
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

vi.mock('../../../../src/store/vanilla.js', () => ({
  configActions: () => ({
    addModel: vi.fn(),
    updateModel: vi.fn(),
    removeModel: vi.fn(),
  }),
  getAllModels: mocks.getAllModels,
  getCurrentModel: mocks.getCurrentModel,
  getModelById: vi.fn(),
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
    mocks.initializeSkills.mockReset();
    mocks.getAllSkills.mockReset();
    mocks.getSkill.mockReset();
    mocks.refreshSkills.mockReset();
    mocks.getAllModels.mockReset();
    mocks.getCurrentModel.mockReset();
    mocks.resolveModelConfig.mockReset();
    mocks.getAllServers.mockReturnValue(new Map());
    mocks.initializeSkills.mockResolvedValue(undefined);
    mocks.getAllSkills.mockReturnValue([]);
    mocks.getSkill.mockReturnValue(undefined);
    mocks.refreshSkills.mockResolvedValue(undefined);
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
