import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  sourcePath: '',
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

import { PluginInstaller } from '../../../src/plugins/PluginInstaller.js';

describe('PluginInstaller Git transport', () => {
  let root: string;
  let installer: PluginInstaller;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-plugin-git-'));
    mocks.sourcePath = path.join(root, 'source');
    await fs.mkdir(path.join(mocks.sourcePath, '.blade-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(mocks.sourcePath, '.blade-plugin', 'plugin.json'),
      `${JSON.stringify({
        name: 'git-plugin',
        description: 'Git transport fixture',
        version: '1.0.0',
      })}\n`,
      'utf8'
    );
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        executable: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        void (async () => {
          if (executable !== 'git') {
            callback(new Error(`Unexpected executable: ${executable}`));
            return;
          }
          if (args[0] === 'clone') {
            await fs.cp(mocks.sourcePath, args.at(-1)!, { recursive: true });
            callback(null, '', '');
            return;
          }
          if (args[0] === 'rev-parse') {
            callback(null, '1234567890abcdef1234567890abcdef12345678\n', '');
            return;
          }
          if (['init', 'remote', 'fetch', 'checkout'].includes(args[0])) {
            callback(null, '', '');
            return;
          }
          callback(new Error(`Unexpected Git args: ${args.join(' ')}`));
        })().catch((error) =>
          callback(error instanceof Error ? error : new Error(String(error)))
        );
        return undefined;
      }
    );
    installer = new PluginInstaller(
      path.join(root, 'legacy'),
      path.join(root, 'state')
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('passes an HTTPS source as an execFile argument and records the exact commit', async () => {
    const result = await installer.install('https://example.com/git-plugin.git', {
      trusted: true,
    });
    expect(result).toMatchObject({
      success: true,
      pluginName: 'git-plugin',
      installation: {
        revision: '1234567890abcdef1234567890abcdef12345678',
      },
    });
    expect(mocks.execFile).toHaveBeenNthCalledWith(
      1,
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--no-tags',
        '--',
        'https://example.com/git-plugin.git',
        expect.any(String),
      ],
      expect.objectContaining({
        encoding: 'utf8',
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
      }),
      expect.any(Function)
    );
  });

  it('rejects unpinned or disallowed Git sources before invoking Git', async () => {
    const basePolicy = {
      restrictToAllowedSources: false,
      requireGitCommitSha: true,
      allowedGitHosts: [],
      allowedMarketplaces: [],
      allowedLocalRoots: [],
    };
    await expect(
      installer.install('https://example.com/git-plugin.git', {
        trusted: true,
        policy: basePolicy,
      })
    ).resolves.toMatchObject({
      success: false,
      code: 'PLUGIN_GIT_SHA_REQUIRED',
    });
    expect(mocks.execFile).not.toHaveBeenCalled();

    await expect(
      installer.install('https://example.com/git-plugin.git', {
        trusted: true,
        policy: {
          ...basePolicy,
          requireGitCommitSha: false,
          restrictToAllowedSources: true,
          allowedGitHosts: ['github.com'],
        },
      })
    ).resolves.toMatchObject({
      success: false,
      code: 'PLUGIN_SOURCE_BLOCKED',
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('fails closed when a pinned checkout resolves to another commit', async () => {
    await expect(
      installer.install('https://example.com/git-plugin.git', {
        trusted: true,
        ref: 'a'.repeat(40),
        policy: {
          restrictToAllowedSources: false,
          requireGitCommitSha: true,
          allowedGitHosts: [],
          allowedMarketplaces: [],
          allowedLocalRoots: [],
        },
      })
    ).resolves.toMatchObject({
      success: false,
      code: 'GIT_PIN_MISMATCH',
    });
  });
});
