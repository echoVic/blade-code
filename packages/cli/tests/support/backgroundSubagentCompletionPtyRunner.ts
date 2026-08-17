import { access } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing background completion PTY setting: ${name}`);
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

async function waitForInboxRemoval(
  workspace: string,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  const inboxPath = getSessionInboxFilePath(workspace, sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(inboxPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('TUI background completion was not durably acknowledged');
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_BACKGROUND_COMPLETION_PTY_CLI_ENTRY');
  const workspace = required('BLADE_BACKGROUND_COMPLETION_PTY_WORKSPACE');
  const sessionId = required('BLADE_BACKGROUND_COMPLETION_PTY_SESSION_ID');
  const childMarker = required('BLADE_BACKGROUND_COMPLETION_PTY_CHILD_MARKER');
  const secret = process.env.BLADE_BACKGROUND_COMPLETION_PTY_SECRET ?? '';
  const expectedParent = `BACKGROUND_PARENT_FINAL:${childMarker}`;
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
  let sawProviderAdmission = false;
  let sawChildMarker = false;
  let sawParentFinal = false;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
    sawProviderAdmission = latchPtyMarker(
      sawProviderAdmission,
      output,
      '等待 Provider 容量'
    );
    sawChildMarker = latchPtyMarker(sawChildMarker, output, childMarker);
    sawParentFinal = latchPtyMarker(sawParentFinal, output, expectedParent);
  });

  try {
    await waitFor(
      () => sawProviderAdmission,
      'Raw PTY did not render Provider admission queue',
      60_000
    );
    await waitFor(
      () => sawChildMarker && sawParentFinal,
      'Timed out waiting for child marker and resumed parent in TUI',
      180_000
    );
    await waitForInboxRemoval(workspace, sessionId, 10_000);
    terminal.resize(100, 36);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawProviderAdmission,
        sawChildMarker,
        sawParentFinal,
        output: projectForegroundBoundedPtyOutput(
          secret ? output.replaceAll(secret, '[REDACTED]') : output
        ),
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
