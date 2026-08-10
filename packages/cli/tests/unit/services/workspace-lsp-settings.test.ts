import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { snapshotWorkspaceLspResources } from '../../../src/lsp/WorkspaceLspResources.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('workspace LSP settings', () => {
  let root: string;
  let home: string;
  let trusted: string;
  let untrusted: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-lsp-settings-'));
    home = path.join(root, 'home');
    trusted = path.join(root, 'trusted');
    untrusted = path.join(root, 'untrusted');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('BLADE_STORAGE_ROOT', path.join(root, 'storage'));
    await writeJson(path.join(home, '.blade', 'config.json'), {
      lspServers: {
        shared: {
          command: 'user-lsp',
          extensionToLanguage: { '.ts': 'typescript' },
        },
        user: {
          command: 'user-only-lsp',
          extensionToLanguage: { '.js': 'javascript' },
        },
      },
    });
    for (const workspace of [trusted, untrusted]) {
      await writeJson(path.join(workspace, '.blade', 'config.json'), {
        lspServers: {
          shared: {
            command: 'project-lsp',
            extensionToLanguage: { '.ts': 'typescript' },
          },
          project: {
            command: 'project-only-lsp',
            extensionToLanguage: { '.go': 'go' },
          },
        },
      });
    }
    ConfigManager.resetInstance();
    WorkspaceTrustService.resetInstance();
    await WorkspaceTrustService.getInstance().trust(trusted);
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    WorkspaceTrustService.resetInstance();
    homedirSpy.mockRestore();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses exact trusted project config without leaking another workspace', async () => {
    const servers = await ConfigManager.getInstance().loadWorkspaceLspServers(
      trusted,
      {}
    );
    expect(servers.shared?.command).toBe('project-lsp');
    expect(servers.user?.command).toBe('user-only-lsp');
    expect(servers.project?.command).toBe('project-only-lsp');
  });

  it('keeps project LSP executables blocked before Workspace Trust', async () => {
    const servers = await ConfigManager.getInstance().loadWorkspaceLspServers(
      untrusted,
      {}
    );
    expect(servers.shared?.command).toBe('user-lsp');
    expect(servers.user?.command).toBe('user-only-lsp');
    expect(servers.project).toBeUndefined();
  });

  it('creates an immutable Session snapshot', () => {
    const source = {
      projectRoot: trusted,
      servers: {
        typescript: {
          command: 'server-v1',
          extensionToLanguage: { '.ts': 'typescript' },
        },
      },
    };
    const snapshot = snapshotWorkspaceLspResources(source);
    source.servers.typescript.command = 'server-v2';

    expect(snapshot.servers.typescript?.command).toBe('server-v1');
    expect(Object.isFrozen(snapshot.servers)).toBe(true);
  });
});
