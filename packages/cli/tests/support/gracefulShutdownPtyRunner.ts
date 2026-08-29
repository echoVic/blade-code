import { readFile } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import { appendBoundedPtyEvidence } from './foregroundBoundedOutputPtyDriver.js';
import {
  createTuiPtyComposerReadyHandshake,
  writeBracketedPaste,
} from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  rootPidFile: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GRACEFUL_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GRACEFUL_PTY_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 50);
  });
}

function signalTerminalTree(
  pid: number,
  signal: NodeJS.Signals,
  fallback: () => void
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      fallback();
    } catch {
      // The terminal already exited.
    }
  }
}

function killFixtureProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The graceful shutdown path already reclaimed the fixture.
  }
}

async function waitForRootPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const value = Number.parseInt(await readFile(filePath, 'utf8'), 10);
      if (Number.isSafeInteger(value) && value > 1) {
        process.kill(value, 0);
        return value;
      }
    } catch {
      // The model has not launched the fixture yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for raw PTY foreground process');
}

async function main(): Promise<void> {
  const input = loadInput();
  const handshake = createTuiPtyComposerReadyHandshake({
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
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
      '--session-id',
      input.sessionId,
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 120,
      rows: 40,
      env: handshake.env,
    }
  );
  let output = '';
  let exited = false;
  let exitCode: number | undefined;
  let rootPid: number | undefined;
  let succeeded = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk, 64_000);
  });

  try {
    await Promise.race([
      waitFor(
        () => output.includes(handshake.marker),
        'Timed out waiting for TUI composer',
        60_000
      ),
      exitPromise.then(() => {
        throw new Error(`TUI exited before composer readiness (code ${exitCode})`);
      }),
    ]);
    await writeBracketedPaste(terminal, input.prompt);
    await Promise.race([
      waitFor(
        () => output.includes('PASTE:'),
        'Bracketed paste did not reach the TUI composer',
        10_000
      ),
      exitPromise.then(() => {
        throw new Error(`TUI exited before bracketed paste (code ${exitCode})`);
      }),
    ]);
    terminal.write('\r');
    rootPid = await waitForRootPid(input.rootPidFile);
    const commandStartedAt = Date.now();
    process.kill(terminal.pid, 'SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TUI did not exit after SIGTERM')), 15_000)
      ),
    ]);
    if (exitCode !== 0) throw new Error(`TUI graceful exit code was ${exitCode}`);
    if (output.includes(input.secret)) {
      throw new Error('Raw PTY shutdown capture contained provider credentials');
    }
    succeeded = true;
    process.stdout.write(
      JSON.stringify({
        success: true,
        sessionId: input.sessionId,
        output,
        rootPid,
        commandStartedAt,
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
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (!succeeded) killFixtureProcess(rootPid);
  }
}

if (import.meta.main) {
  await main();
}
