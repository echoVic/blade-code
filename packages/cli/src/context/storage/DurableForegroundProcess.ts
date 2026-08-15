import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  finalizeCommandAdmissionGate,
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
  handoff(
    registerNextOwner: (rootPid: number) => void,
    rollbackNextOwner: () => void
  ): void;
  finalize(): Promise<void>;
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

  let releasePromise: Promise<void> | undefined;
  let finalizePromise: Promise<void> | undefined;
  let handedOff = false;

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
    handoff(registerNextOwner, rollbackNextOwner) {
      if (handedOff) return;
      if (finalizePromise) {
        throw new Error('Cannot hand off a finalized foreground command');
      }
      registerNextOwner(child.pid as number);
      try {
        leaseStore?.remove(processId);
        handedOff = true;
      } catch (error) {
        rollbackNextOwner();
        throw error;
      }
    },
    finalize() {
      finalizePromise ??= (async () => {
        const result = await finalizeCommandAdmissionGate(child, processTree);
        if (!result.success) {
          throw new Error('Failed to finalize foreground command process group');
        }
        if (!handedOff) leaseStore?.remove(processId);
      })();
      return finalizePromise;
    },
  };
}
