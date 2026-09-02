import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
  getAcpFileRequestCoordinator,
} from '../../src/acp/AcpFileRequestCoordinator.js';
import { AcpFileSystemService } from '../../src/acp/AcpFileSystemService.js';
import { parseAcpRemotePath } from '../../src/acp/AcpRemotePath.js';
import {
  AcpServiceContext,
  getAcpFileSystemService,
} from '../../src/acp/AcpServiceContext.js';
import { createLocalSessionWorkspace } from '../../src/agent/runtime/SessionWorkspace.js';
import { LocalFileSystemService } from '../../src/services/FileSystemService.js';
import { applyPatchTool } from '../../src/tools/builtin/file/applyPatch.js';
import * as applyPatchTransaction from '../../src/tools/builtin/file/applyPatchTransaction.js';
import { FileAccessTracker } from '../../src/tools/builtin/file/FileAccessTracker.js';
import * as patchTransactionCoordinator from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';
import {
  createRemotePatchWorkspaceIdentity,
  withPatchWorkspaceLock,
} from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';
import { SnapshotManager } from '../../src/tools/builtin/file/SnapshotManager.js';
import { FileLockManager } from '../../src/tools/execution/FileLockManager.js';
import {
  bindExecutionWorkspaceToolPolicy,
  createWorkspaceToolPolicy,
} from '../../src/tools/execution/WorkspaceToolPolicy.js';
import type { ExecutionContext } from '../../src/tools/types/index.js';
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
    vi.restoreAllMocks();
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

  function createAcpLocalSession(options: {
    sessionId: string;
    workspaceRoot: string;
  }): void {
    const harness = createPairedAcpHarness(new ControlledFileClient());
    harnesses.push(harness);
    sessionIds.add(options.sessionId);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      options.sessionId,
      {},
      options.workspaceRoot
    );
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
    client: ControlledFileClient;
    service: AcpFileSystemService;
    harness: PairedAcpHarness;
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
    const service = getAcpFileSystemService(options.sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    return { requests, client, service, harness };
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

  function localExecutionContext(context: ExecutionContext): ExecutionContext {
    const workspaceRoot = context.workspaceRoot ?? workspace;
    return bindExecutionWorkspaceToolPolicy(
      context,
      createWorkspaceToolPolicy(createLocalSessionWorkspace(workspaceRoot))
    );
  }

  it('derives remote workspace locks from collision identity without exposing roots', () => {
    const first = createRemotePatchWorkspaceIdentity(
      'workspace-collision-session',
      'C:\\Workspace'
    );
    const alias = createRemotePatchWorkspaceIdentity(
      'workspace-collision-session',
      'c:/workspace'
    );
    const posixCaseVariant = createRemotePatchWorkspaceIdentity(
      'workspace-collision-session',
      '/Workspace'
    );

    expect(first).toBe(alias);
    expect(posixCaseVariant).not.toBe(
      createRemotePatchWorkspaceIdentity('workspace-collision-session', '/workspace')
    );
    expect(first).toMatch(/^acp-remote-workspace:[a-f0-9]{64}$/);
    expect(first).not.toContain('Workspace');
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
      localExecutionContext({
        sessionId: 'patch-session',
        messageId: 'patch-message',
        workspaceRoot: workspace,
      })
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
      localExecutionContext({
        sessionId: 'unread-session',
        messageId: 'unread-message',
        workspaceRoot: workspace,
      })
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

  it('keeps local failure metadata when ACP mode is active but filesystem ownership is still local', async () => {
    const sessionId = 'acp-local-apply-patch';
    const filePath = path.join(workspace, 'source.ts');
    await fs.writeFile(filePath, 'const value = false;\n');
    createAcpLocalSession({
      sessionId,
      workspaceRoot: workspace,
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: source.ts
-const value = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'acp-local-unread-message',
        workspaceRoot: workspace,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.llmContent).toContain('Update File content must begin with "@@"');
    expect(result.metadata).toBeDefined();
    expect(Object.hasOwn(result.metadata ?? {}, 'sideEffectsUncertain')).toBe(false);
    expect(Object.hasOwn(result.metadata ?? {}, 'write_verified')).toBe(false);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('const value = false;\n');
  });

  it('fails closed when frozen remote ownership disagrees with the resolved ACP filesystem service', async () => {
    const sessionId = 'acp-remote-mismatch';
    const remoteFiles = new Map([
      ['C:\\workspace\\source.ts', 'const value = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });
    const sessionServices = AcpServiceContext.getSessionServices(sessionId);
    expect(sessionServices).not.toBeNull();
    if (!sessionServices) {
      throw new Error('expected ACP session services');
    }
    sessionServices.fileSystemService = new LocalFileSystemService();

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
        messageId: 'acp-remote-mismatch-message',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.llmContent).toContain('ACP remote ApplyPatch requires');
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: false,
      write_verified: false,
    });
    expect(remoteFiles.get('C:\\workspace\\source.ts')).toBe('const value = false;\n');
  });

  it.each([
    {
      label: 'explicit unknown session',
      sessionId: 'missing-remote-patch-session',
      workspaceKind: undefined,
    },
    {
      label: 'remote kind without a current session',
      sessionId: undefined,
      workspaceKind: 'acp-remote' as const,
    },
  ])(
    'does not fall back to host ApplyPatch for $label',
    async ({ sessionId, workspaceKind }) => {
      const localCanaryPath = path.join(workspace, 'source.ts');
      await fs.writeFile(localCanaryPath, 'const value = false;\n');

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
          messageId: 'missing-remote-patch-message',
          workspaceKind,
          workspaceRoot: workspace,
          executionRoot: 'C:\\workspace',
        }
      );

      expect(result.success).toBe(false);
      expect(result).toMatchObject({
        error: { code: 'acp_session_unavailable' },
        metadata: { sideEffectsUncertain: false },
      });
      await expect(fs.readFile(localCanaryPath, 'utf8')).resolves.toBe(
        'const value = false;\n'
      );
    }
  );

  it('uses the current remote session when direct ApplyPatch omits sessionId', async () => {
    const remoteFiles = new Map([
      ['C:\\workspace\\source.ts', 'const value = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId: 'current-remote-patch-session',
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
        messageId: 'current-remote-patch-message',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(true);
    expect(remoteFiles.get('C:\\workspace\\source.ts')).toBe('const value = true;\n');
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
        workspaceRoot: workspace,
        executionRoot: 'C:\\workspace',
        workspaceKind: 'acp-remote',
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

  it.each([
    {
      label: 'unsupported operation',
      expectedReason: 'unsupported-operation',
      rejectedPath: 'unsupported.ts',
      patch: `*** Begin Patch
*** Add File: unsupported.ts
+export const value = true;
*** End Patch`,
    },
    {
      label: 'Windows ADS before invalid character',
      expectedReason: 'alternate-data-stream',
      rejectedPath: 'secret.ts:stream?',
      patch: `*** Begin Patch
*** Update File: secret.ts:stream?
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'Windows reserved device before trailing component',
      expectedReason: 'reserved-device-name',
      rejectedPath: 'CON.',
      patch: `*** Begin Patch
*** Update File: CON.
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'Windows trailing component',
      expectedReason: 'trailing-dot-or-space',
      rejectedPath: 'nested. /file.ts',
      patch: `*** Begin Patch
*** Update File: nested. /file.ts
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'Windows reserved device extension',
      expectedReason: 'reserved-device-name',
      rejectedPath: 'NUL.txt',
      patch: `*** Begin Patch
*** Update File: NUL.txt
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'Windows superscript reserved device',
      expectedReason: 'reserved-device-name',
      rejectedPath: 'nested/LPT².log',
      patch: `*** Begin Patch
*** Update File: nested/LPT².log
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'Windows short-name alias',
      expectedReason: 'short-name-alias',
      rejectedPath: 'PROGRA~1/file.ts',
      patch: `*** Begin Patch
*** Update File: PROGRA~1/file.ts
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'Windows invalid character',
      expectedReason: 'invalid-character',
      rejectedPath: 'bad?.ts',
      patch: `*** Begin Patch
*** Update File: bad?.ts
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'workspace escape',
      expectedReason: 'workspace-escape',
      rejectedPath: '../outside.ts',
      patch: `*** Begin Patch
*** Update File: ../outside.ts
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'restricted path case alias',
      expectedReason: 'restricted-path',
      rejectedPath: '.GIT/config',
      patch: `*** Begin Patch
*** Update File: .GIT/config
@@
-before
+after
*** End Patch`,
    },
    {
      label: 'exact duplicate target',
      expectedReason: 'duplicate-target',
      rejectedPath: 'same.ts',
      patch: `*** Begin Patch
*** Update File: same.ts
@@
-before
+after
*** Update File: same.ts
@@
-before
+after again
*** End Patch`,
    },
    {
      label: 'Windows case-only duplicate target',
      expectedReason: 'duplicate-target',
      rejectedPath: 'folder/file.ts',
      patch: `*** Begin Patch
*** Update File: Folder/File.ts
@@
-before
+after
*** Update File: folder/file.ts
@@
-before
+after again
*** End Patch`,
    },
  ])(
    'rejects $label before every remote coordination or I/O side effect',
    async ({ label, expectedReason, patch: patchText, rejectedPath }) => {
      const sessionId = `remote-patch-invalid-${label.replaceAll(' ', '-')}`;
      const { requests, service } = createRemotePatchSession({
        sessionId,
        workspaceRoot: 'C:\\workspace',
        files: new Map(),
      });
      const workspaceLockSpy = vi.spyOn(
        patchTransactionCoordinator,
        'withPatchWorkspaceLock'
      );
      const opaqueLockSpy = vi.spyOn(
        FileLockManager.getInstance(),
        'acquireOpaqueLocks'
      );
      const stringLeaseSpy = vi.spyOn(service, 'tryAcquireMutationLease');
      const parsedLeaseSpy = vi.spyOn(service, 'tryAcquireMutationLeaseForParsedPaths');

      const result = await applyPatchTool.execute({ patch: patchText }, undefined, {
        sessionId,
        messageId: `remote-invalid-${label}`,
        workspaceRoot: 'C:\\workspace',
      });

      expect(result.success).toBe(false);
      expect(result.llmContent).toBe('ACP remote patch is invalid');
      expect(result.error).toEqual({
        type: 'validation_error',
        code: 'acp_remote_patch_invalid',
        message: 'ACP remote patch is invalid',
        details: { reason: expectedReason },
      });
      expect(result.metadata).toMatchObject({ sideEffectsUncertain: false });
      expect(JSON.stringify(result)).not.toContain(rejectedPath);
      expect(workspaceLockSpy).not.toHaveBeenCalled();
      expect(opaqueLockSpy).not.toHaveBeenCalled();
      expect(stringLeaseSpy).not.toHaveBeenCalled();
      expect(parsedLeaseSpy).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(await listPatchStateEntries()).toEqual([]);
    }
  );

  it('remote ApplyPatch 只接受 Update File，不能退化为 Add File', async () => {
    const sessionId = 'remote-patch-update-only';
    const remoteFiles = new Map<string, string>();
    const { requests, service } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });
    const parseSpy = vi.spyOn(service, 'parsePath');

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
    expect(result.llmContent).toBe('ACP remote patch is invalid');
    expect(result.error).toMatchObject({
      type: 'validation_error',
      code: 'acp_remote_patch_invalid',
    });
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: false,
      write_verified: false,
    });
    expect(parseSpy).not.toHaveBeenCalled();
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

  it('redacts remote planner path and hunk content after preflight I/O', async () => {
    const sessionId = 'remote-patch-planner-redaction';
    const rejectedPath = 'private-file.ts';
    const rejectedContent = 'PRIVATE_EXPECTED_CONTENT';
    const { requests } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: new Map([['C:\\workspace\\private-file.ts', 'public content\n']]),
    });

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: ${rejectedPath}
@@
-${rejectedContent}
+replacement
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-planner-redaction',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.llmContent).toBe('ACP remote patch preflight failed');
    expect(result.error?.message).toBe('ACP remote patch preflight failed');
    expect(JSON.stringify(result)).not.toContain(rejectedPath);
    expect(JSON.stringify(result)).not.toContain(rejectedContent);
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: false,
      write_acknowledged: false,
      write_verified: false,
    });
    expect(requests).toHaveLength(1);
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
    const { requests, service } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });
    const parseSpy = vi.spyOn(service, 'parsePath');

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
    expect(parseSpy).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      kind: 'patch',
      snapshot_created: false,
      write_verified: true,
      sideEffectsUncertain: false,
    });
    expect(result.metadata?.summary).toContain('C:\\workspace');
    expect(result.metadata?.summary).not.toContain('acp-remote-workspace:');
    expect(String(result.llmContent)).toContain('C:\\workspace\\first.ts');
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
    expect(remoteFiles.get('C:\\workspace\\first.ts')).toBe(
      'const first = rollback mismatch;\n'
    );
    expect(remoteFiles.get('C:\\workspace\\second.ts')).toBe('const second = false;\n');
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    const service = getAcpFileSystemService(sessionId);
    expect(service).toBeInstanceOf(AcpFileSystemService);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(service.getRemoteAccessRecord('C:\\workspace\\first.ts')).toBeUndefined();
    expect(service.getRemoteAccessRecord('C:\\workspace\\second.ts')).toBeUndefined();
    expect(result.metadata?.summary).toBe(
      'ApplyPatch failed; final remote state is uncertain, re-read affected files before retrying'
    );
  });

  it('remote ApplyPatch 在 pending write uncertainty 下返回 exact uncertain metadata', async () => {
    const sessionId = 'remote-patch-pending-current-metadata';
    const remoteFiles = new Map([
      ['C:\\workspace\\first.ts', 'const first = false;\n'],
      ['C:\\workspace\\second.ts', 'const second = false;\n'],
      ['C:\\workspace\\third.ts', 'const third = false;\n'],
    ]);
    createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });
    vi.spyOn(applyPatchTransaction, 'commitRemotePatchTransaction').mockRejectedValue(
      new applyPatchTransaction.AcpRemotePatchTransactionError(
        [
          Object.assign(new Error('pending write requires read'), {
            name: 'AcpRemoteMutationError',
            requestPending: true,
            requiresRead: true,
            sideEffectsUncertain: true,
          }),
        ],
        true
      )
    );

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
*** Update File: third.ts
@@
-const third = false;
+const third = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-pending-current-metadata',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.metadata).toEqual({
      sideEffectsUncertain: true,
      write_acknowledged: false,
      write_verified: false,
      requiresRead: true,
      summary:
        'ApplyPatch failed; final remote state is uncertain, re-read affected files before retrying',
    });
    expect(result.llmContent).toContain(
      'Use Read on the same file to refresh remote state before retrying ApplyPatch'
    );
  });

  it('redacts raw remote absolute paths and private rollback sentinel text from user-facing remote ApplyPatch failures', async () => {
    const sessionId = 'remote-patch-redacted-user-failure';
    const sentinel = 'PRIVATE_ROLLBACK_SENTINEL';
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
          error: new Error(`${sentinel}: forward failed at C:\\workspace\\second.ts`),
        },
        {
          kind: 'replace-and-throw',
          content: 'const first = rollback mismatch;\n',
          error: new Error(`${sentinel}: rollback mismatch at C:\\workspace\\first.ts`),
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
        messageId: 'remote-redacted-user-failure',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: true,
      write_verified: false,
    });
    expect(String(result.llmContent)).not.toContain(sentinel);
    expect(String(result.llmContent)).not.toContain('C:\\workspace\\first.ts');
    expect(String(result.llmContent)).not.toContain('C:\\workspace\\second.ts');
    expect(result.error?.message).not.toContain(sentinel);
    expect(result.error?.message).not.toContain('C:\\workspace\\first.ts');
    expect(result.error?.message).not.toContain('C:\\workspace\\second.ts');
  });

  it('rejects a quarantined target before creating the host-private workspace lock or sending ACP I/O', async () => {
    const sessionId = 'remote-patch-precheck-before-workspace-lock';
    const remoteFiles = new Map([
      ['C:\\workspace\\source.ts', 'const value = false;\n'],
    ]);
    const { requests, service } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: remoteFiles,
    });
    const quarantineLease = service.tryAcquireMutationLease([
      'C:\\workspace\\source.ts',
    ]);
    quarantineLease.markUncertain(parseAcpRemotePath('C:\\workspace\\source.ts'));
    quarantineLease.release();

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
        messageId: 'remote-precheck-before-workspace-lock',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.metadata).toMatchObject({
      sideEffectsUncertain: true,
      write_acknowledged: false,
      write_verified: false,
      requiresRead: true,
    });
    expect(result.llmContent).toContain(
      'Use Read on the same file to refresh remote state before retrying ApplyPatch'
    );
    expect(requests).toEqual([]);
    await expect(
      fs.stat(path.join(root, '.storage', 'patch-transactions'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('acquires workspace and sorted opaque locks before atomically trying all coordinator leases', async () => {
    const sessionId = 'remote-patch-lock-order';
    createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: new Map([
        ['C:\\workspace\\alpha.ts', 'export const alpha = false;\n'],
        ['C:\\workspace\\zeta.ts', 'export const zeta = false;\n'],
      ]),
    });
    const service = getAcpFileSystemService(sessionId);
    expect(service).toBeInstanceOf(AcpFileSystemService);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    const events: string[] = [];
    const opaqueKeys = [
      service.createOpaqueLockKey('C:\\workspace\\zeta.ts'),
      service.createOpaqueLockKey('C:\\workspace\\alpha.ts'),
    ].sort();
    const originalAcquireOpaqueLocks =
      FileLockManager.getInstance().acquireOpaqueLocks.bind(
        FileLockManager.getInstance()
      );
    const workspaceSpy = vi
      .spyOn(patchTransactionCoordinator, 'withPatchWorkspaceLock')
      .mockImplementation(async (workspaceIdentity, operation) => {
        events.push(`workspace:${workspaceIdentity}`);
        events.push('workspace:entered');
        return operation();
      });
    const tryAcquireSpy = vi.spyOn(service, 'tryAcquireMutationLeaseForParsedPaths');
    const acquireOpaqueLocksSpy = vi
      .spyOn(FileLockManager.getInstance(), 'acquireOpaqueLocks')
      .mockImplementation(async (lockKeys, operation) => {
        events.push(`opaque:${JSON.stringify([...lockKeys])}`);
        return originalAcquireOpaqueLocks(lockKeys, operation);
      });
    tryAcquireSpy.mockImplementation((paths) => {
      events.push(
        `lease:${JSON.stringify(paths.map((remotePath) => remotePath.wirePath))}`
      );
      return AcpFileSystemService.prototype.tryAcquireMutationLeaseForParsedPaths.call(
        service,
        paths
      );
    });

    const execution = applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: zeta.ts
@@
-export const zeta = false;
+export const zeta = true;
*** Update File: alpha.ts
@@
-export const alpha = false;
+export const alpha = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-lock-order',
        workspaceRoot: 'C:\\workspace',
      }
    );

    await expect(execution).resolves.toMatchObject({ success: true });
    expect(acquireOpaqueLocksSpy).toHaveBeenCalledWith(
      expect.arrayContaining(opaqueKeys),
      expect.any(Function)
    );
    expect(acquireOpaqueLocksSpy.mock.calls[0]?.[0]).toHaveLength(opaqueKeys.length);
    expect(tryAcquireSpy).toHaveBeenCalledTimes(1);
    expect(
      tryAcquireSpy.mock.calls[0]?.[0].map((remotePath) => remotePath.wirePath)
    ).toEqual(['C:\\workspace\\alpha.ts', 'C:\\workspace\\zeta.ts']);
    expect(events).toEqual([
      `workspace:${createRemotePatchWorkspaceIdentity(sessionId, 'C:\\workspace')}`,
      'workspace:entered',
      `opaque:${JSON.stringify(acquireOpaqueLocksSpy.mock.calls[0]?.[0])}`,
      'lease:["C:\\\\workspace\\\\alpha.ts","C:\\\\workspace\\\\zeta.ts"]',
    ]);
    workspaceSpy.mockRestore();
  });

  it('releases every host and coordinator lock when one atomic lease acquisition conflicts', async () => {
    const sessionId = 'remote-patch-atomic-lease-conflict';
    const { requests, harness, service } = createRemotePatchSession({
      sessionId,
      workspaceRoot: 'C:\\workspace',
      files: new Map([
        ['C:\\workspace\\first.ts', 'export const first = false;\n'],
        ['C:\\workspace\\second.ts', 'export const second = false;\n'],
      ]),
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const conflictingLease = coordinator.tryAcquireMutationLease(
      [parseAcpRemotePath('C:\\workspace\\first.ts')],
      'foreign-session'
    );
    const workspaceIdentity = createRemotePatchWorkspaceIdentity(
      sessionId,
      'C:\\workspace'
    );
    const opaqueKeys = [
      service.createOpaqueLockKey('C:\\workspace\\first.ts'),
      service.createOpaqueLockKey('C:\\workspace\\second.ts'),
    ].sort();

    const result = await applyPatchTool.execute(
      {
        patch: `*** Begin Patch
*** Update File: first.ts
@@
-export const first = false;
+export const first = true;
*** Update File: second.ts
@@
-export const second = false;
+export const second = true;
*** End Patch`,
      },
      undefined,
      {
        sessionId,
        messageId: 'remote-atomic-lease-conflict',
        workspaceRoot: 'C:\\workspace',
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(requests).toEqual([]);
    await expect.poll(() => FileLockManager.getInstance().getLockedFiles()).toEqual([]);
    await expect(
      withPatchWorkspaceLock(workspaceIdentity, async () => 'workspace-unlocked')
    ).resolves.toBe('workspace-unlocked');
    await expect(
      FileLockManager.getInstance().acquireOpaqueLocks(opaqueKeys, async () => 'ok')
    ).resolves.toBe('ok');
    const cleanLease = coordinator.tryAcquireMutationLease(
      [parseAcpRemotePath('C:\\workspace\\second.ts')],
      sessionId
    );
    expect(cleanLease.isCurrent(parseAcpRemotePath('C:\\workspace\\second.ts'))).toBe(
      true
    );
    cleanLease.release();
    conflictingLease.release();
  });

  it('starts the 120 second forward request budget after lock wait completes', async () => {
    vi.useFakeTimers({ now: 5_000 });
    try {
      const sessionId = 'remote-patch-forward-budget-start';
      const { service } = createRemotePatchSession({
        sessionId,
        workspaceRoot: 'C:\\workspace',
        files: new Map([['C:\\workspace\\source.ts', 'const value = false;\n']]),
      });
      const opaqueLockKey = service.createOpaqueLockKey('C:\\workspace\\source.ts');
      let releaseOpaque!: () => void;
      const opaqueGate = new Promise<void>((resolve) => {
        releaseOpaque = resolve;
      });
      const heldOpaque = FileLockManager.getInstance().acquireOpaqueLock(
        opaqueLockKey,
        async () => {
          await opaqueGate;
        }
      );
      const planSpy = vi.spyOn(applyPatchTransaction, 'planRemotePatchTransaction');
      const commitSpy = vi.spyOn(applyPatchTransaction, 'commitRemotePatchTransaction');

      const execution = applyPatchTool.execute(
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
          messageId: 'remote-forward-budget-start',
          workspaceRoot: 'C:\\workspace',
        }
      );

      await Promise.resolve();
      await Promise.resolve();
      expect(planSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(planSpy).not.toHaveBeenCalled();

      releaseOpaque();
      await heldOpaque;
      await Promise.resolve();
      await Promise.resolve();
      await expect(execution).resolves.toMatchObject({ success: true });

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(
        (planSpy.mock.calls[0]?.[3] as { deadlineAt?: number } | undefined)?.deadlineAt
      ).toBe(5_000 + 9_000 + ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS);
      expect(
        (commitSpy.mock.calls[0]?.[2] as { forwardDeadlineAt?: number } | undefined)
          ?.forwardDeadlineAt
      ).toBe(5_000 + 9_000 + ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
