import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'bun-pty';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import {
  appendBoundedPtyEvidence,
  latchPtyEvidence,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { hasVisibleWeightedProviderRejection } from './weightedProviderAdmissionPtyDriver.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing weighted admission PTY setting: ${name}`);
  return value;
}

function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 50);
  });
}

async function waitForPendingByteSidecar(
  storageRoot: string,
  timeoutMs: number
): Promise<void> {
  const directory = path.join(storageRoot, 'agents', 'sessions');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await readdir(directory).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const serialized = await readFile(path.join(directory, file), 'utf8').catch(
        () => ''
      );
      try {
        const sidecar = JSON.parse(serialized) as {
          status?: unknown;
          result?: unknown;
        };
        if (
          sidecar.status === 'failed' &&
          JSON.stringify(sidecar.result).includes('pending_bytes')
        ) {
          return;
        }
      } catch {
        // The atomic writer may be between directory listing and rename.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Raw PTY child sidecar did not record pending-byte rejection');
}

async function waitForParentCompletion(
  workspace: string,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  const store = new PersistentStore(workspace);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await store.loadEvents(sessionId)) ?? [];
    const completionMessage = events.find(
      (event) =>
        event.type === 'message_created' &&
        event.data.inboxMessageId?.startsWith('background-subagent-completion:')
    );
    const completionInboxId =
      completionMessage?.type === 'message_created'
        ? completionMessage.data.inboxMessageId
        : undefined;
    const completionSeq = completionMessage?.seq;
    if (completionInboxId && typeof completionSeq === 'number') {
      const acknowledged = events.some(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes(completionInboxId)
      );
      const completed = events.some(
        (event) =>
          event.type === 'turn_completed' &&
          typeof event.seq === 'number' &&
          event.seq > completionSeq
      );
      if (acknowledged && completed) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Raw PTY parent did not durably consume the rejected child');
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_WEIGHTED_ADMISSION_PTY_CLI_ENTRY');
  const workspace = required('BLADE_WEIGHTED_ADMISSION_PTY_WORKSPACE');
  const storageRoot = required('BLADE_WEIGHTED_ADMISSION_PTY_STORAGE_ROOT');
  const sessionId = required('BLADE_WEIGHTED_ADMISSION_PTY_SESSION_ID');
  const secret = process.env.BLADE_WEIGHTED_ADMISSION_PTY_SECRET ?? '';
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const terminal = spawn(
    '/usr/bin/env',
    [
      'node',
      cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '8',
      '--resume',
      sessionId,
    ],
    {
      name: 'xterm-256color',
      cwd: workspace,
      cols: 120,
      rows: 40,
      env: childEnv,
    }
  );
  let output = '';
  let childFailureVisible = false;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
    childFailureVisible = latchPtyEvidence(
      childFailureVisible,
      hasVisibleWeightedProviderRejection(output)
    );
  });
  terminal.resize(121, 40);
  terminal.resize(120, 40);

  try {
    const evidenceDeadline = Date.now() + 180_000;
    await waitForPendingByteSidecar(
      storageRoot,
      Math.max(1, evidenceDeadline - Date.now())
    );
    await waitFor(
      () => childFailureVisible,
      'Raw PTY did not render the rejected background child',
      Math.max(1, evidenceDeadline - Date.now())
    );
    await waitForParentCompletion(
      workspace,
      sessionId,
      Math.max(1, evidenceDeadline - Date.now())
    );
    const projected = projectForegroundBoundedPtyOutput(
      secret ? output.replaceAll(secret, '[REDACTED]') : output
    );
    process.stdout.write(
      JSON.stringify({
        success: true,
        childFailureVisible,
        sidecarPendingByteFailure: true,
        output: projected,
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        output: projectForegroundBoundedPtyOutput(
          secret ? output.replaceAll(secret, '[REDACTED]') : output
        ),
      })
    );
    process.exitCode = 1;
  } finally {
    terminal.write('\u0004');
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    if (!exited) terminal.kill('SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!exited) terminal.kill('SIGKILL');
  }
}

if (import.meta.main) {
  await main();
}
