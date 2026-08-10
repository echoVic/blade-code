import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';

vi.unmock('node:child_process');

describe('WorkspaceTrustService', () => {
  let root = '';
  let project = '';
  let storeDir = '';

  const writeProjectConfig = async (value: unknown) => {
    await mkdir(path.join(project, '.blade'), { recursive: true });
    await writeFile(
      path.join(project, '.blade', 'config.json'),
      `${JSON.stringify(value, null, 2)}\n`
    );
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-workspace-trust-'));
    project = path.join(root, 'project');
    storeDir = path.join(root, 'trust');
    await mkdir(project, { recursive: true });
    resetWorkspaceIdentityCache();
  });

  afterEach(async () => {
    resetWorkspaceIdentityCache();
    await rm(root, { recursive: true, force: true });
  });

  it('does not require folder trust when only project hooks are configured', async () => {
    await mkdir(path.join(project, '.blade'), { recursive: true });
    await writeFile(
      path.join(project, '.blade', 'settings.json'),
      JSON.stringify({
        hooks: {
          enabled: true,
          PreToolUse: [
            {
              hooks: [{ type: 'command', command: 'printf reviewed' }],
            },
          ],
        },
      })
    );

    const service = new WorkspaceTrustService(storeDir);
    const status = await service.getStatus(project);
    expect(status).toMatchObject({
      state: 'not_required',
      trusted: true,
      sensitiveSources: 0,
    });
    expect(service.isTrustedCached(project)).toBe(false);
  });

  it('requires explicit trust before package scripts may execute', async () => {
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        scripts: {
          'type-check': 'node scripts/type-check.mjs',
          test: 'vitest run',
        },
      })
    );

    const service = new WorkspaceTrustService(storeDir);
    const pending = await service.getStatus(project);
    expect(pending).toMatchObject({
      state: 'untrusted',
      trusted: false,
      sensitiveSources: 1,
    });
    expect(pending.sources).toContainEqual(
      expect.objectContaining({
        path: 'package.json',
        kind: 'package',
        keys: ['test', 'type-check'],
      })
    );
    expect(JSON.stringify(pending)).not.toContain('node scripts/type-check.mjs');

    await expect(service.trust(project)).resolves.toMatchObject({
      state: 'trusted',
      trusted: true,
    });
  });

  it('reviews sensitive project effects without exposing secrets', async () => {
    const secret = 'workspace-secret-value';
    await writeProjectConfig({
      currentModelId: 'project-model',
      models: [
        {
          id: 'project-model',
          provider: 'openai',
          model: 'gpt-project',
          overrides: {
            baseUrl: `https://model.example.com/v1?token=${secret}`,
            customHeaders: { authorization: secret },
          },
        },
      ],
      modelProviders: {
        project: {
          name: 'Project',
          baseUrl: `https://provider.example.com/v1?key=${secret}`,
          wireApi: 'openai-completions',
        },
      },
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: secret },
        },
      },
      lspServers: {
        typescript: {
          command: 'typescript-language-server',
          args: ['--token', secret],
          extensionToLanguage: { '.ts': 'typescript' },
          env: { LSP_TOKEN: secret },
        },
      },
      permissions: {
        allow: ['Bash(*)'],
        ask: [],
        deny: [],
      },
      env: {
        BASH_ENV: secret,
      },
    });

    const status = await new WorkspaceTrustService(storeDir).getStatus(project);
    const serialized = JSON.stringify(status);
    expect(status).toMatchObject({
      state: 'untrusted',
      trusted: false,
      sensitiveSources: 1,
      decision: 'undecided',
    });
    expect(serialized).toContain('node server.js');
    expect(serialized).toContain('typescript-language-server');
    expect(serialized).toContain('typescript (.ts)');
    expect(serialized).toContain('https://model.example.com/v1');
    expect(serialized).toContain('allow: Bash(*)');
    expect(serialized).toContain('BASH_ENV');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('authorization');
  });

  it('treats project commands, skills, agents, and plugins as trust-gated', async () => {
    for (const [relativeDir, name] of [
      ['.blade/commands', 'review.md'],
      ['.blade/skills', 'project-skill'],
      ['.blade/agents', 'project-agent.md'],
      ['.blade/plugins', 'project-plugin'],
    ]) {
      const directory = path.join(project, relativeDir);
      await mkdir(directory, { recursive: true });
      const resource = path.join(directory, name);
      if (path.extname(name)) {
        await writeFile(resource, 'fixture\n');
      } else {
        await mkdir(resource);
      }
    }

    const status = await new WorkspaceTrustService(storeDir).getStatus(project);
    expect(status.state).toBe('untrusted');
    expect(status.sources.map((source) => source.kind)).toEqual(
      expect.arrayContaining(['commands', 'skills', 'agents', 'plugins'])
    );
    expect(
      status.sources.flatMap((source) => source.effects.map((effect) => effect.kind))
    ).toEqual(expect.arrayContaining(['command', 'skill', 'agent', 'plugin']));
  });

  it('persists owner-only decisions with parent inheritance and child override', async () => {
    const child = path.join(project, 'packages', 'app');
    await mkdir(child, { recursive: true });
    await mkdir(path.join(child, '.blade'), { recursive: true });
    await writeFile(
      path.join(child, '.blade', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'], ask: [], deny: [] },
      })
    );
    const service = new WorkspaceTrustService(storeDir);

    await service.trust(project);
    const inherited = await service.getStatus(child);
    expect(inherited).toMatchObject({
      state: 'trusted',
      trusted: true,
      decision: 'inherited',
    });

    const denied = await service.revoke(child);
    expect(denied).toMatchObject({
      state: 'untrusted',
      trusted: false,
      decision: 'untrusted',
    });

    const files = await readdir(storeDir);
    expect(files.filter((file) => file.endsWith('.json'))).toHaveLength(2);
    expect((await stat(storeDir)).mode & 0o777).toBe(0o700);
    for (const file of files) {
      expect((await stat(path.join(storeDir, file))).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed when trust storage permissions are too broad', async () => {
    await writeProjectConfig({ mcpServers: { unsafe: { type: 'stdio' } } });
    const service = new WorkspaceTrustService(storeDir);
    await service.trust(project);
    await chmod(storeDir, 0o755);

    await expect(service.getStatus(project)).resolves.toMatchObject({
      state: 'error',
      trusted: false,
      error: expect.stringContaining('0700'),
    });
    await expect(service.revoke(project)).rejects.toThrow('0700');
  });

  it('does not follow a symlink trust directory while writing', async () => {
    await writeProjectConfig({ mcpServers: { unsafe: { type: 'stdio' } } });
    const target = path.join(root, 'external-target');
    await mkdir(target);
    await symlink(target, storeDir);

    await expect(new WorkspaceTrustService(storeDir).trust(project)).rejects.toThrow(
      'regular directory'
    );
    expect(await readdir(target)).toEqual([]);
  });

  it('refuses over-broad trust roots', async () => {
    const service = new WorkspaceTrustService(storeDir);
    await expect(service.trust(os.homedir())).rejects.toThrow(
      'filesystem root or user home'
    );
    await expect(service.trust(path.parse(project).root)).rejects.toThrow(
      'filesystem root or user home'
    );
  });
});
