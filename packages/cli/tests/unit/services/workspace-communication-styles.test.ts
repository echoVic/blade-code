import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_COMMUNICATION_STYLE_PROMPT_BYTES,
  resolveWorkspaceCommunicationStyles,
} from '../../../src/agent/resources/WorkspaceCommunicationStyles.js';
import type { LoadedPlugin } from '../../../src/plugins/types.js';

describe('workspace communication style resources', () => {
  const temporaryDirectories: string[] = [];

  async function temporaryRoot(name: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), name));
    temporaryDirectories.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('loads namespaced user, trusted project, and active plugin styles', async () => {
    const home = await temporaryRoot('blade-style-home-');
    const workspace = await temporaryRoot('blade-style-project-');
    const pluginRoot = await temporaryRoot('blade-style-plugin-');
    await Promise.all([
      mkdir(path.join(home, '.claude', 'output-styles'), { recursive: true }),
      mkdir(path.join(home, '.blade', 'output-styles'), { recursive: true }),
      mkdir(path.join(workspace, '.blade', 'output-styles', 'review'), {
        recursive: true,
      }),
      mkdir(path.join(pluginRoot, 'output-styles'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(home, '.claude', 'output-styles', 'compact.md'),
        '---\nname: Claude Compact\ndescription: compatibility style\n---\nOLD_USER_STYLE'
      ),
      writeFile(
        path.join(home, '.blade', 'output-styles', 'compact.md'),
        '---\nname: Compact\ndescription: concise user responses\n---\nUSER_STYLE_MARKER'
      ),
      writeFile(
        path.join(workspace, '.blade', 'output-styles', 'review', 'strict.md'),
        '---\nname: Strict Review\n---\nPROJECT_STYLE_MARKER'
      ),
      writeFile(
        path.join(pluginRoot, 'output-styles', 'guided.md'),
        '---\ndescription: plugin guidance\n---\nPLUGIN_STYLE_MARKER'
      ),
    ]);
    const plugin = {
      manifest: { name: 'review-kit' },
      basePath: pluginRoot,
      status: 'active',
    } as LoadedPlugin;

    const catalog = await resolveWorkspaceCommunicationStyles(workspace, {
      projectTrusted: true,
      plugins: [plugin],
      homeDirectory: home,
    });

    expect(catalog.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'user:compact',
          name: 'Compact',
          source: 'user',
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          id: 'project:review:strict',
          name: 'Strict Review',
          source: 'project',
        }),
        expect.objectContaining({
          id: 'plugin:review-kit:guided',
          source: 'plugin',
        }),
      ])
    );
    expect(catalog.list()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ prompt: expect.anything() })])
    );
    expect(catalog.resolve('user:compact').prompt).toBe('USER_STYLE_MARKER');
    expect(catalog.resolve('project:review:strict').prompt).toBe(
      'PROJECT_STYLE_MARKER'
    );
    expect(catalog.resolve('plugin:review-kit:guided').prompt).toBe(
      'PLUGIN_STYLE_MARKER'
    );
  });

  it('does not load project styles before Folder Trust', async () => {
    const home = await temporaryRoot('blade-style-home-');
    const workspace = await temporaryRoot('blade-style-untrusted-');
    await mkdir(path.join(workspace, '.blade', 'output-styles'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, '.blade', 'output-styles', 'unsafe.md'),
      'UNTRUSTED_STYLE_MARKER'
    );

    const catalog = await resolveWorkspaceCommunicationStyles(workspace, {
      projectTrusted: false,
      homeDirectory: home,
    });

    expect(catalog.list().some((style) => style.id === 'project:unsafe')).toBe(false);
    expect(() => catalog.resolve('project:unsafe')).toThrow(
      'Communication style is unavailable'
    );
  });

  it('rejects symlink roots and ignores unsafe or oversized style files', async () => {
    const home = await temporaryRoot('blade-style-home-');
    const workspace = await temporaryRoot('blade-style-security-');
    const outside = await temporaryRoot('blade-style-outside-');
    await mkdir(path.join(home, '.blade'), { recursive: true });
    await mkdir(path.join(outside, 'styles'), { recursive: true });
    await symlink(
      path.join(outside, 'styles'),
      path.join(home, '.blade', 'output-styles')
    );

    await expect(
      resolveWorkspaceCommunicationStyles(workspace, {
        projectTrusted: false,
        homeDirectory: home,
      })
    ).rejects.toThrow('cannot be a symlink');

    await rm(path.join(home, '.blade', 'output-styles'));
    await mkdir(path.join(home, '.blade', 'output-styles'), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(home, '.blade', 'output-styles', 'hidden.md'),
        `SAFE\u200bHIDDEN`
      ),
      writeFile(
        path.join(home, '.blade', 'output-styles', 'oversized.md'),
        'x'.repeat(MAX_COMMUNICATION_STYLE_PROMPT_BYTES + 1)
      ),
    ]);
    const catalog = await resolveWorkspaceCommunicationStyles(workspace, {
      projectTrusted: false,
      homeDirectory: home,
    });
    expect(catalog.list().some((style) => style.id === 'user:hidden')).toBe(false);
    expect(catalog.list().some((style) => style.id === 'user:oversized')).toBe(false);
  });

  it('freezes a Session catalog snapshot against later file changes', async () => {
    const home = await temporaryRoot('blade-style-home-');
    const workspace = await temporaryRoot('blade-style-snapshot-');
    const styles = path.join(home, '.blade', 'output-styles');
    await mkdir(styles, { recursive: true });
    const filePath = path.join(styles, 'stable.md');
    await writeFile(filePath, 'STYLE_VERSION_ONE');
    const catalog = await resolveWorkspaceCommunicationStyles(workspace, {
      projectTrusted: false,
      homeDirectory: home,
    });
    const snapshot = catalog.snapshot();

    await writeFile(filePath, 'STYLE_VERSION_TWO');
    const refreshed = await resolveWorkspaceCommunicationStyles(workspace, {
      projectTrusted: false,
      homeDirectory: home,
    });

    expect(snapshot.resolve('user:stable').prompt).toBe('STYLE_VERSION_ONE');
    expect(refreshed.resolve('user:stable').prompt).toBe('STYLE_VERSION_TWO');
  });
});
