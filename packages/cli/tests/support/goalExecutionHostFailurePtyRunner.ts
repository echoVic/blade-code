import { spawn } from 'bun-pty';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import {
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GOAL_HOST_FAILURE_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GOAL_HOST_FAILURE_PTY_INPUT');
  delete process.env.BLADE_GOAL_HOST_FAILURE_PTY_INPUT;
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
      '4',
      '--resume',
      input.sessionId,
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 150,
      rows: 48,
      env: handshake.env,
    }
  );
  let output = '';
  let exited = false;
  let exitCode: number | undefined;
  let sawFirst = false;
  let sawSecond = false;
  let blocked = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk, 256_000);
    const visible = projectForegroundBoundedPtyOutput(output);
    sawFirst ||= visible.includes('exec-host:timeout:1');
    sawSecond ||= visible.includes('exec-host:timeout:2');
    blocked ||=
      visible.includes('goal:blocked') && visible.includes('exec-host:timeout:3');
  });

  try {
    await waitFor(
      () => output.includes(handshake.marker),
      'Goal host failure TUI composer did not become ready'
    );
    await waitFor(
      () => sawFirst && sawSecond && blocked,
      'Goal host failure TUI did not render its durable streak',
      30_000
    );
    if (output.includes(input.secret)) {
      throw new Error('Goal host failure TUI leaked a credential');
    }
    signalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
    await waitForPtyExit(exitPromise, 'Goal host failure TUI did not exit');
    if (exitCode !== 0) {
      throw new Error(`Goal host failure TUI exited ${exitCode}`);
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawFirst,
        sawSecond,
        blocked,
        output: projectForegroundBoundedPtyOutput(output),
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
        'Goal host failure TUI cleanup timed out',
        2_000
      ).catch(() => undefined);
    }
    if (!exited) signalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
  }
}

if (import.meta.main) await main();
