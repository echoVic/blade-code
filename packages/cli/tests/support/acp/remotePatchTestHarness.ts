import { ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS } from '../../../src/acp/AcpFileRequestCoordinator.js';
import { AcpFileSystemService } from '../../../src/acp/AcpFileSystemService.js';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
import { parseApplyPatch } from '../../../src/tools/builtin/file/applyPatchParser.js';
import {
  type AcpRemotePatchPreflight,
  commitRemotePatchTransaction,
  planRemotePatchTransaction,
  preflightRemotePatchTransaction,
} from '../../../src/tools/builtin/file/applyPatchTransaction.js';
import { ControlledFileClient } from './ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from './createPairedAcpHarness.js';

export interface PreparedRemotePatchTransactionForTest {
  plan: Awaited<ReturnType<typeof planRemotePatchTransaction>>;
  preflight: AcpRemotePatchPreflight;
  forwardDeadlineAt: number;
  lease: ReturnType<AcpFileSystemService['tryAcquireMutationLeaseForParsedPaths']>;
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
    service: new AcpFileSystemService(
      harness.agentConnection,
      sessionId,
      {
        readTextFile: true,
        writeTextFile: true,
      },
      createAcpRemotePathProfile('/remote')
    ),
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
  const preflight = preflightRemotePatchTransaction(
    operations,
    service.getPathProfile()
  );
  const targetPaths = preflight.entries
    .flatMap((entry) =>
      entry.destination ? [entry.source, entry.destination] : [entry.source]
    )
    .sort((left, right) =>
      left.collisionIdentity.localeCompare(right.collisionIdentity)
    );
  const lease = service.tryAcquireMutationLeaseForParsedPaths(targetPaths);
  try {
    const plan = await planRemotePatchTransaction(operations, workspaceRoot, service, {
      signal: options?.signal,
      deadlineAt: forwardDeadlineAt,
      lease,
      preflight,
    });
    return {
      plan,
      preflight,
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
