import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  releaseCommandAdmissionGate,
  spawnCommandAdmissionGate,
} from '../../utils/process/CommandAdmissionGate.js';
import type { OwnedProcessTree } from '../../utils/process/OwnedProcessTree.js';
import { ForegroundProcessLeaseStore } from './ForegroundProcessLeaseStore.js';

export interface ForegroundProcessOwnership {
  sessionId: string;
  projectPath: string;
}

export interface PreparedForegroundProcess {
  child: ChildProcess;
  processTree: OwnedProcessTree;
  processId: string;
  release(): Promise<void>;
}

export async function prepareForegroundProcess(
  executable: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  ownership?: ForegroundProcessOwnership
): Promise<PreparedForegroundProcess> {
  const processId = `foreground_${randomUUID()}`;
  const { child, processTree } = spawnCommandAdmissionGate(
    executable,
    args,
    spawnOptions
  );
  if (!child.pid) {
    await processTree.terminate();
    throw new Error('Foreground command gate did not expose a PID');
  }

  const leaseStore = ownership
    ? new ForegroundProcessLeaseStore(ownership.projectPath, ownership.sessionId)
    : undefined;
  try {
    leaseStore?.register(processId, child.pid);
  } catch (error) {
    await processTree.terminate();
    throw error;
  }

  const removeLease = () => leaseStore?.remove(processId);
  child.once('close', removeLease);
  child.once('error', removeLease);
  let releasePromise: Promise<void> | undefined;

  return {
    child,
    processTree,
    processId,
    release() {
      releasePromise ??= releaseCommandAdmissionGate(child).catch((error) => {
        void processTree.terminate();
        throw new Error('Failed to release durable foreground command gate', {
          cause: error,
        });
      });
      return releasePromise;
    },
  };
}
