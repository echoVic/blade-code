import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import type { BladeConfig } from '../../../../src/config/types.js';
import { projectPublicConfig } from '../../../../src/server/routes/config.js';

describe('ConfigRoutes', () => {
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
      maxQueuedTaskBytes: 64 * 1024 * 1024,
    });
  });
});
