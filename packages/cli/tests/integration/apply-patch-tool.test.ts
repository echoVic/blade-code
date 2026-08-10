import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpServiceContext } from '../../src/acp/AcpServiceContext.js';
import { applyPatchTool } from '../../src/tools/builtin/file/applyPatch.js';
import { FileAccessTracker } from '../../src/tools/builtin/file/FileAccessTracker.js';
import { SnapshotManager } from '../../src/tools/builtin/file/SnapshotManager.js';

describe('ApplyPatch builtin tool', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-apply-patch-tool-'));
    workspace = await fs.realpath(root);
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    FileAccessTracker.resetInstance();
  });

  afterEach(async () => {
    AcpServiceContext.destroySession('remote-patch-session');
    FileAccessTracker.resetInstance();
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

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
    const connection = {
      readTextFile: async ({ path: filePath }: { path: string }) => {
        const content = remoteFiles.get(filePath);
        if (content === undefined) throw new Error('remote file not found');
        return { content };
      },
      writeTextFile: async ({
        path: filePath,
        content,
      }: {
        path: string;
        content: string;
      }) => {
        remoteFiles.set(filePath, content);
        return {};
      },
    };
    AcpServiceContext.initializeSession(
      connection as never,
      'remote-patch-session',
      {
        fs: { readTextFile: true, writeTextFile: true },
      } as never,
      'C:\\workspace'
    );

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
});
