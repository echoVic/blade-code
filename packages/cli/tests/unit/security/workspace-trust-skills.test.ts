import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ trusted: false }));

vi.mock('../../../src/security/WorkspaceTrustService.js', () => ({
  WorkspaceTrustService: {
    getInstance: () => ({
      getStatus: async () => ({
        state: mocks.trusted ? 'trusted' : 'untrusted',
      }),
    }),
  },
}));

vi.mock('../../../src/skills/SkillInstaller.js', () => ({
  getSkillInstaller: () => ({
    ensureDefaultSkillsInstalled: vi.fn(async () => undefined),
  }),
}));

import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';

describe('SkillRegistry workspace trust gate', () => {
  beforeEach(() => {
    SkillRegistry.resetInstance();
    mocks.trusted = false;
  });

  const initialize = async () => {
    const registry = SkillRegistry.getInstance({
      cwd: '/workspace',
      userSkillsDir: '/user/skills',
      projectSkillsDir: '/workspace/.blade/skills',
      claudeUserSkillsDir: '/user/claude-skills',
      claudeProjectSkillsDir: '/workspace/.claude/skills',
    });
    const scan = vi
      .spyOn(
        registry as unknown as {
          scanDirectory: (
            directory: string,
            source: 'user' | 'project'
          ) => Promise<{ skills: unknown[]; errors: unknown[] }>;
        },
        'scanDirectory'
      )
      .mockImplementation(async (directory, source) => ({
        skills: [
          {
            name: `${source}:${directory}`,
            description: 'fixture',
            source,
            path: directory,
          },
        ],
        errors: [],
      }));
    const result = await registry.initialize();
    return { result, scan };
  };

  it('does not scan project skill directories while untrusted', async () => {
    const { scan } = await initialize();
    expect(scan.mock.calls.map((call) => call[0])).toEqual([
      '/user/claude-skills',
      '/user/skills',
    ]);
  });

  it('scans user and project skill directories after trust', async () => {
    mocks.trusted = true;
    const { scan } = await initialize();
    expect(scan.mock.calls.map((call) => call[0])).toEqual([
      '/user/claude-skills',
      '/user/skills',
      '/workspace/.claude/skills',
      '/workspace/.blade/skills',
    ]);
  });
});
