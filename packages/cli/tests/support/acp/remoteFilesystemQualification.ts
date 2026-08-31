import { createHash } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { type BladeConfig, PermissionMode } from '../../../src/config/types.js';

export type RemoteFilesystemCleanupPhase =
  | 'agent_destroy'
  | 'client_to_agent_close'
  | 'agent_to_client_close'
  | 'client_connection_closed'
  | 'agent_connection_closed';

export interface CleanupOperation {
  phase: RemoteFilesystemCleanupPhase;
  run(): void | Promise<void>;
  timeoutMessage: string;
}

export interface RemainingDeadlineOptions {
  deadlineAt: number;
  timeoutMessage: string;
}

export interface CleanupRunnerOptions {
  deadlineAt: number;
  bodyError?: unknown;
  operations: readonly CleanupOperation[];
}

export interface QualificationRequestRecord {
  kind: 'read' | 'write';
  path: string;
}

export type CanonicalRemoteFilesystemRequestMethod =
  | typeof acp.CLIENT_METHODS.fs_read_text_file
  | typeof acp.CLIENT_METHODS.fs_write_text_file;

export interface CanonicalRemoteFilesystemQualificationEvidence {
  qualificationId: string;
  frameworkRetryBudget: number;
  requestSequence: string[];
  requestMethodOrder: CanonicalRemoteFilesystemRequestMethod[];
  requestPathIdentities: string[];
  writeResultCount: number;
  hostSourcePreserved: boolean;
  hostOutputParentAbsent: boolean;
  outputContainsFinalMarker: boolean;
  outputExcludesHostCanary: boolean;
}

export class AcpCleanupError extends Error {
  constructor(
    readonly phase: RemoteFilesystemCleanupPhase,
    readonly cause: unknown
  ) {
    super(`ACP cleanup failed during ${phase}`, { cause });
    this.name = 'AcpCleanupError';
  }
}

export function isBenignPairedAcpWriterCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    (error.name === 'TypeError' &&
      message === 'Invalid state: WritableStream is closed') ||
    (message === 'WritableStream is closed' &&
      ('code' in error ? error.code === 'ERR_INVALID_STATE' : false))
  );
}

function classifyEvidencePath(
  candidatePath: string,
  input: { sourcePath: string; outputPath: string }
): 'source' | 'output' | 'other' {
  if (candidatePath === input.sourcePath) return 'source';
  if (candidatePath === input.outputPath) return 'output';
  return 'other';
}

function requestMethodForKind(
  kind: QualificationRequestRecord['kind']
): CanonicalRemoteFilesystemRequestMethod {
  return kind === 'read'
    ? acp.CLIENT_METHODS.fs_read_text_file
    : acp.CLIENT_METHODS.fs_write_text_file;
}

function stablePathRoleIdentity(input: {
  classifiedPath: 'source' | 'output' | 'other';
}): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        role: input.classifiedPath,
      })
    )
    .digest('hex')}`;
}

export function buildRemoteFilesystemQualificationRuntimeConfig(
  base: BladeConfig
): BladeConfig {
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpServers: {},
    models: base.models.map((entry) => ({
      ...entry,
      overrides: { ...entry.overrides, maxRetries: 0 },
    })),
  };
}

export async function withRemainingDeadline<T>(
  operation: () => Promise<T>,
  options: RemainingDeadlineOptions
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        const remaining = Math.max(1, options.deadlineAt - Date.now());
        timer = setTimeout(() => reject(new Error(options.timeoutMessage)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runRemoteFilesystemQualificationCleanup(
  options: CleanupRunnerOptions
): Promise<void> {
  const failures: unknown[] = [];
  if (options.bodyError !== undefined) failures.push(options.bodyError);

  for (const operation of options.operations) {
    try {
      await withRemainingDeadline(
        async () => {
          await operation.run();
        },
        {
          deadlineAt: options.deadlineAt,
          timeoutMessage: operation.timeoutMessage,
        }
      );
    } catch (error) {
      failures.push(new AcpCleanupError(operation.phase, error));
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'ACP remote filesystem qualification failed');
  }
}

export function buildCanonicalRemoteFilesystemQualificationEvidence(input: {
  qualificationId: string;
  frameworkRetryBudget: number;
  sourcePath: string;
  outputPath: string;
  requests: readonly QualificationRequestRecord[];
  writeResultCount: number;
  hostSourcePreserved: boolean;
  hostOutputParentAbsent: boolean;
  outputContainsFinalMarker: boolean;
  outputExcludesHostCanary: boolean;
}): CanonicalRemoteFilesystemQualificationEvidence {
  return {
    qualificationId: input.qualificationId,
    frameworkRetryBudget: input.frameworkRetryBudget,
    requestSequence: input.requests.map((request) => {
      const label = classifyEvidencePath(request.path, input);
      return `${request.kind}:${label}`;
    }),
    requestMethodOrder: input.requests.map((request) =>
      requestMethodForKind(request.kind)
    ),
    requestPathIdentities: input.requests.map((request) =>
      stablePathRoleIdentity({
        classifiedPath: classifyEvidencePath(request.path, input),
      })
    ),
    writeResultCount: input.writeResultCount,
    hostSourcePreserved: input.hostSourcePreserved,
    hostOutputParentAbsent: input.hostOutputParentAbsent,
    outputContainsFinalMarker: input.outputContainsFinalMarker,
    outputExcludesHostCanary: input.outputExcludesHostCanary,
  };
}

export function digestCanonicalRemoteFilesystemQualificationEvidence(
  evidence: CanonicalRemoteFilesystemQualificationEvidence
): string {
  const canonical = {
    frameworkRetryBudget: evidence.frameworkRetryBudget,
    hostOutputParentAbsent: evidence.hostOutputParentAbsent,
    hostSourcePreserved: evidence.hostSourcePreserved,
    outputContainsFinalMarker: evidence.outputContainsFinalMarker,
    outputExcludesHostCanary: evidence.outputExcludesHostCanary,
    qualificationId: evidence.qualificationId,
    requestMethodOrder: [...evidence.requestMethodOrder],
    requestPathIdentities: [...evidence.requestPathIdentities],
    requestSequence: [...evidence.requestSequence],
    writeResultCount: evidence.writeResultCount,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
