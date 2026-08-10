import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatchTransactionPlan } from '../../src/tools/builtin/file/applyPatchTransaction.js';
import {
  createPatchJournal,
  markPatchJournalCommitted,
  recoverWorkspacePatchTransactions,
  withPatchWorkspaceLock,
} from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

describe('ApplyPatch crash recovery and cross-process lock', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-patch-recovery-'));
    workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    workspace = await fs.realpath(workspace);
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rolls back a prepared journal after the process dies mid-publication', async () => {
    const transactionId = 'prepared-crash';
    const existing = path.join(workspace, 'existing.ts');
    const added = path.join(workspace, 'added.ts');
    await fs.writeFile(existing, 'old\n');
    const plan = planFor(existing, added);
    const stages = stageMap(plan, transactionId);
    const backups = backupMap(plan, transactionId);
    for (const change of plan.changes) {
      if (change.newContent !== null) {
        await fs.writeFile(stages.get(change.path)!, change.newContent);
      }
    }
    await createPatchJournal(workspace, transactionId, plan, stages, backups);
    await fs.rename(existing, backups.get(existing)!);
    await fs.rename(stages.get(existing)!, existing);
    await fs.rename(stages.get(added)!, added);

    await expect(recoverWorkspacePatchTransactions(workspace)).resolves.toBe(1);

    await expect(fs.readFile(existing, 'utf8')).resolves.toBe('old\n');
    await expect(fs.stat(added)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(backups.get(existing)!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps published files and only cleans artifacts for a committed journal', async () => {
    const transactionId = 'committed-crash';
    const existing = path.join(workspace, 'existing.ts');
    const added = path.join(workspace, 'added.ts');
    await fs.writeFile(existing, 'old\n');
    const plan = planFor(existing, added);
    const stages = stageMap(plan, transactionId);
    const backups = backupMap(plan, transactionId);
    for (const change of plan.changes) {
      if (change.newContent !== null) {
        await fs.writeFile(stages.get(change.path)!, change.newContent);
      }
    }
    const journal = await createPatchJournal(
      workspace,
      transactionId,
      plan,
      stages,
      backups
    );
    await fs.rename(existing, backups.get(existing)!);
    await fs.rename(stages.get(existing)!, existing);
    await fs.rename(stages.get(added)!, added);
    await markPatchJournalCommitted(journal);

    await expect(recoverWorkspacePatchTransactions(workspace)).resolves.toBe(1);

    await expect(fs.readFile(existing, 'utf8')).resolves.toBe('new\n');
    await expect(fs.readFile(added, 'utf8')).resolves.toBe('added\n');
    await expect(fs.stat(backups.get(existing)!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes independent callers through the workspace lock', async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withPatchWorkspaceLock(workspace, async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    await expect.poll(() => events).toEqual(['first:start']);
    const second = withPatchWorkspaceLock(workspace, async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('serializes two independent Blade processes for one workspace', async () => {
    const trace = path.join(root, 'cross-process.log');
    const storageRoot = path.join(root, 'cross-process-storage');
    const first = runLockWorker(workspace, storageRoot, trace, 'first', 300);
    let workerError: unknown;
    void first.catch((error) => {
      workerError = error;
    });
    await expect
      .poll(
        async () => {
          if (workerError) throw workerError;
          return fs
            .readFile(trace, 'utf8')
            .then((content) => content.includes('first:start'))
            .catch(() => false);
        },
        { timeout: 5_000, interval: 50 }
      )
      .toBe(true);
    const second = runLockWorker(workspace, storageRoot, trace, 'second', 0);

    await Promise.all([first, second]);
    await expect(fs.readFile(trace, 'utf8')).resolves.toBe(
      'first:start\nfirst:end\nsecond:start\nsecond:end\n'
    );
  });
});

function planFor(existing: string, added: string): PatchTransactionPlan {
  return {
    workspaceRoot: path.dirname(existing),
    affectedPaths: [existing, added].sort(),
    changes: [
      {
        kind: 'update',
        path: existing,
        oldContent: 'old\n',
        newContent: 'new\n',
      },
      {
        kind: 'add',
        path: added,
        oldContent: null,
        newContent: 'added\n',
      },
    ],
  };
}

function stageMap(
  plan: PatchTransactionPlan,
  transactionId: string
): Map<string, string> {
  return new Map(
    plan.changes.map((change) => [
      change.path,
      sibling(change.path, transactionId, 'stage'),
    ])
  );
}

function backupMap(
  plan: PatchTransactionPlan,
  transactionId: string
): Map<string, string> {
  return new Map(
    plan.changes
      .filter((change) => change.oldContent !== null)
      .map((change) => [change.path, sibling(change.path, transactionId, 'backup')])
  );
}

function sibling(
  filePath: string,
  transactionId: string,
  suffix: 'stage' | 'backup'
): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.blade-patch-${transactionId}.${suffix}`
  );
}

function runLockWorker(
  workspaceRoot: string,
  storageRoot: string,
  traceFile: string,
  name: string,
  holdMs: number
): Promise<void> {
  const worker = path.resolve(import.meta.dirname, '../support/patch-lock-worker.ts');
  const runner = path.resolve(import.meta.dirname, '../../scripts/run-bun.js');
  const child = spawn(
    process.execPath,
    [
      runner,
      'run',
      worker,
      workspaceRoot,
      storageRoot,
      traceFile,
      name,
      String(holdMs),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Patch lock worker failed (${code}): ${stderr}`));
    });
  });
}
