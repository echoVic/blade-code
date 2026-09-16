import { spawn } from 'bun-pty';
import { waitForCondition as waitFor, waitForInboxRemoval } from './asyncTestUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment } from './ptyInput.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required adoption PTY setting: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_SUBAGENT_ADOPTION_PTY_CLI_ENTRY');
  const workspace = required('BLADE_SUBAGENT_ADOPTION_PTY_WORKSPACE');
  const sessionId = required('BLADE_SUBAGENT_ADOPTION_PTY_SESSION_ID');
  const childMarker = required('BLADE_SUBAGENT_ADOPTION_PTY_CHILD_MARKER');
  const parentResponse = required('BLADE_SUBAGENT_ADOPTION_PTY_PARENT_RESPONSE');
  const secret = process.env.BLADE_SUBAGENT_ADOPTION_PTY_SECRET ?? '';
  const childEnv = createTuiPtyEnvironment();
  const terminal = spawn(
    '/usr/bin/env',
    [
      'node',
      cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '3',
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
  let sawChild = false;
  let sawParent = false;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
    sawChild = latchPtyMarker(sawChild, output, childMarker);
    sawParent = latchPtyMarker(sawParent, output, parentResponse);
  });

  try {
    await waitFor(
      () => sawChild && sawParent,
      'Timed out waiting for adopted child and resumed parent in TUI',
      270_000
    );
    await waitForInboxRemoval(workspace, sessionId, 10_000);
    terminal.resize(100, 36);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawChild,
        sawParent,
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
