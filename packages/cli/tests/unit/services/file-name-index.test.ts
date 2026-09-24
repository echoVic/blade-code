import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileNameIndex } from '../../../src/services/FileNameIndex.js';

vi.unmock('child_process');

describe('FileNameIndex', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-file-name-index-'));
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'ExistingService.ts'), '');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('reuses a workspace snapshot until that workspace is invalidated', async () => {
    const index = new FileNameIndex({ cacheTtlMs: 60_000 });

    expect(
      await index.search('existingservice', {
        cwd: workspace,
        limit: 10,
      })
    ).toMatchObject([{ path: 'src/ExistingService.ts', isDirectory: false }]);

    await writeFile(path.join(workspace, 'src', 'NewRuntime.ts'), '');

    expect(
      await index.search('newruntime', {
        cwd: workspace,
        limit: 10,
      })
    ).toEqual([]);

    index.invalidate(workspace);

    expect(
      await index.search('newruntime', {
        cwd: workspace,
        limit: 10,
      })
    ).toMatchObject([{ path: 'src/NewRuntime.ts', isDirectory: false }]);
  });

  it('supports literal substring matching for non-fuzzy consumers', async () => {
    const index = new FileNameIndex();

    expect(
      await index.search('sessonservice', {
        cwd: workspace,
        fuzzy: false,
      })
    ).toEqual([]);
    expect(
      await index.search('service', {
        cwd: workspace,
        fuzzy: false,
      })
    ).toMatchObject([{ path: 'src/ExistingService.ts' }]);
  });

  it('does not let one cancelled caller poison a shared index build', async () => {
    const index = new FileNameIndex();
    const controller = new AbortController();
    const cancelledSearch = index.search('existingservice', {
      cwd: workspace,
      signal: controller.signal,
    });

    controller.abort();
    const concurrentSearch = index.search('existingservice', {
      cwd: workspace,
    });
    const [cancelledResult, concurrentResult] = await Promise.allSettled([
      cancelledSearch,
      concurrentSearch,
    ]);

    expect(cancelledResult).toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError' },
    });
    expect(concurrentResult).toMatchObject({
      status: 'fulfilled',
      value: [{ path: 'src/ExistingService.ts' }],
    });
  });
  it('lists files with their parent directories and skips empty or ignored ones', async () => {
    await mkdir(path.join(workspace, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'nested', 'Deep.ts'), '');
    await mkdir(path.join(workspace, 'empty'), { recursive: true });
    await mkdir(path.join(workspace, '.hidden'), { recursive: true });
    await writeFile(path.join(workspace, '.hidden', 'Secret.ts'), '');
    await mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.js'), '');
    await mkdir(path.join(workspace, 'ignored'), { recursive: true });
    await writeFile(path.join(workspace, 'ignored', 'Skip.ts'), '');
    await writeFile(path.join(workspace, '.gitignore'), 'ignored/\n');

    const entries = await new FileNameIndex().search('', {
      cwd: workspace,
      limit: 100,
      includeDirectories: true,
    });

    expect(entries.map((entry) => entry.path)).toEqual([
      'src/',
      'src/ExistingService.ts',
      'src/nested/',
      'src/nested/Deep.ts',
    ]);
  });

  it('ignores .gitignore files above the workspace', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'blade-file-name-parent-'));
    try {
      await writeFile(path.join(parent, '.gitignore'), '*\n');
      const project = path.join(parent, 'project');
      await mkdir(path.join(project, 'src'), { recursive: true });
      await writeFile(path.join(project, 'src', 'App.ts'), '');

      await expect(
        new FileNameIndex().search('', { cwd: project, limit: 10 })
      ).resolves.toMatchObject([{ path: 'src/App.ts', isDirectory: false }]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
