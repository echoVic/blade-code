import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpFileSystemService } from '../../src/acp/AcpFileSystemService.js';
import {
  AcpServiceContext,
  getAcpFileSystemService,
} from '../../src/acp/AcpServiceContext.js';
import { applyPatchTool } from '../../src/tools/builtin/file/applyPatch.js';
import { FileAccessTracker } from '../../src/tools/builtin/file/FileAccessTracker.js';
import { createRemotePatchWorkspaceIdentity } from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';
import { SnapshotManager } from '../../src/tools/builtin/file/SnapshotManager.js';
import {
  ControlledFileClient,
  type ControlledWriteBehavior,
} from '../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../support/acp/createPairedAcpHarness.js';

describe('ApplyPatch builtin tool', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;
  const sessionIds = new Set<string>();
  const harnesses: PairedAcpHarness[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-apply-patch-tool-'));
    workspace = await fs.realpath(root);
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    FileAccessTracker.resetInstance();
  });

  afterEach(async () => {
    for (const sessionId of sessionIds) {
      AcpServiceContext.destroySession(sessionId);
    }
    sessionIds.clear();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    FileAccessTracker.resetInstance();
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  interface RemotePatchRequest {
    kind: 'read' | 'write';
    path: string;
    content?: string;
  }

  function createRemotePatchSession(options: {
    sessionId: string;
    workspaceRoot: string;
    files: Map<string, string>;
    capabilities?: { readTextFile?: boolean; writeTextFile?: boolean };
    writeBehaviors?: ControlledWriteBehavior[];
    onReadRequest?: (
      filePath: string,
      requestCount: number
    ) => string | Error | undefined;
  }): {
    requests: RemotePatchRequest[];
  } {
    const requests: RemotePatchRequest[] = [];
    const client = new ControlledFileClient();
    const syncFilesToSource = () => {
      options.files.clear();
      for (const [filePath, content] of client.files) {
        options.files.set(filePath, content);
      }
    };
    for (const [filePath, content] of options.files) {
      client.files.set(filePath, content);
    }
    for (const behavior of options.writeBehaviors ?? []) {
      client.enqueueWriteBehavior(behavior);
    }
    const originalReadTextFile = client.readTextFile.bind(client);
    let readRequestCount = 0;
    client.readTextFile = async (params) => {
      requests.push({ kind: 'read', path: params.path });
      readRequestCount += 1;
      const override = options.onReadRequest?.(params.path, readRequestCount);
      if (typeof override === 'string') {
        return { content: override };
      }
      if (override instanceof Error) {
        throw override;
      }
      return originalReadTextFile(params);
    };
    const originalWriteTextFile = client.writeTextFile.bind(client);
    client.writeTextFile = async (params) => {
      requests.push({ kind: 'write', path: params.path, content: params.content });
      try {
        return await originalWriteTextFile(params);
      } finally {
        syncFilesToSource();
      }
    };
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);

    sessionIds.add(options.sessionId);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      options.sessionId,
      {
        fs: {
          readTextFile: options.capabilities?.readTextFile ?? true,
          writeTextFile: options.capabilities?.writeTextFile ?? true,
        },
      },
      options.workspaceRoot
    );
    return { requests };
  }

  function patchStateDirForWorkspaceIdentity(workspaceIdentity: string): string {
    return path.join(
      root,
      '.storage',
      'patch-transactions',
      createHash('sha256').update(workspaceIdentity).digest('hex').slice(0, 32)
    );
  }

  async function listPatchStateEntries(patchRoot?: string): Promise<string[]> {
    const stateRoot = patchRoot ?? path.join(root, '.storage', 'patch-transactions');
    try {
      const entries = await fs.readdir(stateRoot, {
        recursive: true,
      });
      return entries.map((entry) => String(entry)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  it('publishes multi-file metadata and rewinds one patch as a unit', async () => {
    const updatePath = path.join(workspace, 'update.ts');
    const deletePath = path.join(workspace, 'delete.ts');
    const addPath = path.join(workspace, 'nested/add.ts');
    await fs.writeFile(updatePath, 'export const value = false;\n');
    await fs.writeFile(deletePath, 'obsolete\n');
    const tracker = FileAccessTracker.getInstance();
    await tracker.recordFileRead(updatePath, 'patch-session');
    await tracker.recordFileRead(deletePath, 'patch-session');

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: update.ts
@@
-export const value = false;
+export const value = true;
*** Add File: nested/add.ts
+export const added = true;
*** Delete File: delete.ts
*** End Patch`,
      },
      undefined,
      {
        sessionId: 'patch-session',
        messageId: 'patch-message',
        workspaceRoot: workspace,
      }
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      kind: 'patch',
      snapshot_created: true,
      affected_paths: [deletePath, addPath, updatePath].sort(),
      changes: [
        {
          kind: 'update',
          path: updatePath,
          oldContent: 'export const value = false;\n',
          newContent: 'export const value = true;\n',
        },
        {
          kind: 'add',
          path: addPath,
          oldContent: null,
          newContent: 'export const added = true;\n',
        },
        {
          kind: 'delete',
          path: deletePath,
          oldContent: 'obsolete\n',
          newContent: null,
        },
      ],
    });
    await expect(fs.readFile(updatePath, 'utf8')).resolves.toContain('true');
    await expect(fs.readFile(addPath, 'utf8')).resolves.toContain('added');
    await expect(fs.stat(deletePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const snapshots = new SnapshotManager({
      sessionId: 'patch-session',
      workspaceRoot: workspace,
    });
    await snapshots.initialize();
    await expect(snapshots.rewindSnapshots(['patch-message'])).resolves.toEqual({
      files: [deletePath, addPath, updatePath].sort(),
      snapshotCount: 3,
    });
    await expect(fs.readFile(updatePath, 'utf8')).resolves.toContain('false');
    await expect(fs.stat(addPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(deletePath, 'utf8')).resolves.toBe('obsolete\n');
    expect(
      (
        await fs.readdir(path.join(root, '.storage', 'patch-transactions'), {
          recursive: true,
        })
      ).filter((name) => name.endsWith('.json') || name.endsWith('.lock'))
    ).toEqual([]);
  });

  it('projects every source and move destination into permission review', () => {
    const invocation = applyPatchTool.build({
      patch: `*** Begin Patch
*** Update File: source.ts
*** Move to: moved.ts
*** End Patch`,
    });

    expect(invocation.getAffectedPaths()).toEqual(['source.ts', 'moved.ts']);
  });

  it('rejects an unread existing file before creating snapshots or changes', async () => {
    const filePath = path.join(workspace, 'source.ts');
    await fs.writeFile(filePath, 'const value = false;\n');

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: source.ts
@@
-const value = false;
+const value = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId: 'unread-session',
        messageId: 'unread-message',
        workspaceRoot: workspace,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('const value = false;\n');
    const snapshots = new SnapshotManager({
      sessionId: 'unread-session',
      workspaceRoot: workspace,
    });
    await snapshots.initialize();
    await expect(snapshots.listAllSnapshots()).resolves.toEqual([]);
  });

  it('updates ACP-owned files without touching a same-named local path or local recovery state', async () => {
    const sessionId = 'remote-patch-session';
    const localCanaryPath = path.join(workspace, 'source.ts');
    const localOnlyDir = path.join(workspace, 'nested');
    const localSnapshots = new SnapshotManager({
      sessionId,
      workspaceRoot: workspace,
    });
    const localPatchStateDir = patchStateDirForWorkspaceIdentity(workspace);
    const localRecoveryCanary = path.join(localPatchStateDir, 'pending-local.json');
    await fs.mkdir(localPatchStateDir, { recursive: true });
    await fs.writeFile(localRecoveryCanary, '{"scope":"local-canary"}\n');
    await fs.writeFile(localCanaryPath, 'const value = "local canary";\n');
    const remoteFiles = new Map([
      ['C:\\workspace\\source.ts', 'const value = false;\n'],
      ['C:\\workspace\\nested\\existing.ts', 'export const nested = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: source.ts
@@
-const value = false;
+const value = true;
*** Update File: nested/existing.ts
@@
-export const nested = false;
+export const nested = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-message',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(true);
    expect(remoteFiles.get('C:\\workspace\\source.ts')).toBe('const value = true;\n');
    expect(remoteFiles.get('C:\\workspace\\nested\\existing.ts')).toBe(
      'export const nested = true;\n'
    );
    await expect(fs.readFile(localCanaryPath, 'utf8')).resolves.toBe(
      'const value = "local canary";\n'
    );
    await expect(fs.stat(localOnlyDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await localSnapshots.initialize();
    await expect(localSnapshots.listAllSnapshots()).resolves.toEqual([]);
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    await expect(fs.readFile(localRecoveryCanary, 'utf8')).resolves.toContain(
      'local-canary'
    );
    const remotePatchStateEntries = await listPatchStateEntries(
      patchStateDirForWorkspaceIdentity(
        createRemotePatchWorkspaceIdentity(sessionId, 'C:\\workspace')
      )
    );
    expect(
      remotePatchStateEntries.some((entry) => entry.endsWith('.operation.lock'))
    ).toBe(false);
    expect(remotePatchStateEntries.some((entry) => entry.endsWith('.json'))).toBe(
      false
    );
    expect(remotePatchStateEntries.join('\n')).not.toContain('workspace');
    expect(remotePatchStateEntries.join('\n')).not.toContain('source.ts');
    expect(remotePatchStateEntries.join('\n')).not.toContain('existing.ts');
    expect(result.metadata).toMatchObject({
      kind: 'patch',
      snapshot_created: false,
    });
  });

  it.each([
    {
      label: 'read-only',
      capabilities: { readTextFile: true, writeTextFile: false },
      expectedMessage: 'writeTextFile',
    },
    {
      label: 'write-only',
      capabilities: { readTextFile: false, writeTextFile: true },
      expectedMessage: 'readTextFile',
    },
  ])(
    'remote ApplyPatch 在 $label ACP capability 下会在任何请求或 host coordination 前失败',
    async ({ capabilities, expectedMessage }) => {
      const sessionId = `remote-patch-capability-${expectedMessage}`;
      const files = new Map([['C:\\workspace\\source.ts', 'const value = false;\n']]);
      const { requests } = createRemotePatchSession({
        sessionId,
        workspaceRoot: 'C:\\workspace',
        files,
        capabilities,
      });

      const result = await applyPatchTool.execute(
        {
          patch: `*** Begin Patch
*** Update File: source.ts
@@
-const value = false;
+const value = true;
*** End Patch`,
        },
        undefined,
        {
          sessionId,
          messageId: 'remote-capability-message',
          workspaceRoot: 'C:\\workspace',
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.llmContent).toContain(expectedMessage);
      expect(result.metadata).toMatchObject({
        sideEffectsUncertain: false,
        write_verified: false,
      });
      expect(requests).toEqual([]);
      expect(await listPatchStateEntries()).toEqual([]);
      expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    }
  );

  it('remote ApplyPatch 只接受 Update File，不能退化为 Add File', async () => {
    const sessionId = 'remote-patch-update-only';
    const remoteFiles = new Map<string, string>();
    const { requests } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Add File: source.ts
+const value = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-update-only',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.llmContent).toContain('Update File operations only');
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: false,
      write_verified: false,
    });
    expect(requests).toEqual([]);
    expect(remoteFiles.has('C:\\workspace\\source.ts')).toBe(false);
  });

  it('remote ApplyPatch 对缺失的 Update File 目标保持 not-found 失败，不会退化为 Add', async () => {
    const sessionId = 'remote-patch-missing-update';
    const remoteFiles = new Map<string, string>();
    const { requests } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: missing.ts
@@
-const value = false;
+const value = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-missing-update',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(String(result.llmContent).toLowerCase()).toContain('not found');
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: false,
      write_verified: false,
    });
    expect(requests).toEqual([
      {
        kind: 'read',
        path: 'C:\\workspace\\missing.ts',
      },
    ]);
    expect(remoteFiles.has('C:\\workspace\\missing.ts')).toBe(false);
  });

  it('remote ApplyPatch 在 preflight compare 发现远端内容漂移时返回确定性失败 metadata', async () => {
    const sessionId = 'remote-patch-preflight-race';
    const remoteFiles = new Map([
      ['C:\\workspace\\first.ts', 'const first = false;\n'],
      ['C:\\workspace\\second.ts', 'const second = false;\n'],
    ]);
    const readsPerPath = new Map<string, number>();
    const { requests } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
      onReadRequest: (filePath) => {
        const nextCount = (readsPerPath.get(filePath) ?? 0) + 1;
        readsPerPath.set(filePath, nextCount);
        if (filePath === 'C:\\workspace\\first.ts' && nextCount === 2) {
          return 'const first = externally changed;\n';
        }
        return undefined;
      },
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-preflight-race',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: false,
      write_verified: false,
    });
    expect(requests).toEqual([
      { kind: 'read', path: 'C:\\workspace\\first.ts' },
      { kind: 'read', path: 'C:\\workspace\\second.ts' },
      { kind: 'read', path: 'C:\\workspace\\first.ts' },
    ]);
    expect(remoteFiles.get('C:\\workspace\\first.ts')).toBe('const first = false;\n');
    expect(remoteFiles.get('C:\\workspace\\second.ts')).toBe('const second = false;\n');
  });

  it('remote ApplyPatch 成功时按 preflight/read-compare/write/readback 顺序请求，并在整体成功后记录 remote edit digest', async () => {
    const sessionId = 'remote-patch-success-order';
    const remoteFiles = new Map([
      ['C:\\workspace\\first.ts', 'const first = false;\n'],
      ['C:\\workspace\\second.ts', 'const second = false;\n'],
    ]);
    const { requests } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-success-order',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      kind: 'patch',
      snapshot_created: false,
      write_verified: true,
      sideEffectsUncertain: false,
    });
    expect(requests).toEqual([
      { kind: 'read', path: 'C:\\workspace\\first.ts' },
      { kind: 'read', path: 'C:\\workspace\\second.ts' },
      { kind: 'read', path: 'C:\\workspace\\first.ts' },
      {
        kind: 'write',
        path: 'C:\\workspace\\first.ts',
        content: 'const first = true;\n',
      },
      { kind: 'read', path: 'C:\\workspace\\first.ts' },
      { kind: 'read', path: 'C:\\workspace\\second.ts' },
      {
        kind: 'write',
        path: 'C:\\workspace\\second.ts',
        content: 'const second = true;\n',
      },
      { kind: 'read', path: 'C:\\workspace\\second.ts' },
    ]);
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    const patchStateEntries = await listPatchStateEntries();
    expect(patchStateEntries.some((entry) => entry.endsWith('.operation.lock'))).toBe(
      false
    );
    expect(patchStateEntries.some((entry) => entry.endsWith('.json'))).toBe(false);
    expect(patchStateEntries.join('\n')).not.toContain('workspace');
    expect(patchStateEntries.join('\n')).not.toContain('first.ts');
    expect(patchStateEntries.join('\n')).not.toContain('second.ts');
    const service = getAcpFileSystemService(sessionId);
    expect(service).toBeInstanceOf(AcpFileSystemService);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(
      service.getRemoteAccessRecord('C:\\workspace\\first.ts')?.lastOperation
    ).toBe('edit');
    expect(
      service.getRemoteAccessRecord('C:\\workspace\\second.ts')?.lastOperation
    ).toBe('edit');
    expect(
      service.checkRemoteAccess('C:\\workspace\\first.ts', 'const first = true;\n')
    ).toBe('current');
    expect(
      service.checkRemoteAccess('C:\\workspace\\second.ts', 'const second = true;\n')
    ).toBe('current');
  });

  it('remote ApplyPatch 在 write ack 丢失但 readback 等于 intended 时仍成功', async () => {
    const sessionId = 'remote-patch-ack-lost';
    const remoteFiles = new Map([
      ['C:\\workspace\\source.ts', 'const value = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
      writeBehaviors: [
        {
          kind: 'apply-and-throw',
          error: new Error('remote ack lost'),
        },
      ],
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: source.ts
@@
-const value = false;
+const value = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-ack-lost',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      write_verified: true,
      sideEffectsUncertain: false,
    });
    expect(remoteFiles.get('C:\\workspace\\source.ts')).toBe('const value = true;\n');
  });

  it('remote ApplyPatch 在 classified rollback uncertainty 下返回 sideEffectsUncertain=true metadata', async () => {
    const sessionId = 'remote-patch-rollback-uncertain';
    const remoteFiles = new Map([
      ['C:\\workspace\\first.ts', 'const first = false;\n'],
      ['C:\\workspace\\second.ts', 'const second = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
      writeBehaviors: [
        { kind: 'apply-and-ack' },
        {
          kind: 'leave-old-and-throw',
          error: new Error('remote write failed'),
        },
        {
          kind: 'replace-and-throw',
          content: 'const first = rollback mismatch;\n',
          error: new Error('remote rollback mismatch'),
        },
      ],
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-rollback-uncertain',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: true,
      write_verified: false,
    });
    expect(remoteFiles.get('C:\\workspace\\first.ts')).toBe('const first = false;\n');
    expect(remoteFiles.get('C:\\workspace\\second.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    const service = getAcpFileSystemService(sessionId);
    expect(service).toBeInstanceOf(AcpFileSystemService);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(service.getRemoteAccessRecord('C:\\workspace\\first.ts')).toBeUndefined();
    expect(service.getRemoteAccessRecord('C:\\workspace\\second.ts')).toBeUndefined();
  });
});
