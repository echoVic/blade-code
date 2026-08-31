import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  getAcpFileRequestCoordinator,
} from '../../src/acp/AcpFileRequestCoordinator.js';
import { AcpFileSystemService } from '../../src/acp/AcpFileSystemService.js';
import { commitVerifiedRemoteTextMutation } from '../../src/acp/RemoteTextMutation.js';
import { parseApplyPatch } from '../../src/tools/builtin/file/applyPatchParser.js';
import {
  AcpRemotePatchTransactionError,
  commitLocalPatchTransaction,
  type LocalPatchFileSystem,
  planLocalPatchTransaction,
  planRemotePatchTransaction,
} from '../../src/tools/builtin/file/applyPatchTransaction.js';
import { ControlledFileClient } from '../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../support/acp/createPairedAcpHarness.js';
import {
  commitPreparedRemotePatchTransactionForTest,
  flushAsyncSteps,
  prepareRemotePatchTransactionForTest,
  waitForMicrotaskCondition,
} from '../support/acp/remotePatchTestHarness.js';

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
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'preflight-race'
    );
    const requests: Array<{ kind: 'read' | 'write'; path: string; content?: string }> =
      [];
    const originalReadTextFile = client.readTextFile.bind(client);
    client.readTextFile = async (params) => {
      requests.push({ kind: 'read', path: params.path });
      if (params.path === '/remote/first.ts' && requests.length >= 3) {
        return { content: 'const first = externally changed;\n' };
      }
      return originalReadTextFile(params);
    };
    const originalWriteTextFile = client.writeTextFile.bind(client);
    client.writeTextFile = async (params) => {
      requests.push({ kind: 'write', path: params.path, content: params.content });
      return originalWriteTextFile(params);
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

    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );
    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).rejects.toMatchObject({
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
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('issues remote patch requests in patch order as preflight reads, compare reads, writes, then readbacks', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'remote-request-order'
    );
    const requests: Array<{
      kind: 'read' | 'write';
      path: string;
      purpose: string;
      content?: string;
    }> = [];
    const originalReadTextFile = service.readTextFile.bind(service);
    const originalWriteTextFile = service.writeTextFile.bind(service);
    const originalReadTextFileIfExists = service.readTextFileIfExists.bind(service);
    vi.spyOn(service, 'readTextFile').mockImplementation(async (filePath, options) => {
      requests.push({
        kind: 'read',
        path: filePath,
        purpose: options?.purpose ?? 'preflight',
      });
      return originalReadTextFile(filePath, options);
    });
    vi.spyOn(service, 'writeTextFile').mockImplementation(
      async (filePath, content, options) => {
        requests.push({
          kind: 'write',
          path: filePath,
          purpose: options?.purpose ?? 'mutation',
          content,
        });
        return originalWriteTextFile(filePath, content, options);
      }
    );
    vi.spyOn(service, 'readTextFileIfExists').mockImplementation(
      async (filePath, options) => {
        requests.push({
          kind: 'read',
          path: filePath,
          purpose: options?.purpose ?? 'preflight',
        });
        return originalReadTextFileIfExists(filePath, options);
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).resolves.toBeUndefined();

    expect(requests).toEqual([
      { kind: 'read', path: '/remote/first.ts', purpose: 'preflight' },
      { kind: 'read', path: '/remote/second.ts', purpose: 'preflight' },
      { kind: 'read', path: '/remote/first.ts', purpose: 'preflight' },
      {
        kind: 'write',
        path: '/remote/first.ts',
        purpose: 'mutation',
        content: 'const first = true;\n',
      },
      { kind: 'read', path: '/remote/first.ts', purpose: 'readback' },
      { kind: 'read', path: '/remote/second.ts', purpose: 'preflight' },
      {
        kind: 'write',
        path: '/remote/second.ts',
        purpose: 'mutation',
        content: 'const second = true;\n',
      },
      { kind: 'read', path: '/remote/second.ts', purpose: 'readback' },
    ]);
    expect(client.files.get('/remote/first.ts')).toBe('const first = true;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = true;\n');
  });

  it('treats an acknowledged-loss forward write as success when readback already matches the intended content', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([['/remote/file.ts', 'const value = false;\n']]),
      'acknowledged-loss-success'
    );
    client.enqueueWriteBehavior({
      kind: 'replace-and-throw',
      content: 'const value = true;\n',
      error: new Error('remote write transport dropped after apply'),
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: file.ts
@@
-const value = false;
+const value = true;
*** End Patch`);
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).resolves.toBeUndefined();
    expect(client.files.get('/remote/file.ts')).toBe('const value = true;\n');
    expect(service.getRemoteAccessRecord('/remote/file.ts')).toMatchObject({
      lastOperation: 'edit',
    });
    expect(service.checkRemoteAccess('/remote/file.ts', 'const value = true;\n')).toBe(
      'current'
    );
  });

  it('rolls back prior remote writes when a later write fails', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-prior-writes'
    );
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    let thrown: unknown;
    try {
      await commitPreparedRemotePatchTransactionForTest(prepared, service);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
    if (!(thrown instanceof AcpRemotePatchTransactionError)) {
      throw new Error('expected AcpRemotePatchTransactionError');
    }
    expect(thrown.sideEffectsUncertain).toBe(false);
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('verifies rollback and reports sideEffectsUncertain=false after restoring prior writes', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-verified'
    );
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: false,
    });
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('marks sideEffectsUncertain=true when rollback verification mismatches', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-mismatch'
    );
    const writes: string[] = [];
    const originalWriteTextFile = client.writeTextFile.bind(client);
    client.writeTextFile = async (params) => {
      const { path: filePath, content } = params;
      writes.push(`${filePath}:${content.trim()}`);
      if (filePath.endsWith('second.ts') && content.includes('true')) {
        throw new Error('remote write failed');
      }
      if (filePath.endsWith('first.ts') && content.includes('false')) {
        client.files.set(filePath, 'const first = rollback mismatch;\n');
        return {};
      }
      return originalWriteTextFile(params);
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: true,
    });
    expect(writes).toContain('/remote/first.ts:const first = false;');
    expect(client.files.get('/remote/first.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
  });

  it('marks sideEffectsUncertain=true when rollback readback itself fails', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-readback-fails'
    );
    let rollbackReadFails = false;
    const originalWriteTextFile = client.writeTextFile.bind(client);
    client.writeTextFile = async (params) => {
      if (params.path.endsWith('second.ts') && params.content.includes('true')) {
        throw new Error('remote write failed');
      }
      if (params.path.endsWith('first.ts') && params.content.includes('false')) {
        rollbackReadFails = true;
      }
      return originalWriteTextFile(params);
    };
    const originalReadTextFile = client.readTextFile.bind(client);
    client.readTextFile = async (params) => {
      if (rollbackReadFails && params.path.endsWith('first.ts')) {
        throw new Error('rollback read failed');
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).rejects.toMatchObject({
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service,
      {
        signal: controller.signal,
      }
    );

    let thrown: unknown;
    try {
      await commitPreparedRemotePatchTransactionForTest(prepared, service, {
        signal: controller.signal,
      });
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service,
      {
        signal: controller.signal,
      }
    );

    let thrown: unknown;
    try {
      await commitPreparedRemotePatchTransactionForTest(prepared, service, {
        signal: controller.signal,
      });
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
          path: '/remote/first.ts',
          content: 'const first = false;\n',
          sessionId: 'rollback-after-abort-uncertain',
        },
      },
    ]);
    expect(client.files.get('/remote/first.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
    expect(service.getRemoteAccessRecord('/remote/first.ts')?.lastOperation).toBe(
      'read'
    );
  });

  it('fails closed for remote add, delete, and move operations', async () => {
    const { service } = createAcpRemoteFileSystem(new Map(), 'remote-update-only');
    const inertLease = service.tryAcquireMutationLease(['/remote/blocked.ts']);
    for (const patch of [
      '*** Add File: new.ts\n+x',
      '*** Delete File: old.ts',
      '*** Update File: old.ts\n*** Move to: moved.ts',
    ]) {
      const operations = parseApplyPatch(`*** Begin Patch\n${patch}\n*** End Patch`);
      await expect(
        planRemotePatchTransaction(operations, '/remote', service, {
          deadlineAt: Date.now() + ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
          lease: inertLease,
        })
      ).rejects.toThrow('Update File operations only');
    }
    inertLease.release();
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).rejects.toMatchObject({
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: true,
    });
    expect(client.files.get('/remote/first.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    await expect(
      commitPreparedRemotePatchTransactionForTest(prepared, service)
    ).resolves.toBeUndefined();
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

  it('caps each forward write request at 30 seconds instead of waiting for the entire mutation-plus-readback window', async () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const { client, service } = createAcpRemoteFileSystem(
        new Map([['/remote/file.ts', 'const value = false;\n']]),
        'forward-request-cap'
      );
      const blockedWrite = client.enqueueBlockedWrite();
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: file.ts
@@
-const value = false;
+const value = true;
*** End Patch`);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );
      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );
      let settled = false;
      void commitPromise.finally(() => {
        settled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(true);

      blockedWrite.release();
      await vi.runAllTimersAsync();
      await expect(commitPromise).rejects.toBeInstanceOf(
        AcpRemotePatchTransactionError
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a fresh 60-second compensation window even after the 120-second forward budget is exhausted', async () => {
    vi.useFakeTimers({ now: 10_000 });
    let releaseBlockedCurrentWrite: (() => void) | undefined;
    try {
      const { client, service, harness } = createAcpRemoteFileSystem(
        new Map([
          ['/remote/first.ts', 'const first = false;\n'],
          ['/remote/second.ts', 'const second = false;\n'],
          ['/remote/third.ts', 'const third = false;\n'],
        ]),
        'independent-compensation-window'
      );
      const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** Update File: third.ts
@@
-const third = false;
+const third = true;
*** End Patch`);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );
      const writeCalls: Array<{
        path: string;
        purpose: string;
        startedAt: number;
        deadlineAt: number | undefined;
      }> = [];
      const originalWriteTextFile = service.writeTextFile.bind(service);
      vi.spyOn(service, 'writeTextFile').mockImplementation(
        async (filePath, content, options) => {
          writeCalls.push({
            path: filePath,
            purpose: options?.purpose ?? 'mutation',
            startedAt: Date.now(),
            deadlineAt: options?.deadlineAt,
          });
          return originalWriteTextFile(filePath, content, options);
        }
      );

      const blockedCompareFirst = client.enqueueBlockedRead();
      const blockedWriteFirst = client.enqueueBlockedWrite();
      const blockedReadbackFirst = client.enqueueBlockedRead();
      const blockedCompareSecond = client.enqueueBlockedRead();
      const blockedWriteSecond = client.enqueueBlockedWrite();
      const blockedReadbackSecond = client.enqueueBlockedRead();
      const blockedCompareThird = client.enqueueBlockedRead();
      const blockedWriteThird = client.enqueueBlockedWrite();
      const blockedRollbackSecond = client.enqueueBlockedWrite();
      const blockedRollbackReadbackSecond = client.enqueueBlockedRead();
      releaseBlockedCurrentWrite = blockedWriteThird.release;

      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );

      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(24_000);
      blockedCompareFirst.release();
      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(24_000);
      blockedWriteFirst.release();
      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(4_000);
      blockedReadbackFirst.release();
      await flushAsyncSteps();

      await vi.advanceTimersByTimeAsync(24_000);
      blockedCompareSecond.release();
      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(24_000);
      blockedWriteSecond.release();
      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(4_000);
      blockedReadbackSecond.release();
      await flushAsyncSteps();

      await vi.advanceTimersByTimeAsync(15_000);
      blockedCompareThird.release();
      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(1_001);
      await flushAsyncSteps();

      await vi.advanceTimersByTimeAsync(29_000);
      blockedRollbackSecond.release();
      await flushAsyncSteps();
      await vi.advanceTimersByTimeAsync(3_000);
      blockedRollbackReadbackSecond.release();
      await flushAsyncSteps();

      await expect(commitPromise).rejects.toMatchObject({
        name: 'AcpRemotePatchTransactionError',
        sideEffectsUncertain: true,
        errors: [
          expect.objectContaining({
            name: 'AcpRemoteMutationError',
            requestPending: true,
            requiresRead: true,
            sideEffectsUncertain: true,
          }),
        ],
      });

      expect(
        writeCalls.map((entry) => ({
          path: entry.path,
          purpose: entry.purpose,
        }))
      ).toEqual([
        { path: '/remote/first.ts', purpose: 'mutation' },
        { path: '/remote/second.ts', purpose: 'mutation' },
        { path: '/remote/third.ts', purpose: 'mutation' },
        { path: '/remote/second.ts', purpose: 'rollback' },
        { path: '/remote/first.ts', purpose: 'rollback' },
      ]);

      const rollbackCalls = writeCalls.filter((entry) => entry.purpose === 'rollback');
      expect(rollbackCalls).toHaveLength(2);
      for (const rollbackCall of rollbackCalls) {
        expect(rollbackCall.startedAt).toBeGreaterThanOrEqual(
          prepared.forwardDeadlineAt
        );
        expect(rollbackCall.startedAt).toBeLessThan(
          prepared.forwardDeadlineAt + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS
        );
      }
      expect(rollbackCalls[0]?.deadlineAt).toBe(
        rollbackCalls[0]!.startedAt + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS
      );
      expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
      expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
      expect(client.files.get('/remote/third.ts')).toBe('const third = false;\n');
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
      });
    } finally {
      releaseBlockedCurrentWrite?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('caps forward readback verification requests at 5 seconds instead of using the entire remaining forward budget', async () => {
    vi.useFakeTimers({ now: 30_000 });
    try {
      const { service } = createAcpRemoteFileSystem(
        new Map([['/remote/file.ts', 'const value = false;\n']]),
        'forward-readback-cap'
      );
      const readbackCalls: Array<{
        deadlineAt: number | undefined;
        purpose: string;
      }> = [];
      const originalReadTextFileIfExists = service.readTextFileIfExists.bind(service);
      vi.spyOn(service, 'readTextFileIfExists').mockImplementation(
        async (filePath, options) => {
          readbackCalls.push({
            deadlineAt: options?.deadlineAt,
            purpose: options?.purpose ?? 'preflight',
          });
          return originalReadTextFileIfExists(filePath, options);
        }
      );
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: file.ts
@@
-const value = false;
+const value = true;
*** End Patch`);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );
      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );

      await expect(commitPromise).resolves.toBeUndefined();
      expect(readbackCalls).toEqual([
        {
          deadlineAt: 30_000 + ACP_REMOTE_READBACK_TIMEOUT_MS,
          purpose: 'readback',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shrinks preflight, compare, write, and readback deadlines to the remaining forward budget when less than the per-request cap remains', async () => {
    vi.useFakeTimers({ now: 50_000 });
    try {
      const { service } = createAcpRemoteFileSystem(
        new Map([['/remote/file.ts', 'const value = false;\n']]),
        'remaining-forward-budget'
      );
      const readCalls: Array<{
        phase: 'preflight' | 'compare';
        deadlineAt: number | undefined;
        purpose: string;
      }> = [];
      const writeCalls: Array<{
        deadlineAt: number | undefined;
        purpose: string;
      }> = [];
      const readbackCalls: Array<{
        deadlineAt: number | undefined;
        purpose: string;
      }> = [];
      const originalReadTextFile = service.readTextFile.bind(service);
      const originalWriteTextFile = service.writeTextFile.bind(service);
      const originalReadTextFileIfExists = service.readTextFileIfExists.bind(service);
      vi.spyOn(service, 'readTextFile').mockImplementation(
        async (filePath, options) => {
          readCalls.push({
            phase: readCalls.length === 0 ? 'preflight' : 'compare',
            deadlineAt: options?.deadlineAt,
            purpose: options?.purpose ?? 'preflight',
          });
          return originalReadTextFile(filePath, options);
        }
      );
      vi.spyOn(service, 'writeTextFile').mockImplementation(
        async (filePath, content, options) => {
          writeCalls.push({
            deadlineAt: options?.deadlineAt,
            purpose: options?.purpose ?? 'mutation',
          });
          return originalWriteTextFile(filePath, content, options);
        }
      );
      vi.spyOn(service, 'readTextFileIfExists').mockImplementation(
        async (filePath, options) => {
          readbackCalls.push({
            deadlineAt: options?.deadlineAt,
            purpose: options?.purpose ?? 'preflight',
          });
          return originalReadTextFileIfExists(filePath, options);
        }
      );
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: file.ts
@@
-const value = false;
+const value = true;
*** End Patch`);
      const forwardDeadlineAt = Date.now() + 2_000;
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service,
        {
          forwardDeadlineAt,
        }
      );

      await expect(
        commitPreparedRemotePatchTransactionForTest(prepared, service)
      ).resolves.toBeUndefined();
      expect(readCalls).toEqual([
        {
          phase: 'preflight',
          deadlineAt: forwardDeadlineAt,
          purpose: 'preflight',
        },
        {
          phase: 'compare',
          deadlineAt: forwardDeadlineAt,
          purpose: 'preflight',
        },
      ]);
      expect(writeCalls).toEqual([
        {
          deadlineAt: forwardDeadlineAt,
          purpose: 'mutation',
        },
      ]);
      expect(readbackCalls).toEqual([
        {
          deadlineAt: forwardDeadlineAt,
          purpose: 'readback',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rollback the current path while its forward write remains pending and still compensates previously verified paths in reverse order', async () => {
    vi.useFakeTimers({ now: 20_000 });
    let releaseBlockedCurrentWrite: (() => void) | undefined;
    try {
      const { client, service, harness } = createAcpRemoteFileSystem(
        new Map([
          ['/remote/first.ts', 'const first = false;\n'],
          ['/remote/second.ts', 'const second = false;\n'],
          ['/remote/third.ts', 'const third = false;\n'],
        ]),
        'pending-current-no-rollback'
      );
      const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
      client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
      client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
      const blockedCurrentWrite = client.enqueueBlockedWrite();
      releaseBlockedCurrentWrite = blockedCurrentWrite.release;
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** Update File: third.ts
@@
-const third = false;
+const third = true;
*** End Patch`);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );
      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );
      let settled = false;
      void commitPromise.finally(() => {
        settled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS + 1);
      expect(settled).toBe(true);
      await expect(commitPromise).rejects.toMatchObject({
        name: 'AcpRemotePatchTransactionError',
        sideEffectsUncertain: true,
        errors: [
          expect.objectContaining({
            name: 'AcpRemoteMutationError',
            requestPending: true,
            requiresRead: true,
            sideEffectsUncertain: true,
          }),
        ],
      });

      expect(
        client.requests
          .filter((request) => request.kind === 'write')
          .map((request) => request.request)
      ).toEqual([
        {
          path: '/remote/first.ts',
          content: 'const first = true;\n',
          sessionId: 'pending-current-no-rollback',
        },
        {
          path: '/remote/second.ts',
          content: 'const second = true;\n',
          sessionId: 'pending-current-no-rollback',
        },
        {
          path: '/remote/third.ts',
          content: 'const third = true;\n',
          sessionId: 'pending-current-no-rollback',
        },
        {
          path: '/remote/second.ts',
          content: 'const second = false;\n',
          sessionId: 'pending-current-no-rollback',
        },
        {
          path: '/remote/first.ts',
          content: 'const first = false;\n',
          sessionId: 'pending-current-no-rollback',
        },
      ]);
      expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
      expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
      expect(client.files.get('/remote/third.ts')).toBe('const third = false;\n');
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
        needsRead: 0,
      });

      blockedCurrentWrite.release();
      await vi.runAllTimersAsync();
    } finally {
      releaseBlockedCurrentWrite?.();
      vi.useRealTimers();
    }
  });

  it('stops before dispatching the next forward change once the absolute forward deadline has expired', async () => {
    vi.useFakeTimers({ now: 40_000 });
    try {
      const { service } = createAcpRemoteFileSystem(
        new Map([
          ['/remote/first.ts', 'const first = false;\n'],
          ['/remote/second.ts', 'const second = false;\n'],
          ['/remote/third.ts', 'const third = false;\n'],
          ['/remote/fourth.ts', 'const fourth = false;\n'],
        ]),
        'forward-deadline-stops-next-change'
      );
      const writeCalls: Array<{ path: string; purpose: string }> = [];
      const originalWriteTextFile = service.writeTextFile.bind(service);
      vi.spyOn(service, 'writeTextFile').mockImplementation(
        async (filePath, content, options) => {
          void content;
          writeCalls.push({
            path: filePath,
            purpose: options?.purpose ?? 'mutation',
          });
          return originalWriteTextFile(filePath, content, options);
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
*** Update File: third.ts
@@
-const third = false;
+const third = true;
*** Update File: fourth.ts
@@
-const fourth = false;
+const fourth = true;
*** End Patch`);
      const readbackCalls: Array<{ path: string; purpose: string }> = [];
      const originalReadTextFileIfExists = service.readTextFileIfExists.bind(service);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );
      vi.spyOn(service, 'readTextFileIfExists').mockImplementation(
        async (filePath, options) => {
          readbackCalls.push({
            path: filePath,
            purpose: options?.purpose ?? 'preflight',
          });
          const result = await originalReadTextFileIfExists(filePath, options);
          if (filePath === '/remote/third.ts' && options?.purpose === 'readback') {
            vi.setSystemTime(prepared.forwardDeadlineAt + 1);
          }
          return result;
        }
      );
      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );

      let thrown: unknown;
      try {
        await commitPromise;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
      if (!(thrown instanceof AcpRemotePatchTransactionError)) {
        throw new Error('expected AcpRemotePatchTransactionError');
      }
      expect(thrown.sideEffectsUncertain).toBe(false);
      expect(thrown.errors[0]).toMatchObject({
        message: 'ACP remote patch forward request budget expired',
      });
      expect(readbackCalls).toContainEqual({
        path: '/remote/third.ts',
        purpose: 'readback',
      });
      expect(
        writeCalls
          .filter((entry) => entry.purpose === 'mutation')
          .map((entry) => entry.path)
      ).toEqual(['/remote/first.ts', '/remote/second.ts', '/remote/third.ts']);
      const rollbackPaths = writeCalls
        .filter((entry) => entry.purpose === 'rollback')
        .map((entry) => entry.path);
      expect(rollbackPaths.length).toBeGreaterThanOrEqual(1);
      expect(rollbackPaths).toContain('/remote/second.ts');
      expect(
        writeCalls.some(
          (entry) => entry.path === '/remote/fourth.ts' && entry.purpose === 'mutation'
        )
      ).toBe(false);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('marks rollback readback requests with purpose=rollback so the coordinator can route them onto the recovery lane', async () => {
    const { client, service } = createAcpRemoteFileSystem(
      new Map([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]),
      'rollback-readback-recovery-lane'
    );
    service.recordRemoteAccess('/remote/first.ts', 'const first = false;\n', 'read');
    service.recordRemoteAccess('/remote/second.ts', 'const second = false;\n', 'read');
    client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
    client.enqueueWriteBehavior({
      kind: 'leave-old-and-throw',
      error: new Error('remote write failed'),
    });
    client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
    const readbackPurposes: string[] = [];
    const originalReadTextFileIfExists = service.readTextFileIfExists.bind(service);
    vi.spyOn(service, 'readTextFileIfExists').mockImplementation(
      async (filePath, options) => {
        readbackPurposes.push(options?.purpose ?? 'preflight');
        return originalReadTextFileIfExists(filePath, options);
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
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    let thrown: unknown;
    try {
      await commitPreparedRemotePatchTransactionForTest(prepared, service);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
    if (!(thrown instanceof AcpRemotePatchTransactionError)) {
      throw new Error('expected AcpRemotePatchTransactionError');
    }
    expect(thrown.sideEffectsUncertain).toBe(false);
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');
    expect(readbackPurposes).toEqual(['readback', 'readback', 'rollback']);
  });
});

function createAcpRemoteFileSystem(
  files: Map<string, string>,
  sessionId: string
): {
  client: ControlledFileClient;
  service: AcpFileSystemService;
  harness: PairedAcpHarness;
} {
  const client = new ControlledFileClient();
  for (const [filePath, content] of files) {
    client.files.set(filePath, content);
  }
  const harness = createPairedAcpHarness(client);
  harnesses.push(harness);
  return {
    client,
    harness,
    service: new AcpFileSystemService(harness.agentConnection, sessionId, {
      readTextFile: true,
      writeTextFile: true,
    }),
  };
}
