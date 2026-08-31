import { access } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`Missing required Goal finalization PTY setting: ${name}`);
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
  throw new Error('TUI Goal finalization did not acknowledge its durable inbox');
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_GOAL_FINALIZATION_PTY_CLI_ENTRY');
  const workspace = required('BLADE_GOAL_FINALIZATION_PTY_WORKSPACE');
  const sessionId = required('BLADE_GOAL_FINALIZATION_PTY_SESSION_ID');
  const expectedInitial = required('BLADE_GOAL_FINALIZATION_PTY_INITIAL');
  const followupPrompt = required('BLADE_GOAL_FINALIZATION_PTY_FOLLOWUP_PROMPT');
  const expectedFollowup = required('BLADE_GOAL_FINALIZATION_PTY_FOLLOWUP');
  const secret = process.env.BLADE_GOAL_FINALIZATION_PTY_SECRET ?? '';
  const handshake = createTuiPtyComposerReadyHandshake();
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
      env: handshake.env,
    }
  );
  let output = '';
  let sawInitial = false;
  let sawCompleteGoal = false;
  let sawFollowup = false;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
    sawInitial = latchPtyMarker(sawInitial, output, expectedInitial);
    sawCompleteGoal = latchPtyMarker(sawCompleteGoal, output, 'goal:complete');
    sawFollowup = latchPtyMarker(sawFollowup, output, expectedFollowup);
  });

  try {
    await waitFor(
      () => sawInitial && sawCompleteGoal && output.includes(handshake.marker),
      'Timed out waiting for recovered Goal finalization in TUI',
      60_000
    );
    await waitForInboxRemoval(workspace, sessionId, 10_000);
    await writeBracketedPaste(terminal, followupPrompt);
    await waitFor(
      () => output.includes(followupPrompt.slice(0, 24)),
      'Goal follow-up did not reach the TUI composer',
      10_000
    );
    terminal.write('\r');
    await waitFor(
      () => sawFollowup,
      'Timed out waiting for the real Provider Goal follow-up',
      270_000
    );
    await waitForInboxRemoval(workspace, sessionId, 10_000);
    terminal.resize(100, 36);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawInitial,
        sawCompleteGoal,
        sawFollowup,
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
