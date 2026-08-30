import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import type { BladeConfig } from '../../../../src/config/types.js';
import { BladeServerError } from '../../../../src/server/error.js';
import {
  ConfigRoutes,
  projectPublicConfig,
} from '../../../../src/server/routes/config.js';

const storeMocks = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  configActions: () => ({
    updateConfig: storeMocks.updateConfig,
  }),
  getConfig: storeMocks.getConfig,
}));

describe('ConfigRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.getConfig.mockReturnValue(DEFAULT_CONFIG);
  });

  it('projects only fields required by the Web settings UI', () => {
    const config = {
      ...DEFAULT_CONFIG,
      env: { SECRET_TOKEN: 'env-secret' },
      models: [
        {
          id: 'legacy-model',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          apiKey: 'model-secret',
        },
      ],
    } as unknown as BladeConfig;

    const serialized = JSON.stringify(projectPublicConfig(config));

    expect(serialized).not.toContain('env-secret');
    expect(serialized).not.toContain('model-secret');
    expect(serialized).not.toContain('models');
    expect(projectPublicConfig(config)).toMatchObject({
      language: DEFAULT_CONFIG.language,
      codeTheme: DEFAULT_CONFIG.codeTheme,
      uiTheme: DEFAULT_CONFIG.uiTheme,
      agentTeamsEnabled: false,
      maxQueuedTaskBytes: 64 * 1024 * 1024,
      maxResidentSessionProjections: 256,
      sessionProjectionIdleMs: 1_800_000,
    });
  });

  it('rejects project-scoped session projection residency updates with typed 400', async () => {
    storeMocks.updateConfig.mockRejectedValueOnce(
      new Error('Field \"maxResidentSessionProjections\" only supports scopes: global')
    );

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof BladeServerError) {
        return c.json(error.toObject(), error.statusCode as 400);
      }
      throw error;
    });
    app.route('/configs', ConfigRoutes());

    const response = await app.request('/configs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        updates: { maxResidentSessionProjections: 99 },
        options: { scope: 'project', immediate: true },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Field \"maxResidentSessionProjections\" only supports scopes: global',
      },
    });
    expect(storeMocks.updateConfig).toHaveBeenCalledWith(
      { maxResidentSessionProjections: 99 },
      { scope: 'project', immediate: true }
    );
  });
});
