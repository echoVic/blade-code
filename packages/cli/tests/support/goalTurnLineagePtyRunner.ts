import { spawn } from 'bun-pty';
import { GoalStore } from '../../src/goals/GoalStore.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GOAL_TURN_LINEAGE_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GOAL_TURN_LINEAGE_PTY_INPUT');
  delete process.env.BLADE_GOAL_TURN_LINEAGE_PTY_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function signalTree(pid: number, signal: NodeJS.Signals, fallback: () => void): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      fallback();
    } catch {
      // The PTY already exited.
    }
  }
}

async function main(): Promise<void> {
  const input = loadInput();
  process.env.BLADE_STORAGE_ROOT = input.storageRoot;
  const handshake = createTuiPtyComposerReadyHandshake({
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_VERSION: '999.0.0',
    BLADE_API_KEY: input.secret,
    TERM: 'xterm-256color',
  });
  const terminal = spawn(
    '/usr/bin/env',
    [
      'node',
      input.cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '3',
      '--resume',
      input.sessionId,
      '--allowed-tools',
      'Bash,Read,UpdateGoal',
      '--no-verification-agent',
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 160,
      rows: 48,
      env: handshake.env,
    }
  );
  let output = '';
  let exited = false;
  let exitCode: number | undefined;
  let blocked = false;
  let fullLineage = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk, 256_000);
    blocked = latchPtyMarker(blocked, output, 'goal:blocked');
  });

  try {
    await waitFor(
      () => output.includes(handshake.marker),
      'Goal turn lineage TUI composer did not become ready',
      220_000
    );
    await waitFor(
      () => blocked,
      'Goal turn lineage TUI did not reach blocked state',
      220_000
    );
    const goal = await new GoalStore(input.workspace, input.sessionId).get();
    if (!goal?.turnLineage) throw new Error('Goal turn lineage did not persist');
    await writeBracketedPaste(terminal, '/goal status');
    await waitFor(
      () => output.includes('/goal status'),
      'Goal status command did not reach the TUI composer',
      220_000
    );
    terminal.write('\r');
    const expected = [
      `Origin turn: ${goal.turnLineage.rootTurnId ?? '?'}`,
      `Current turn: ${goal.turnLineage.currentTurnId}`,
      `Parent turn: ${goal.turnLineage.parentTurnId ?? '?'}`,
    ];
    await waitFor(
      () => {
        const visible = projectForegroundBoundedPtyOutput(output);
        fullLineage = expected.every((marker) => visible.includes(marker));
        return fullLineage;
      },
      'Goal turn lineage TUI did not render full status ancestry',
      220_000
    );
    if (output.includes(input.secret)) {
      throw new Error('Goal turn lineage TUI leaked a credential');
    }
    signalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
    await waitForPtyExit(exitPromise, 'Goal turn lineage TUI did not exit');
    if (exitCode !== 0) throw new Error(`Goal turn lineage TUI exited ${exitCode}`);
    process.stdout.write(
      JSON.stringify({
        success: true,
        blocked,
        fullLineage,
        lineage: goal.turnLineage,
        output: projectForegroundBoundedPtyOutput(output).replaceAll(
          input.secret,
          '[redacted]'
        ),
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[redacted]'
        ),
        output: projectForegroundBoundedPtyOutput(output).replaceAll(
          input.secret,
          '[redacted]'
        ),
      })
    );
    process.exitCode = 1;
  } finally {
    if (!exited) {
      signalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await waitForPtyExit(
        exitPromise,
        'Goal turn lineage TUI cleanup timed out',
        2_000
      ).catch(() => undefined);
    }
    if (!exited) signalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
  }
}

if (import.meta.main) await main();
