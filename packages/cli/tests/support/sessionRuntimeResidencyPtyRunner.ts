import { readFile } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import {
  captureProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../src/utils/process/ProcessIdentity.js';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  resultPath: string;
  secret: string;
}

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_SESSION_RESIDENCY_PTY_INPUT;
  if (!encoded) {
    throw new Error('Missing BLADE_SESSION_RESIDENCY_PTY_INPUT');
  }
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function signalTerminalTree(terminal: PtyProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-terminal.pid, signal);
  } catch {
    try {
      terminal.kill(signal);
    } catch {
      // The PTY process already exited.
    }
  }
}

async function main(): Promise<void> {
  const input = loadInput();
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
      'Read,Write',
      '--no-verification-agent',
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 140,
      rows: 48,
      env,
    }
  ) as PtyProcess;
  const identity = captureProcessIdentity(terminal.pid) ?? undefined;
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
    output = `${output}${chunk}`.slice(-256_000);
  });

  try {
    await Promise.race([
      waitFor(
        () => output.includes('请输入您的问题'),
        'Timed out waiting for Session residency TUI composer',
        60_000
      ),
      exitPromise.then(() => {
        throw new Error(`Session residency TUI exited before composer (${exitCode})`);
      }),
    ]);
    terminal.write(`\u001B[200~${input.prompt}\u001B[201~`);
    await waitFor(
      () => output.includes(input.marker),
      'Session residency bracketed paste did not reach TUI',
      10_000
    );
    terminal.write('\r');

    let transcript = '';
    await waitFor(
      async () => {
        try {
          const [result] = await Promise.all([
            readFile(input.resultPath, 'utf8'),
            (async () => {
              transcript = await readFile(
                findSessionTranscript(input.storageRoot, input.sessionId),
                'utf8'
              );
            })(),
          ]);
          return (
            result.trim() === input.marker &&
            transcript.includes('"type":"turn_completed"')
          );
        } catch {
          return false;
        }
      },
      'Raw PTY did not complete the Session residency coding control',
      270_000
    );
    terminal.resize(100, 36);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (
      output.includes('Session runtime capacity is full') ||
      output.includes('resident_runtimes') ||
      transcript.includes('Session runtime capacity is full') ||
      transcript.includes('resident_runtimes')
    ) {
      throw new Error('Raw PTY single-Runtime control reported residency capacity');
    }
    if (output.includes(input.secret) || transcript.includes(input.secret)) {
      throw new Error('Raw PTY Session residency capture contained credentials');
    }

    signalTerminalTree(terminal, 'SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Session residency TUI did not exit after SIGTERM')),
          15_000
        )
      ),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Session residency TUI exit code was ${exitCode}`);
    }
    if (identity && processIdentityMatches(terminal.pid, identity)) {
      throw new Error('Session residency TUI process remained alive after exit');
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        output,
        pid: terminal.pid,
        identity,
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
        pid: terminal.pid,
        identity,
      })
    );
    process.exitCode = 1;
  } finally {
    if (!exited) {
      signalTerminalTree(terminal, 'SIGTERM');
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (!exited) {
      signalTerminalTree(terminal, 'SIGKILL');
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
}

if (import.meta.main) {
  await main();
}
