import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileNameIndex } from '../../../src/services/FileNameIndex.js';

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
});
