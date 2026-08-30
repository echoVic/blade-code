import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpFileRequestCoordinator } from '../../src/acp/AcpFileRequestCoordinator.js';
import { AcpFileSystemService } from '../../src/acp/AcpFileSystemService.js';
import { commitVerifiedRemoteTextMutation } from '../../src/acp/RemoteTextMutation.js';
import type {
  FileStat,
  FileSystemService,
} from '../../src/services/FileSystemService.js';
import { parseApplyPatch } from '../../src/tools/builtin/file/applyPatchParser.js';
import {
  AcpRemotePatchTransactionError,
  commitLocalPatchTransaction,
  commitRemotePatchTransaction,
  type LocalPatchFileSystem,
  planLocalPatchTransaction,
  planRemotePatchTransaction,
} from '../../src/tools/builtin/file/applyPatchTransaction.js';
import { ControlledFileClient } from '../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../support/acp/createPairedAcpHarness.js';

const roots: string[] = [];
const harnesses: PairedAcpHarness[] = [];
let previousStorageRoot: string | undefined;

async function workspace(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `blade-patch-${name}-`));
  roots.push(root);
  return fs.realpath(root);
}

async function write(root: string, relative: string, content: string) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function realTransactionFs(): LocalPatchFileSystem {
  return {
    lstat: (filePath) => fs.lstat(filePath),
    readFile: (filePath) => fs.readFile(filePath),
    writeFile: (filePath, content, options) => fs.writeFile(filePath, content, options),
    mkdir: (dirPath) => fs.mkdir(dirPath),
    rename: (from, to) => fs.rename(from, to),
    rm: (filePath, options) => fs.rm(filePath, options),
    rmdir: (dirPath) => fs.rmdir(dirPath),
    syncFile: async (filePath) => {
      const handle = await fs.open(filePath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    syncDirectory: async (dirPath) => {
      const handle = await fs.open(dirPath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

beforeEach(() => {
  previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
});

describe('ApplyPatch local transaction', () => {
  it('atomically combines add, update, delete, and move operations', async () => {
    const root = await workspace('combined');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    await write(root, 'update.ts', 'export const value = false;\n');
    await write(root, 'move.ts', 'export const moved = false;\n');
    await write(root, 'delete.ts', 'obsolete\n');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: update.ts
@@
-export const value = false;
+export const value = true;
*** Update File: move.ts
*** Move to: nested/moved.ts
@@
-export const moved = false;
+export const moved = true;
*** Add File: nested/added.ts
+export const added = true;
*** Delete File: delete.ts
*** End Patch`);

    const plan = await planLocalPatchTransaction(operations, root);
    await commitLocalPatchTransaction(plan);

    await expect(fs.readFile(path.join(root, 'update.ts'), 'utf8')).resolves.toBe(
      'export const value = true;\n'
    );
    await expect(fs.readFile(path.join(root, 'nested/moved.ts'), 'utf8')).resolves.toBe(
      'export const moved = true;\n'
    );
    await expect(fs.readFile(path.join(root, 'nested/added.ts'), 'utf8')).resolves.toBe(
      'export const added = true;\n'
    );
    await expect(fs.stat(path.join(root, 'move.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(root, 'delete.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.readdir(root, { recursive: true })).join('\n')).not.toContain(
      '.blade-patch-'
    );
  });

  it('preflights every hunk before creating side effects', async () => {
    const root = await workspace('preflight');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    await write(root, 'first.ts', 'const first = false;\n');
    await write(root, 'second.ts', 'const second = false;\n');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-missing context
+const second = true;
*** End Patch`);

    await expect(planLocalPatchTransaction(operations, root)).rejects.toThrow(
      'expected context was not found'
    );
    await expect(fs.readFile(path.join(root, 'first.ts'), 'utf8')).resolves.toBe(
      'const first = false;\n'
    );
  });

  it('restores every file after a mid-publication failure', async () => {
    const root = await workspace('rollback');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    await write(root, 'first.ts', 'const first = false;\n');
    await write(root, 'second.ts', 'const second = false;\n');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planLocalPatchTransaction(operations, root);
    const transactionFs = realTransactionFs();
    let renameCount = 0;
    const injected: LocalPatchFileSystem = {
      ...transactionFs,
      rename: async (from, to) => {
        renameCount++;
        if (renameCount === 3) throw new Error('injected publish failure');
        await transactionFs.rename(from, to);
      },
    };

    await expect(
      commitLocalPatchTransaction(plan, undefined, injected)
    ).rejects.toThrow('injected publish failure');
    await expect(fs.readFile(path.join(root, 'first.ts'), 'utf8')).resolves.toBe(
      'const first = false;\n'
    );
    await expect(fs.readFile(path.join(root, 'second.ts'), 'utf8')).resolves.toBe(
      'const second = false;\n'
    );
    expect((await fs.readdir(root)).join('\n')).not.toContain('.blade-patch-');
  });

  it('rejects overlapping paths and symlink escapes', async () => {
    const root = await workspace('security');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    const outside = await workspace('outside');
    await write(root, 'same.ts', 'const value = false;\n');
    await fs.symlink(outside, path.join(root, 'link'));

    const overlapping = parseApplyPatch(`*** Begin Patch
*** Update File: same.ts
@@
-const value = false;
+const value = true;
*** Delete File: same.ts
*** End Patch`);
    await expect(planLocalPatchTransaction(overlapping, root)).rejects.toThrow(
      'overlapping file operations'
    );

    const escaping = parseApplyPatch(`*** Begin Patch
*** Add File: link/escaped.ts
+export {};
*** End Patch`);
    await expect(planLocalPatchTransaction(escaping, root)).rejects.toThrow(
      /outside|escapes/
    );
    await expect(fs.stat(path.join(outside, 'escaped.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('ApplyPatch ACP remote transaction', () => {
  it('self-owned verified remote mutations release their lease so the same path can be reacquired immediately', async () => {
    const client = new ControlledFileClient();
    client.files.set('/remote/file.ts', 'const value = false;\n');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'self-owned-verified',
      {
        readTextFile: true,
        writeTextFile: true,
      }
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    const receipt = await commitVerifiedRemoteTextMutation({
      service,
      filePath: '/remote/file.ts',
      previous: { exists: true, content: 'const value = false;\n' },
      intendedContent: 'const value = true;\n',
      operation: 'edit',
      recordAccess: false,
    });

    expect(receipt).toMatchObject({
      writeAcknowledged: true,
      writeVerified: true,
      sideEffectsUncertain: false,
      requiresRead: false,
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const lease = service.tryAcquireMutationLease(['/remote/file.ts']);
    expect(lease.isCurrent('/remote/file.ts')).toBe(true);
    lease.release();
  });

  it('self-owned remote mutations release their lease when write preflight fails before dispatch', async () => {
    const client = new ControlledFileClient();
    client.files.set('/remote/file.ts', 'const value = false;\n');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'self-owned-expired-deadline',
      {
        readTextFile: true,
        writeTextFile: true,
      }
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    await expect(
      commitVerifiedRemoteTextMutation({
        service,
        filePath: '/remote/file.ts',
        previous: { exists: true, content: 'const value = false;\n' },
        intendedContent: 'const value = true;\n',
        operation: 'edit',
        deadlineAt: Date.now() - 1,
        recordAccess: false,
      })
    ).rejects.toMatchObject({
      name: 'AcpRemoteMutationError',
      writeAcknowledged: false,
      writeVerified: false,
      sideEffectsUncertain: false,
      requiresRead: false,
      message: 'edit did not complete before the remote boundary rejected it',
    });

    expect(client.requests).toEqual([]);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const lease = service.tryAcquireMutationLease(['/remote/file.ts']);
    expect(lease.isCurrent('/remote/file.ts')).toBe(true);
    lease.release();
  });

  it('detects preflight content races before publishing any remote write', async () => {
    const files = new Map([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    const requests: Array<{ kind: 'read' | 'write'; path: string; content?: string }> =
      [];
    const remote = createRemoteFileSystem(
      files,
      async (filePath, content) => {
        requests.push({ kind: 'write', path: filePath, content });
        files.set(filePath, content);
      },
      async (filePath) => {
        requests.push({ kind: 'read', path: filePath });
        if (filePath === '/remote/first.ts' && requests.length >= 3) {
          return 'const first = externally changed;\n';
        }
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error(`not found: ${filePath}`);
        }
        return content;
      }
    );
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);

    const plan = await planRemotePatchTransaction(operations, '/remote', remote);
    await expect(commitRemotePatchTransaction(plan, remote)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: false,
      errors: [
        expect.objectContaining({
          message: 'Remote file changed after patch preflight: /remote/first.ts',
        }),
      ],
    });
    expect(requests).toEqual([
      { kind: 'read', path: '/remote/first.ts' },
      { kind: 'read', path: '/remote/second.ts' },
      { kind: 'read', path: '/remote/first.ts' },
    ]);
    expect(files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('rolls back prior remote writes when a later write fails', async () => {
    const files = new Map([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    let failed = false;
    const remote = createRemoteFileSystem(files, async (filePath, content) => {
      if (filePath.endsWith('second.ts') && content.includes('true') && !failed) {
        failed = true;
        files.set(filePath, content);
        throw new Error('remote write failed');
      }
      files.set(filePath, content);
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', remote);

    await expect(commitRemotePatchTransaction(plan, remote)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: false,
      errors: [
        expect.objectContaining({
          message: 'remote write failed',
        }),
      ],
    });
    expect(files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('verifies rollback and reports sideEffectsUncertain=false after restoring prior writes', async () => {
    const files = new Map([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    const remote = createRemoteFileSystem(files, async (filePath, content) => {
      if (filePath.endsWith('second.ts') && content.includes('true')) {
        throw new Error('remote write failed');
      }
      files.set(filePath, content);
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', remote);

    await expect(commitRemotePatchTransaction(plan, remote)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: false,
    });
    expect(files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('marks sideEffectsUncertain=true when rollback verification mismatches', async () => {
    const files = new Map([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    const writes: string[] = [];
    const remote = createRemoteFileSystem(files, async (filePath, content) => {
      writes.push(`${filePath}:${content.trim()}`);
      if (filePath.endsWith('second.ts') && content.includes('true')) {
        throw new Error('remote write failed');
      }
      if (filePath.endsWith('first.ts') && content.includes('false')) {
        files.set(filePath, 'const first = rollback mismatch;\n');
        return;
      }
      files.set(filePath, content);
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', remote);

    await expect(commitRemotePatchTransaction(plan, remote)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: true,
    });
    expect(writes).toContain('/remote/first.ts:const first = false;');
    expect(files.get('/remote/first.ts')).toBe('const first = rollback mismatch;\n');
  });

  it('marks sideEffectsUncertain=true when rollback readback itself fails', async () => {
    const files = new Map([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    let rollbackReadFails = false;
    const remote = createRemoteFileSystem(
      files,
      async (filePath, content) => {
        if (filePath.endsWith('second.ts') && content.includes('true')) {
          throw new Error('remote write failed');
        }
        if (filePath.endsWith('first.ts') && content.includes('false')) {
          rollbackReadFails = true;
        }
        files.set(filePath, content);
      },
      async (filePath) => {
        if (rollbackReadFails && filePath.endsWith('first.ts')) {
          throw new Error('rollback read failed');
        }
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error(`not found: ${filePath}`);
        }
        return content;
      }
    );
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', remote);

    await expect(commitRemotePatchTransaction(plan, remote)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: true,
    });
  });

  it('rolls back already-verified remote writes even when the user signal aborts before a later operation', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-after-abort'
    );
    service.recordRemoteAccess('/remote/first.ts', 'const first = false;\n', 'read');
    service.recordRemoteAccess('/remote/second.ts', 'const second = false;\n', 'read');
    const controller = new AbortController();
    let secondForwardReadCount = 0;
    const originalReadTextFile = client.readTextFile.bind(client);
    client.readTextFile = async (params) => {
      if (params.path === '/remote/second.ts') {
        secondForwardReadCount += 1;
        if (secondForwardReadCount === 2) {
          controller.abort();
        }
      }
      return originalReadTextFile(params);
    };
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', service);

    let thrown: unknown;
    try {
      await commitRemotePatchTransaction(plan, service, controller.signal);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
    if (!(thrown instanceof AcpRemotePatchTransactionError)) {
      throw new Error('expected AcpRemotePatchTransactionError');
    }
    expect(thrown.sideEffectsUncertain).toBe(false);
    expect(thrown.errors[0]).toMatchObject({ name: 'AbortError' });
    expect(client.requests.map((request) => request.kind)).toEqual([
      'read',
      'read',
      'read',
      'write',
      'read',
      'read',
      'write',
      'read',
      'write',
      'read',
    ]);
    expect(
      client.requests
        .filter((request) => request.kind === 'write')
        .map((request) => request.request)
    ).toEqual([
      {
        path: '/remote/first.ts',
        content: 'const first = true;\n',
        sessionId: 'rollback-after-abort',
      },
      {
        path: '/remote/second.ts',
        content: 'const second = false;\n',
        sessionId: 'rollback-after-abort',
      },
      {
        path: '/remote/first.ts',
        content: 'const first = false;\n',
        sessionId: 'rollback-after-abort',
      },
    ]);
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
    expect(service.getRemoteAccessRecord('/remote/first.ts')?.lastOperation).toBe(
      'read'
    );
    expect(service.getRemoteAccessRecord('/remote/second.ts')?.lastOperation).toBe(
      'read'
    );
  });

  it('keeps the abort error first and marks sideEffectsUncertain=true when rollback verification also fails after cancellation', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-after-abort-uncertain'
    );
    service.recordRemoteAccess('/remote/first.ts', 'const first = false;\n', 'read');
    service.recordRemoteAccess('/remote/second.ts', 'const second = false;\n', 'read');
    const controller = new AbortController();
    let secondForwardReadCount = 0;
    const originalReadTextFile = client.readTextFile.bind(client);
    client.readTextFile = async (params) => {
      if (params.path === '/remote/second.ts') {
        secondForwardReadCount += 1;
        if (secondForwardReadCount === 2) {
          controller.abort();
        }
      }
      return originalReadTextFile(params);
    };
    client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
    client.enqueueWriteBehavior({
      kind: 'replace-and-throw',
      content: 'const first = rollback mismatch;\n',
      error: new Error('remote rollback mismatch'),
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', service);

    let thrown: unknown;
    try {
      await commitRemotePatchTransaction(plan, service, controller.signal);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
    if (!(thrown instanceof AcpRemotePatchTransactionError)) {
      throw new Error('expected AcpRemotePatchTransactionError');
    }
    expect(thrown.sideEffectsUncertain).toBe(true);
    expect(thrown.errors[0]).toMatchObject({ name: 'AbortError' });
    expect(thrown.errors[1]).toMatchObject({
      message: 'edit readback returned unexpected remote content',
    });
    expect(client.requests.filter((request) => request.kind === 'write')).toEqual([
      {
        kind: 'write',
        request: {
          path: '/remote/first.ts',
          content: 'const first = true;\n',
          sessionId: 'rollback-after-abort-uncertain',
        },
      },
      {
        kind: 'write',
        request: {
          path: '/remote/second.ts',
          content: 'const second = false;\n',
          sessionId: 'rollback-after-abort-uncertain',
        },
      },
      {
        kind: 'write',
        request: {
          path: '/remote/first.ts',
          content: 'const first = false;\n',
          sessionId: 'rollback-after-abort-uncertain',
        },
      },
    ]);
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
    expect(service.getRemoteAccessRecord('/remote/first.ts')?.lastOperation).toBe(
      'read'
    );
  });

  it('fails closed for remote add, delete, and move operations', async () => {
    const remote = createRemoteFileSystem(new Map());
    for (const patch of [
      '*** Add File: new.ts\n+x',
      '*** Delete File: old.ts',
      '*** Update File: old.ts\n*** Move to: moved.ts',
    ]) {
      const operations = parseApplyPatch(`*** Begin Patch\n${patch}\n*** End Patch`);
      await expect(
        planRemotePatchTransaction(operations, '/remote', remote)
      ).rejects.toThrow('Update File operations only');
    }
  });

  it('does not advance the ACP remote ledger when a later write fails after an earlier verified edit', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'ledger-barrier-failure'
    );
    service.recordRemoteAccess('/remote/first.ts', 'const first = false;\n', 'read');
    service.recordRemoteAccess('/remote/second.ts', 'const second = false;\n', 'read');
    client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
    client.enqueueWriteBehavior({
      kind: 'leave-old-and-throw',
      error: new Error('remote write failed'),
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', service);

    await expect(commitRemotePatchTransaction(plan, service)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: false,
    });
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
    expect(service.getRemoteAccessRecord('/remote/first.ts')?.lastOperation).toBe(
      'read'
    );
    expect(service.getRemoteAccessRecord('/remote/second.ts')?.lastOperation).toBe(
      'read'
    );
    expect(
      service.checkRemoteAccess('/remote/first.ts', 'const first = false;\n')
    ).toBe('current');
    expect(service.checkRemoteAccess('/remote/first.ts', 'const first = true;\n')).toBe(
      'modified'
    );
    expect(
      service.checkRemoteAccess('/remote/second.ts', 'const second = false;\n')
    ).toBe('current');
  });

  it('does not pollute the ACP remote ledger when rollback verification becomes uncertain', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'ledger-barrier-uncertain'
    );
    service.recordRemoteAccess('/remote/first.ts', 'const first = false;\n', 'read');
    service.recordRemoteAccess('/remote/second.ts', 'const second = false;\n', 'read');
    client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
    client.enqueueWriteBehavior({
      kind: 'leave-old-and-throw',
      error: new Error('remote write failed'),
    });
    client.enqueueWriteBehavior({
      kind: 'replace-and-throw',
      content: 'const first = rollback mismatch;\n',
      error: new Error('remote rollback mismatch'),
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', service);

    await expect(commitRemotePatchTransaction(plan, service)).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: true,
    });
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
    expect(service.getRemoteAccessRecord('/remote/first.ts')?.lastOperation).toBe(
      'read'
    );
    expect(service.getRemoteAccessRecord('/remote/second.ts')?.lastOperation).toBe(
      'read'
    );
  });

  it('records ACP remote edits only after the whole transaction commits successfully', async () => {
    const { service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'ledger-barrier-success'
    );
    service.recordRemoteAccess('/remote/first.ts', 'const first = false;\n', 'read');
    service.recordRemoteAccess('/remote/second.ts', 'const second = false;\n', 'read');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', service);

    await expect(commitRemotePatchTransaction(plan, service)).resolves.toBeUndefined();
    expect(service.getRemoteAccessRecord('/remote/first.ts')?.lastOperation).toBe(
      'edit'
    );
    expect(service.getRemoteAccessRecord('/remote/second.ts')?.lastOperation).toBe(
      'edit'
    );
    expect(service.checkRemoteAccess('/remote/first.ts', 'const first = true;\n')).toBe(
      'current'
    );
    expect(
      service.checkRemoteAccess('/remote/second.ts', 'const second = true;\n')
    ).toBe('current');
  });
});

function createAcpRemoteFileSystem(
  files: Map<string, string>,
  sessionId: string
): {
  client: ControlledFileClient;
  service: AcpFileSystemService;
} {
  const client = new ControlledFileClient();
  for (const [filePath, content] of files) {
    client.files.set(filePath, content);
  }
  const harness = createPairedAcpHarness(client);
  harnesses.push(harness);
  return {
    client,
    service: new AcpFileSystemService(harness.agentConnection, sessionId, {
      readTextFile: true,
      writeTextFile: true,
    }),
  };
}

function createRemoteFileSystem(
  files: Map<string, string>,
  writeFile: (filePath: string, content: string) => Promise<void> = async (
    filePath,
    content
  ) => {
    files.set(filePath, content);
  },
  readFile: (filePath: string) => Promise<string> = async (filePath) => {
    const content = files.get(filePath);
    if (content === undefined) throw new Error(`not found: ${filePath}`);
    return content;
  }
): FileSystemService {
  return {
    readTextFile: readFile,
    writeTextFile: writeFile,
    exists: async (filePath) => files.has(filePath),
    readBinaryFile: async (filePath) => Buffer.from(files.get(filePath) ?? '', 'utf8'),
    stat: async (filePath): Promise<FileStat | null> =>
      files.has(filePath)
        ? {
            size: Buffer.byteLength(files.get(filePath)!),
            isDirectory: false,
            isFile: true,
            mtime: new Date(),
          }
        : null,
    mkdir: async () => undefined,
  };
}
