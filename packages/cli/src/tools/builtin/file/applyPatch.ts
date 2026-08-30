import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as Diff from 'diff';
import {
  AcpFileSystemCapabilityError,
  AcpFileSystemService,
  normalizeAcpRemotePath,
} from '../../../acp/AcpFileSystemService.js';
import { getAcpFileSystemService, isAcpMode } from '../../../acp/AcpServiceContext.js';
import { Type } from '../../../schema/index.js';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { createTool } from '../../core/createTool.js';
import { FileLockManager } from '../../execution/FileLockManager.js';
import type {
  ApplyPatchMetadata,
  ExecutionContext,
  ToolResult,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { extractApplyPatchPaths, parseApplyPatch } from './applyPatchParser.js';
import {
  AcpRemotePatchTransactionError,
  commitLocalPatchTransaction,
  commitRemotePatchTransaction,
  type PatchTransactionPlan,
  planLocalPatchTransaction,
  planRemotePatchTransaction,
} from './applyPatchTransaction.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import {
  createRemotePatchWorkspaceIdentity,
  recoverWorkspacePatchTransactionsUnderLock,
  withPatchWorkspaceLock,
} from './PatchTransactionCoordinator.js';
import { SnapshotManager, type SnapshotMetadata } from './SnapshotManager.js';

interface PendingSnapshot {
  path: string;
  metadata: SnapshotMetadata;
}

export const applyPatchTool = createTool({
  name: 'ApplyPatch',
  displayName: 'Apply Patch',
  kind: ToolKind.Write,
  strict: true,
  isConcurrencySafe: true,
  parallelism: 'shared',
  schema: Type.Object({
    patch: Type.String({
      minLength: 1,
      description:
        'A complete *** Begin Patch / *** End Patch document containing relative file operations',
    }),
  }),
  affectedPaths: ({ patch: patchText }) => safePatchPaths(patchText),
  extractSignatureContent: ({ patch: patchText }) => {
    const paths = safePatchPaths(patchText);
    const preview = paths.slice(0, 5).join(', ');
    return paths.length > 5
      ? `${preview} (+${paths.length - 5} more)`
      : preview || 'invalid patch';
  },
  description: {
    short: 'Atomically applies a multi-file text patch',
    long:
      'Parses and preflights the complete patch before changing files. Local ' +
      'changes use sorted multi-path locks, same-directory staging, backups, ' +
      'and rollback. ACP remote files support update-only transactions with ' +
      'verified compensating rollback because ACP has no delete or rename API.',
    usageNotes: [
      'Use relative POSIX paths only. Absolute paths and traversal are rejected.',
      'Use *** Add File, *** Delete File, or *** Update File sections.',
      'Update hunks begin with @@ and every hunk line begins with space, -, or +.',
      'Existing local files must have been read in this Session before patching.',
      'The full patch is all-or-nothing; any parse, context, path, or commit failure rolls back.',
    ],
    examples: [
      {
        description: 'Update one file and add another',
        params: {
          patch:
            '*** Begin Patch\n' +
            '*** Update File: src/app.ts\n' +
            '@@\n' +
            '-const ready = false;\n' +
            '+const ready = true;\n' +
            '*** Add File: src/value.ts\n' +
            '+export const value = 1;\n' +
            '*** End Patch',
        },
      },
    ],
    important: [
      'Do not wrap the patch in a shell command or Markdown fence.',
      'A failed transaction never intentionally leaves a committed prefix.',
    ],
  },
  async execute(
    params: { patch: string },
    context: ExecutionContext
  ): Promise<ToolResult> {
    const workspaceRoot = context.workspaceRoot;
    if (!workspaceRoot) {
      return failure('ApplyPatch requires a Session workspace root');
    }
    const signal = context.signal ?? new AbortController().signal;
    try {
      const operations = parseApplyPatch(params.patch);
      const acpMode = isAcpMode(context.sessionId);
      const fileSystem = acpMode
        ? getAcpFileSystemService(context.sessionId)
        : getFileSystemService();
      const remote =
        acpMode &&
        fileSystem instanceof AcpFileSystemService &&
        fileSystem.usesRemoteFiles();
      if (remote) {
        try {
          fileSystem.assertTextMutationCapabilities();
        } catch (error) {
          if (error instanceof AcpFileSystemCapabilityError) {
            return failure(
              `ACP remote ApplyPatch requires ${error.operation} capability`,
              ToolErrorType.VALIDATION_ERROR,
              {
                sideEffectsUncertain: false,
                write_verified: false,
              }
            );
          }
          throw error;
        }
      }
      const workspaceIdentity =
        remote && context.sessionId
          ? createRemotePatchWorkspaceIdentity(context.sessionId, workspaceRoot)
          : await fs.realpath(workspaceRoot);
      const lockPaths = remote
        ? safePatchPaths(params.patch).map((filePath) =>
            fileSystem.createOpaqueLockKey(resolveLockPath(workspaceRoot, filePath))
          )
        : safePatchPaths(params.patch).map((filePath) =>
            resolveLockPath(workspaceIdentity, filePath)
          );
      return await withPatchWorkspaceLock(workspaceIdentity, async () => {
        signal.throwIfAborted();
        if (!remote) {
          await recoverWorkspacePatchTransactionsUnderLock(workspaceIdentity);
        }
        const runWithLocks = remote
          ? FileLockManager.getInstance().acquireOpaqueLocks.bind(
              FileLockManager.getInstance()
            )
          : FileLockManager.getInstance().acquireLocks.bind(
              FileLockManager.getInstance()
            );
        return runWithLocks(lockPaths, async () => {
          let plan: PatchTransactionPlan;
          if (remote) {
            context.updateOutput?.('Preflighting remote patch...');
            plan = await planRemotePatchTransaction(
              operations,
              workspaceRoot,
              fileSystem,
              signal
            );
          } else {
            context.updateOutput?.('Preflighting atomic patch...');
            plan = await planLocalPatchTransaction(
              operations,
              workspaceIdentity,
              signal
            );
            const unread = unreadExistingPaths(
              plan,
              workspaceIdentity,
              context.sessionId
            );
            if (unread.length > 0) {
              return failure(
                `Read the existing file${unread.length === 1 ? '' : 's'} before applying this patch:\n${unread.join('\n')}`,
                ToolErrorType.VALIDATION_ERROR
              );
            }
          }

          const snapshots = remote
            ? []
            : await createSnapshots(plan, context, workspaceIdentity);
          try {
            context.updateOutput?.(
              `Applying ${plan.changes.length} atomic file change${
                plan.changes.length === 1 ? '' : 's'
              }...`
            );
            if (remote) {
              await commitRemotePatchTransaction(plan, fileSystem, signal);
            } else {
              await commitLocalPatchTransaction(plan, signal);
            }
          } catch (error) {
            await discardSnapshots(snapshots, context, workspaceIdentity);
            throw error;
          }

          const snapshotCreated = await finalizeSnapshots(
            snapshots,
            context,
            workspaceIdentity
          );
          if (!remote) {
            await updateFileAccess(plan, context.sessionId);
          }
          const metadata: ApplyPatchMetadata = {
            kind: 'patch',
            changes: plan.changes.map((change) => ({
              kind: change.kind,
              path: change.path,
              oldContent: change.oldContent,
              newContent: change.newContent,
              diff: Diff.createTwoFilesPatch(
                change.path,
                change.path,
                change.oldContent ?? '',
                change.newContent ?? '',
                '',
                '',
                { context: 4 }
              ),
            })),
            affected_paths: plan.affectedPaths,
            snapshot_created: snapshotCreated,
            session_id: context.sessionId,
            message_id: context.messageId,
            summary: summarizePlan(plan, workspaceIdentity),
            write_verified: remote ? true : undefined,
            sideEffectsUncertain: remote ? false : undefined,
          };
          return {
            success: true,
            llmContent: renderPlan(plan, remote ? workspaceRoot : workspaceIdentity),
            metadata,
          };
        });
      });
    } catch (error) {
      if (error instanceof AcpRemotePatchTransactionError) {
        return failure(error.message, ToolErrorType.EXECUTION_ERROR, {
          sideEffectsUncertain: error.sideEffectsUncertain,
          write_verified: false,
        });
      }
      return failure(
        error instanceof Error ? error.message : String(error),
        ToolErrorType.EXECUTION_ERROR
      );
    }
  },
});

function safePatchPaths(patchText: string): string[] {
  try {
    return [...new Set(extractApplyPatchPaths(patchText))];
  } catch {
    return [];
  }
}

function resolveLockPath(workspaceRoot: string, filePath: string): string {
  const pathApi = /^[A-Za-z]:[\\/]/.test(workspaceRoot) ? path.win32 : path.posix;
  return pathApi.resolve(workspaceRoot, ...filePath.split('/'));
}

function unreadExistingPaths(
  plan: PatchTransactionPlan,
  workspaceRoot: string,
  sessionId?: string
): string[] {
  if (!sessionId) return [];
  const tracker = FileAccessTracker.getInstance();
  return plan.changes
    .filter((change) => change.oldContent !== null)
    .filter((change) => {
      const lexicalPath = path.resolve(
        workspaceRoot,
        path.relative(workspaceRoot, change.path)
      );
      return (
        !tracker.hasFileBeenRead(change.path, sessionId) &&
        !tracker.hasFileBeenRead(lexicalPath, sessionId)
      );
    })
    .map((change) => path.relative(workspaceRoot, change.path));
}

async function createSnapshots(
  plan: PatchTransactionPlan,
  context: ExecutionContext,
  workspaceRoot: string
): Promise<PendingSnapshot[]> {
  if (!context.sessionId || !context.messageId) return [];
  const manager = new SnapshotManager({
    sessionId: context.sessionId,
    workspaceRoot,
  });
  await manager.initialize();
  const snapshots: PendingSnapshot[] = [];
  try {
    for (const filePath of plan.affectedPaths) {
      snapshots.push({
        path: filePath,
        metadata: await manager.createSnapshot(filePath, context.messageId),
      });
    }
    return snapshots;
  } catch (error) {
    await Promise.allSettled(
      snapshots.map((snapshot) =>
        manager.discardSnapshot(snapshot.path, snapshot.metadata)
      )
    );
    throw new Error(
      `Cannot create ApplyPatch checkpoint: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function finalizeSnapshots(
  snapshots: readonly PendingSnapshot[],
  context: ExecutionContext,
  workspaceRoot: string
): Promise<boolean> {
  if (snapshots.length === 0 || !context.sessionId) return false;
  const manager = new SnapshotManager({
    sessionId: context.sessionId,
    workspaceRoot,
  });
  await manager.initialize();
  const outcomes = await Promise.allSettled(
    snapshots.map((snapshot) =>
      manager.recordPostEditState(snapshot.path, snapshot.metadata)
    )
  );
  await Promise.allSettled(
    snapshots
      .filter((_snapshot, index) => outcomes[index]?.status === 'rejected')
      .map((snapshot) => manager.discardSnapshot(snapshot.path, snapshot.metadata))
  );
  return outcomes.every((outcome) => outcome.status === 'fulfilled');
}

async function discardSnapshots(
  snapshots: readonly PendingSnapshot[],
  context: ExecutionContext,
  workspaceRoot: string
): Promise<void> {
  if (snapshots.length === 0 || !context.sessionId) return;
  const manager = new SnapshotManager({
    sessionId: context.sessionId,
    workspaceRoot,
  });
  await manager.initialize();
  await Promise.allSettled(
    snapshots.map((snapshot) =>
      manager.discardSnapshot(snapshot.path, snapshot.metadata)
    )
  );
}

async function updateFileAccess(
  plan: PatchTransactionPlan,
  sessionId?: string
): Promise<void> {
  if (!sessionId) return;
  const tracker = FileAccessTracker.getInstance();
  for (const change of plan.changes) {
    if (change.newContent === null) {
      tracker.clearFileRecord(change.path, sessionId);
    } else {
      await tracker.recordFileEdit(change.path, sessionId, 'edit');
    }
  }
}

function summarizePlan(plan: PatchTransactionPlan, workspaceRoot: string): string {
  const counts = {
    add: plan.changes.filter((change) => change.kind === 'add').length,
    update: plan.changes.filter((change) => change.kind === 'update').length,
    delete: plan.changes.filter((change) => change.kind === 'delete').length,
  };
  return `Applied ${plan.changes.length} file changes atomically (${counts.add} added, ${counts.update} updated, ${counts.delete} deleted) in ${path.basename(workspaceRoot)}`;
}

function renderPlan(plan: PatchTransactionPlan, workspaceRoot: string): string {
  const markers = { add: 'A', update: 'M', delete: 'D' } as const;
  return [
    summarizePlan(plan, workspaceRoot),
    ...plan.changes.map(
      (change) => `${markers[change.kind]} ${path.relative(workspaceRoot, change.path)}`
    ),
  ].join('\n');
}

function failure(
  message: string,
  type: ToolErrorType = ToolErrorType.EXECUTION_ERROR,
  metadata?: Partial<ApplyPatchMetadata>
): ToolResult {
  return {
    success: false,
    llmContent: message,
    error: { type, message },
    metadata: {
      summary: 'ApplyPatch failed; no partial patch was accepted',
      ...metadata,
    },
  };
}
