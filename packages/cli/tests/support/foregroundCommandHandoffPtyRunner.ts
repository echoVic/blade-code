import { spawn } from 'bun-pty';
import {
  appendBoundedPtyEvidence,
  ArmedPtyMarkerLatch,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import {
  driveForegroundCommandHandoffFixture,
  type ForegroundCommandHandoffFixture,
  releaseForegroundCommandHandoffFixture,
} from './foregroundCommandHandoffFixtureDriver.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  fixture: ForegroundCommandHandoffFixture;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOREGROUND_HANDOFF_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_FOREGROUND_HANDOFF_PTY_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 90_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  const input = loadInput();
  if (input.fixture.prompt.includes(input.fixture.marker)) {
    throw new Error('Foreground handoff final marker contaminated the prompt');
  }
  const finalMarkerLatch = new ArmedPtyMarkerLatch(input.fixture.marker);
  const secretLatch = new ArmedPtyMarkerLatch(input.secret);
  secretLatch.arm();
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const terminal = spawn(
    '/usr/bin/env',
    [
      'node',
      input.cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '6',
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Bash,Read,TaskOutput',
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 140,
      rows: 48,
      env,
    }
  );
  let output = '';
  let exited = false;
  let exitCode: number | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    finalMarkerLatch.observe(chunk);
    secretLatch.observe(chunk);
    output = appendBoundedPtyEvidence(output, chunk, 128_000);
  });

  try {
    await waitFor(
      () => output.includes('请输入您的问题'),
      'Timed out waiting for TUI handoff composer',
      30_000
    );
    terminal.write(`\u001B[200~${input.fixture.prompt}\u001B[201~`);
    await waitFor(
      () => output.includes('PASTE:'),
      'Foreground handoff bracketed paste did not reach TUI',
      10_000
    );
    finalMarkerLatch.arm();
    terminal.write('\r');

    await driveForegroundCommandHandoffFixture({
      storageRoot: input.storageRoot,
      sessionId: input.sessionId,
      fixture: input.fixture,
      waitForSurfaceHandoff: async (shellId) => {
        await waitFor(
          () => output.includes(shellId) && output.toLowerCase().includes('background'),
          'Raw PTY did not render foreground handoff result'
        );
      },
    });
    await waitFor(
      () => finalMarkerLatch.seen,
      'Raw PTY did not render foreground handoff marker'
    );
    if (secretLatch.seen) {
      throw new Error('Raw PTY handoff capture contained provider credentials');
    }

    process.kill(terminal.pid, 'SIGTERM');
    await waitForPtyExit(exitPromise, 'TUI handoff runner did not exit after SIGTERM');
    if (exitCode !== 0) {
      throw new Error(`TUI handoff graceful exit code was ${exitCode}`);
    }
    if (secretLatch.seen) {
      throw new Error('Raw PTY handoff capture contained provider credentials');
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        sessionId: input.sessionId,
        finalMarkerSeen: finalMarkerLatch.seen,
        secretSeen: secretLatch.seen,
        output,
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
        output: output.replaceAll(input.secret, '[redacted]'),
      })
    );
    process.exitCode = 1;
  } finally {
    await releaseForegroundCommandHandoffFixture(input.fixture).catch(() => undefined);
    if (!exited) terminal.kill('SIGKILL');
  }
}

if (import.meta.main) {
  await main();
}
