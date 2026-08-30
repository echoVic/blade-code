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
import { SnapshotManager } from '../../src/tools/builtin/file/SnapshotManager.js';

describe('ApplyPatch builtin tool', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;
  const sessionIds = new Set<string>();

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

  type RemoteWriteBehavior =
    | { kind: 'apply-and-ack' }
    | { kind: 'apply-and-throw'; error: Error }
    | { kind: 'leave-old-and-throw'; error: Error }
    | { kind: 'ack-with-replacement'; content: string };

  function createRemotePatchSession(options: {
    sessionId: string;
    workspaceRoot: string;
    files: Map<string, string>;
    capabilities?: { readTextFile?: boolean; writeTextFile?: boolean };
    writeBehaviors?: RemoteWriteBehavior[];
  }): {
    requests: RemotePatchRequest[];
  } {
    const requests: RemotePatchRequest[] = [];
    const writeBehaviors = [...(options.writeBehaviors ?? [])];
    const connection = {
      readTextFile: async ({ path: filePath }: { path: string }) => {
        requests.push({ kind: 'read', path: filePath });
        const content = options.files.get(filePath);
        if (content === undefined) {
          throw new Error(`remote file not found: ${filePath}`);
        }
        return { content };
      },
      writeTextFile: async ({
        path: filePath,
        content,
      }: {
        path: string;
        content: string;
      }) => {
        requests.push({ kind: 'write', path: filePath, content });
        const behavior = writeBehaviors.shift() ?? { kind: 'apply-and-ack' };
        if (behavior.kind === 'apply-and-ack') {
          options.files.set(filePath, content);
          return {};
        }
        if (behavior.kind === 'apply-and-throw') {
          options.files.set(filePath, content);
          throw behavior.error;
        }
        if (behavior.kind === 'leave-old-and-throw') {
          throw behavior.error;
        }
        options.files.set(filePath, behavior.content);
        return {};
      },
    };

    sessionIds.add(options.sessionId);
    AcpServiceContext.initializeSession(
      connection as never,
      options.sessionId,
      {
        fs: {
          readTextFile: options.capabilities?.readTextFile ?? true,
          writeTextFile: options.capabilities?.writeTextFile ?? true,
        },
      } as never,
      options.workspaceRoot
    );
    return { requests };
  }

  async function listPatchStateEntries(): Promise<string[]> {
    const patchRoot = path.join(root, '.storage', 'patch-transactions');
    try {
      const entries = await fs.readdir(patchRoot, {
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

  it('updates ACP-owned files without touching a same-named local path', async () => {
    const remoteFiles = new Map([
      ['C:\\workspace\\source.ts', 'const value = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId: 'remote-patch-session',
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
*** End Patch`,
      },
      undefined,
      {
        sessionId: 'remote-patch-session',
        messageId: 'remote-message',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(true);
    expect(remoteFiles.get('C:\\workspace\\source.ts')).toBe('const value = true;\n');
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
    expect(requests).toEqual([
      {
        kind: 'read',
        path: 'C:\\workspace\\missing.ts',
      },
    ]);
    expect(remoteFiles.has('C:\\workspace\\missing.ts')).toBe(false);
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
});
