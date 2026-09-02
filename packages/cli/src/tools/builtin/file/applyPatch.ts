import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as Diff from 'diff';
import {
  ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
} from '../../../acp/AcpFileRequestCoordinator.js';
import {
  AcpFileSystemCapabilityError,
  AcpFileSystemService,
} from '../../../acp/AcpFileSystemService.js';
import { AcpRemotePathError } from '../../../acp/AcpRemotePath.js';
import {
  AcpServiceContext,
  getAcpFileSystemService,
  isAcpMode,
  isAcpRemoteFileSystem,
  isExplicitUnknownAcpSession,
} from '../../../acp/AcpServiceContext.js';
import { Type } from '../../../schema/index.js';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { createTool } from '../../core/createTool.js';
import { FileLockManager } from '../../execution/FileLockManager.js';
import { createUnavailableAcpSessionFileSystemResult } from '../../execution/ToolExecutionResults.js';
import { getExecutionWorkspaceToolPolicy } from '../../execution/WorkspaceToolPolicy.js';
import type {
  ApplyPatchMetadata,
  ExecutionContext,
  ToolResult,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import {
  ApplyPatchParseError,
  extractApplyPatchPaths,
  parseApplyPatch,
} from './applyPatchParser.js';
import {
  type AcpRemotePatchPreflight,
  AcpRemotePatchTransactionError,
  AcpRemotePatchValidationError,
  commitLocalPatchTransaction,
  commitRemotePatchTransaction,
  type PatchTransactionPlan,
  planLocalPatchTransaction,
  planRemotePatchTransaction,
  preflightRemotePatchTransaction,
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
    let remoteOwnership = false;
    const trustedWorkspaceKind = getExecutionWorkspaceToolPolicy(context)?.kind;
    if (
      isExplicitUnknownAcpSession(
        context.sessionId,
        context.workspaceKind,
        trustedWorkspaceKind
      )
    ) {
      return createUnavailableAcpSessionFileSystemResult({ mutation: true });
    }
    const remote =
      trustedWorkspaceKind === 'acp-remote' ||
      (trustedWorkspaceKind !== 'local' && isAcpRemoteFileSystem(context.sessionId));
    remoteOwnership = remote;
    const remoteSessionId = remote
      ? (context.sessionId ?? AcpServiceContext.getCurrentSessionId())
      : undefined;
    const workspaceRoot = remote
      ? (context.executionRoot ?? context.workspaceRoot)
      : context.workspaceRoot;
    if (!workspaceRoot) {
      return failure('ApplyPatch requires a Session workspace root');
    }
    const signal = context.signal ?? new AbortController().signal;
    try {
      const operations = parseApplyPatch(params.patch);
      const acpMode =
        trustedWorkspaceKind === 'acp-remote' ||
        (trustedWorkspaceKind !== 'local' && isAcpMode(context.sessionId));
      const fileSystem = acpMode
        ? getAcpFileSystemService(context.sessionId)
        : getFileSystemService();
      let remoteFileSystem: AcpFileSystemService | null = null;
      let remotePreflight: AcpRemotePatchPreflight | undefined;
      if (remote) {
        if (
          !(fileSystem instanceof AcpFileSystemService) ||
          !fileSystem.usesRemoteFiles()
        ) {
          return failure(
            'ACP remote ApplyPatch requires a frozen ACP remote filesystem owner',
            ToolErrorType.EXECUTION_ERROR,
            {
              sideEffectsUncertain: false,
              write_verified: false,
            }
          );
        }
        remoteFileSystem = fileSystem;
        try {
          remoteFileSystem.assertTextMutationCapabilities();
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
        remotePreflight = preflightRemotePatchTransaction(
          operations,
          remoteFileSystem.getPathProfile()
        );
      }
      const workspaceIdentity =
        remote && remoteSessionId
          ? createRemotePatchWorkspaceIdentity(
              remoteSessionId,
              remotePreflight!.workspace
            )
          : await fs.realpath(workspaceRoot);
      const patchPaths = remote ? [] : uniqueOperationPaths(operations);
      const remoteTargetPaths = remote
        ? remotePreflight!.entries
            .flatMap((entry) =>
              entry.destination ? [entry.source, entry.destination] : [entry.source]
            )
            .sort((left, right) =>
              left.collisionIdentity.localeCompare(right.collisionIdentity)
            )
        : [];
      if (remote) {
        remoteFileSystem!.precheckMutationPathsForParsedPaths(remoteTargetPaths);
      }
      const lockPaths = remote
        ? remoteTargetPaths.map((remotePath) =>
            remoteFileSystem!.createOpaqueLockKeyForParsedPath(remotePath)
          )
        : patchPaths.map((filePath) =>
            resolveLocalPatchLockPath(workspaceIdentity, filePath)
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
            const lease =
              remoteFileSystem!.tryAcquireMutationLeaseForParsedPaths(
                remoteTargetPaths
              );
            const forwardDeadlineAt = Date.now() + ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS;
            try {
              const remotePlan = await planRemotePatchTransaction(
                operations,
                workspaceRoot,
                remoteFileSystem!,
                {
                  signal,
                  deadlineAt: forwardDeadlineAt,
                  lease,
                  preflight: remotePreflight,
                }
              );
              plan = remotePlan;
              context.updateOutput?.(
                `Applying ${plan.changes.length} atomic file change${
                  plan.changes.length === 1 ? '' : 's'
                }...`
              );
              await commitRemotePatchTransaction(remotePlan, remoteFileSystem!, {
                signal,
                forwardDeadlineAt,
                lease,
              });
              lease.commitVerified();
            } finally {
              lease.release();
            }
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
            if (!remote) {
              context.updateOutput?.(
                `Applying ${plan.changes.length} atomic file change${
                  plan.changes.length === 1 ? '' : 's'
                }...`
              );
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
            summary: summarizePlan(
              plan,
              remote
                ? remotePreflight!.workspace.wirePath
                : path.basename(workspaceIdentity)
            ),
            write_verified: remote ? true : undefined,
            sideEffectsUncertain: remote ? false : undefined,
          };
          return {
            success: true,
            llmContent: renderPlan(
              plan,
              remote ? undefined : workspaceIdentity,
              remote
                ? remotePreflight!.workspace.wirePath
                : path.basename(workspaceIdentity)
            ),
            metadata,
          };
        });
      });
    } catch (error) {
      if (remoteOwnership && error instanceof AcpRemotePatchValidationError) {
        return remotePatchValidationFailure(error.reason);
      }
      if (remoteOwnership && error instanceof AcpRemotePathError) {
        return remotePatchValidationFailure(error.reason);
      }
      if (remoteOwnership && error instanceof ApplyPatchParseError) {
        return remotePatchValidationFailure(
          isRemotePatchTraversalError(error, params.patch)
            ? 'workspace-escape'
            : undefined
        );
      }
      if (error instanceof AcpRemotePatchTransactionError) {
        const requiresRead = error.errors.some(
          (entry) =>
            entry instanceof Error &&
            'requiresRead' in entry &&
            (entry as Error & { requiresRead?: boolean }).requiresRead === true
        );
        return failure(error.message, ToolErrorType.EXECUTION_ERROR, {
          sideEffectsUncertain: error.sideEffectsUncertain,
          write_acknowledged: false,
          write_verified: false,
          requiresRead: requiresRead || undefined,
        });
      }
      const boundaryRequiresRead =
        error instanceof AcpRemoteFileBoundaryError &&
        Boolean(
          (error as AcpRemoteFileBoundaryError & { requiresRead?: boolean })
            .requiresRead
        );
      if (remoteOwnership && boundaryRequiresRead) {
        return failure(
          'Remote file state requires a fresh Read before mutation',
          ToolErrorType.EXECUTION_ERROR,
          {
            sideEffectsUncertain: true,
            write_acknowledged: false,
            write_verified: false,
            requiresRead: true,
          }
        );
      }
      const remoteFailureMetadata = remoteOwnership
        ? {
            sideEffectsUncertain: false,
            write_acknowledged: false,
            write_verified: false,
          }
        : undefined;
      return failure(
        error instanceof Error ? error.message : String(error),
        ToolErrorType.EXECUTION_ERROR,
        remoteFailureMetadata
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

function uniqueOperationPaths(
  operations: ReturnType<typeof parseApplyPatch>
): string[] {
  return [
    ...new Set(
      operations.flatMap((operation) =>
        operation.kind === 'update' && operation.movePath
          ? [operation.path, operation.movePath]
          : [operation.path]
      )
    ),
  ];
}

function isRemotePatchTraversalError(
  error: ApplyPatchParseError,
  patchText: string
): boolean {
  if (error.line === undefined) return false;
  const line = patchText.replace(/\r\n/g, '\n').split('\n')[error.line - 1];
  if (!line) return false;
  const marker = [
    '*** Add File: ',
    '*** Delete File: ',
    '*** Update File: ',
    '*** Move to: ',
  ].find((candidate) => line.startsWith(candidate));
  return marker !== undefined && line.slice(marker.length).split('/').includes('..');
}

function resolveLocalPatchLockPath(workspaceRoot: string, filePath: string): string {
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

function summarizePlan(plan: PatchTransactionPlan, workspaceLabel: string): string {
  const counts = {
    add: plan.changes.filter((change) => change.kind === 'add').length,
    update: plan.changes.filter((change) => change.kind === 'update').length,
    delete: plan.changes.filter((change) => change.kind === 'delete').length,
  };
  return `Applied ${plan.changes.length} file changes atomically (${counts.add} added, ${counts.update} updated, ${counts.delete} deleted) in ${workspaceLabel}`;
}

function renderPlan(
  plan: PatchTransactionPlan,
  localWorkspaceRoot: string | undefined,
  workspaceLabel: string
): string {
  const markers = { add: 'A', update: 'M', delete: 'D' } as const;
  return [
    summarizePlan(plan, workspaceLabel),
    ...plan.changes.map(
      (change) =>
        `${markers[change.kind]} ${
          localWorkspaceRoot
            ? path.relative(localWorkspaceRoot, change.path)
            : change.path
        }`
    ),
  ].join('\n');
}

function failure(
  message: string,
  type: ToolErrorType = ToolErrorType.EXECUTION_ERROR,
  metadata?: Partial<ApplyPatchMetadata>
): ToolResult {
  const summary =
    metadata?.sideEffectsUncertain === true
      ? 'ApplyPatch failed; final remote state is uncertain, re-read affected files before retrying'
      : 'ApplyPatch failed; no partial patch was accepted';
  const llmContent =
    metadata?.requiresRead === true
      ? 'Remote file state is uncertain for this path. Use Read on the same file to refresh remote state before retrying ApplyPatch.'
      : message;
  return {
    success: false,
    llmContent,
    error: { type, message },
    metadata: {
      summary,
      ...metadata,
    },
  };
}

function remotePatchValidationFailure(
  reason?: AcpRemotePatchValidationError['reason'] | AcpRemotePathError['reason']
): ToolResult {
  const message = 'ACP remote patch is invalid';
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.VALIDATION_ERROR,
      code: 'acp_remote_patch_invalid',
      message,
      ...(reason === undefined ? {} : { details: { reason } }),
    },
    metadata: {
      summary: 'ApplyPatch failed; no partial patch was accepted',
      sideEffectsUncertain: false,
      write_acknowledged: false,
      write_verified: false,
    },
  };
}
