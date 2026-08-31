import path from 'node:path';
import { ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS } from '../../../src/acp/AcpFileRequestCoordinator.js';
import { AcpFileSystemService } from '../../../src/acp/AcpFileSystemService.js';
import { parseApplyPatch } from '../../../src/tools/builtin/file/applyPatchParser.js';
import {
  commitRemotePatchTransaction,
  planRemotePatchTransaction,
} from '../../../src/tools/builtin/file/applyPatchTransaction.js';
import { ControlledFileClient } from './ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from './createPairedAcpHarness.js';

export interface PreparedRemotePatchTransactionForTest {
  plan: Awaited<ReturnType<typeof planRemotePatchTransaction>>;
  forwardDeadlineAt: number;
  lease: ReturnType<AcpFileSystemService['tryAcquireMutationLease']>;
}

export function createAcpRemoteFileSystemForPatchTest(
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
  return {
    client,
    harness,
    service: new AcpFileSystemService(harness.agentConnection, sessionId, {
      readTextFile: true,
      writeTextFile: true,
    }),
  };
}

export async function prepareRemotePatchTransactionForTest(
  operations: ReturnType<typeof parseApplyPatch>,
  workspaceRoot: string,
  service: AcpFileSystemService,
  options?: {
    signal?: AbortSignal;
    forwardDeadlineAt?: number;
  }
): Promise<PreparedRemotePatchTransactionForTest> {
  const forwardDeadlineAt =
    options?.forwardDeadlineAt ?? Date.now() + ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS;
  const targetPaths = operations
    .filter((operation) => operation.kind === 'update')
    .map((operation) => path.posix.resolve(workspaceRoot, ...operation.path.split('/')))
    .sort((left, right) => left.localeCompare(right));
  const lease = service.tryAcquireMutationLease(targetPaths);
  try {
    const plan = await planRemotePatchTransaction(operations, workspaceRoot, service, {
      signal: options?.signal,
      deadlineAt: forwardDeadlineAt,
      lease,
    });
    return {
      plan,
      forwardDeadlineAt,
      lease,
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

export async function commitPreparedRemotePatchTransactionForTest(
  prepared: PreparedRemotePatchTransactionForTest,
  service: AcpFileSystemService,
  options?: {
    signal?: AbortSignal;
  }
): Promise<void> {
  try {
    await commitRemotePatchTransaction(prepared.plan, service, {
      signal: options?.signal,
      forwardDeadlineAt: prepared.forwardDeadlineAt,
      lease: prepared.lease,
    });
    prepared.lease.commitVerified();
  } finally {
    prepared.lease.release();
  }
}

export async function flushAsyncSteps(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export async function waitForMicrotaskCondition(
  check: () => boolean,
  attempts = 50
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) {
      return;
    }
    await flushAsyncSteps();
  }
  throw new Error('condition not reached before microtask retry budget expired');
}
