import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitReviewTargetService } from '../../../src/services/GitReviewTargetService.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';

vi.unmock('node:child_process');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('GitReviewTargetService', () => {
  let workspace: string;
  let baseline: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-review-target-'));
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'review@example.com']);
    git(workspace, ['config', 'user.name', 'Review Test']);
    await writeFile(path.join(workspace, 'tracked.ts'), 'export const value = 1;\n');
    git(workspace, ['add', 'tracked.ts']);
    git(workspace, ['commit', '-qm', 'baseline']);
    baseline = git(workspace, ['rev-parse', 'HEAD']);
  });

  afterEach(async () => {
    await removeTestDirectory(workspace);
  });

  it('hashes tracked and untracked uncommitted changes deterministically', async () => {
    await writeFile(path.join(workspace, 'tracked.ts'), 'export const value = 2;\n');
    await writeFile(
      path.join(workspace, 'untracked.ts'),
      'export const added = true;\n'
    );

    const first = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });
    const second = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });

    expect(first.info).toMatchObject({
      kind: 'uncommitted',
      headSha: baseline,
      fileCount: 2,
    });
    expect(second.info.digest).toBe(first.info.digest);

    await writeFile(
      path.join(workspace, 'untracked.ts'),
      'export const added = false;\n'
    );
    const changed = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });
    expect(changed.info.digest).not.toBe(first.info.digest);

    git(workspace, ['commit', '--allow-empty', '-qm', 'advance head']);
    const advancedHead = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });
    expect(advancedHead.info.digest).not.toBe(changed.info.digest);
  });

  it('resolves immutable base and commit targets', async () => {
    await writeFile(path.join(workspace, 'tracked.ts'), 'export const value = 3;\n');
    git(workspace, ['add', 'tracked.ts']);
    git(workspace, ['commit', '-qm', 'change']);
    const commit = git(workspace, ['rev-parse', 'HEAD']);

    const base = await GitReviewTargetService.resolve(workspace, {
      kind: 'base',
      ref: baseline,
    });
    const singleCommit = await GitReviewTargetService.resolve(workspace, {
      kind: 'commit',
      ref: commit,
    });

    expect(base.info).toMatchObject({
      kind: 'base',
      baseSha: baseline,
      headSha: commit,
      fileCount: 1,
    });
    expect(singleCommit.info).toMatchObject({
      kind: 'commit',
      commitSha: commit,
      fileCount: 1,
    });
  });

  it('projects the old-side changed lines for a deleted file', async () => {
    await writeFile(path.join(workspace, 'deleted.ts'), 'one\ntwo\nthree\n');
    git(workspace, ['add', 'deleted.ts']);
    git(workspace, ['commit', '-qm', 'add deleted fixture']);
    await rm(path.join(workspace, 'deleted.ts'));

    const target = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });

    expect(target.changedLines.get('deleted.ts')).toEqual([{ start: 1, end: 3 }]);
  });

  it('fails closed for empty and malformed targets', async () => {
    await expect(
      GitReviewTargetService.resolve(workspace, { kind: 'uncommitted' })
    ).rejects.toThrow('No uncommitted changes');
    await expect(
      GitReviewTargetService.resolve(workspace, {
        kind: 'base',
        ref: 'bad\nref',
      })
    ).rejects.toThrow('Base ref');
  });

  it('enforces the 500 file and aggregate 8 MiB review budgets', async () => {
    const excessFiles = Array.from({ length: 501 }, (_, index) =>
      path.join(workspace, `untracked-${index}.ts`)
    );
    await Promise.all(excessFiles.map((file) => writeFile(file, 'export {};\n')));
    await expect(
      GitReviewTargetService.resolve(workspace, { kind: 'uncommitted' })
    ).rejects.toThrow('500 file limit');

    await Promise.all(excessFiles.map((file) => rm(file)));
    await writeFile(path.join(workspace, 'tracked.ts'), 'x'.repeat(4_500_000));
    await writeFile(path.join(workspace, 'untracked.bin'), Buffer.alloc(4_000_000));
    await expect(
      GitReviewTargetService.resolve(workspace, { kind: 'uncommitted' })
    ).rejects.toThrow('8388608 bytes');
  });
});
