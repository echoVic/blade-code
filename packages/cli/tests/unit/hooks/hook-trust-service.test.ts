import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getExternalHookDigest,
  HookTrustService,
} from '../../../src/hooks/HookTrustService.js';
import {
  type HookConfig,
  HookEvent,
  HookType,
} from '../../../src/hooks/types/HookTypes.js';

const execFileAsync = promisify(execFile);
vi.unmock('node:child_process');

function hookConfig(command = 'printf trusted'): HookConfig {
  return {
    enabled: true,
    PreToolUse: [
      {
        name: 'project-check',
        matcher: { tools: 'Bash' },
        hooks: [{ type: HookType.Command, command }],
      },
    ],
  };
}

describe('HookTrustService', () => {
  let root = '';
  let project = '';
  let trustFile = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-hook-trust-'));
    project = path.join(root, 'project');
    trustFile = path.join(root, 'state', 'hook-trust.json');
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('binds trust to the current external hook digest', async () => {
    const service = new HookTrustService(trustFile);
    const initial = await service.getStatus(project, hookConfig());
    expect(initial).toMatchObject({
      state: 'untrusted',
      configuredHooks: 1,
      currentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    const trusted = await service.trust(project, hookConfig(), initial.currentDigest!);
    expect(trusted.state).toBe('trusted');
    expect((await lstat(trustFile)).mode & 0o777).toBe(0o600);

    const modified = await service.getStatus(project, hookConfig('printf changed'));
    expect(modified.state).toBe('modified');
    expect(modified.currentDigest).not.toBe(trusted.currentDigest);

    const revoked = await service.revoke(project, hookConfig());
    expect(revoked.state).toBe('untrusted');
  });

  it('ignores in-process Function hooks when hashing configuration', () => {
    const base = hookConfig();
    const withFunction: HookConfig = {
      ...base,
      [HookEvent.PreToolUse]: [
        {
          ...base.PreToolUse![0],
          hooks: [
            ...base.PreToolUse![0].hooks,
            {
              type: HookType.Function,
              handler: async () => undefined,
            },
          ],
        },
      ],
    };

    expect(getExternalHookDigest(withFunction)).toBe(getExternalHookDigest(base));
  });

  it('attributes plugin hooks without binding trust to an absolute cache path', async () => {
    const withPluginRoot = (pluginRoot: string, pluginName = 'audit-plugin') => {
      const config = hookConfig();
      config.PreToolUse![0].hooks[0] = {
        ...config.PreToolUse![0].hooks[0],
        source: {
          kind: 'plugin',
          pluginName,
          pluginSource: 'project',
          pluginRoot,
        },
      };
      return config;
    };
    const first = withPluginRoot('/workspace/a/plugins/audit-plugin');
    const relocated = withPluginRoot('/workspace/b/plugins/audit-plugin');
    const renamed = withPluginRoot(
      '/workspace/b/plugins/renamed-plugin',
      'renamed-plugin'
    );

    expect(getExternalHookDigest(relocated)).toBe(getExternalHookDigest(first));
    expect(getExternalHookDigest(renamed)).not.toBe(getExternalHookDigest(first));
    const httpWithHeader = (value: string): HookConfig => ({
      enabled: true,
      PreToolUse: [
        {
          hooks: [
            {
              type: HookType.Http,
              url: 'https://hooks.example.test/check',
              headers: { pluginRoot: value },
            },
          ],
        },
      ],
    });
    expect(getExternalHookDigest(httpWithHeader('a'))).not.toBe(
      getExternalHookDigest(httpWithHeader('b'))
    );
    await expect(
      new HookTrustService(trustFile).getStatus(project, first)
    ).resolves.toMatchObject({
      definitions: [
        expect.objectContaining({
          pluginName: 'audit-plugin',
          pluginSource: 'project',
        }),
      ],
    });
  });

  it('fails closed for loose permissions and symlink stores', async () => {
    const service = new HookTrustService(trustFile);
    await service.trust(project, hookConfig());
    await chmod(trustFile, 0o644);
    await expect(service.getStatus(project, hookConfig())).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('0600'),
    });
    await expect(service.trust(project, hookConfig())).rejects.toThrow('0600');

    const target = path.join(root, 'target.json');
    const link = path.join(root, 'link.json');
    await writeFile(target, '{"version":1,"projects":{}}\n', {
      mode: 0o600,
    });
    await symlink(target, link);
    const linkedService = new HookTrustService(link);
    await expect(linkedService.getStatus(project, hookConfig())).resolves.toMatchObject(
      {
        state: 'error',
        error: expect.stringContaining('regular file'),
      }
    );
  });

  it('shares one trust identity across Git worktrees', async () => {
    await execFileAsync('git', ['init', '-q', project]);
    await execFileAsync('git', [
      '-C',
      project,
      'config',
      'user.email',
      'test@example.com',
    ]);
    await execFileAsync('git', ['-C', project, 'config', 'user.name', 'Test']);
    await writeFile(path.join(project, 'README.md'), 'fixture\n');
    const nestedProject = path.join(project, 'packages', 'app');
    await mkdir(nestedProject, { recursive: true });
    await writeFile(path.join(nestedProject, 'package.json'), '{}\n');
    await execFileAsync('git', ['-C', project, 'add', '.']);
    await execFileAsync('git', ['-C', project, 'commit', '-qm', 'init']);
    const worktree = path.join(root, 'worktree');
    await execFileAsync('git', [
      '-C',
      project,
      'worktree',
      'add',
      '-qb',
      'trust-worktree',
      worktree,
    ]);

    const service = new HookTrustService(trustFile);
    const trusted = await service.trust(project, hookConfig());
    const fromWorktree = await service.getStatus(worktree, hookConfig());

    expect(fromWorktree.state).toBe('trusted');
    expect(fromWorktree.trustRoot).toBe(trusted.trustRoot);

    const nestedConfig = hookConfig('printf nested');
    const nestedTrusted = await service.trust(nestedProject, nestedConfig);
    const nestedFromWorktree = await service.getStatus(
      path.join(worktree, 'packages', 'app'),
      nestedConfig
    );
    expect(nestedFromWorktree.state).toBe('trusted');
    expect(nestedFromWorktree.trustRoot).toBe(await realpath(nestedProject));
    expect(nestedFromWorktree.trustRoot).toBe(nestedTrusted.trustRoot);
    expect(nestedFromWorktree.trustRoot).not.toBe(trusted.trustRoot);
  });
});
