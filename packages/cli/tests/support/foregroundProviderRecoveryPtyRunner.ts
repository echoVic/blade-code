import { readFile } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT;
  if (!encoded) {
    throw new Error('Missing BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT');
  }
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
      '8',
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Read,Edit,Bash',
      '--no-verification-agent',
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
    output = `${output}${chunk}`.slice(-256_000);
  });

  try {
    await Promise.race([
      waitFor(
        () => output.includes('请输入您的问题'),
        'Timed out waiting for Provider recovery TUI composer',
        60_000
      ),
      exitPromise.then(() => {
        throw new Error(`Provider recovery TUI exited before composer (${exitCode})`);
      }),
    ]);
    terminal.write(`\u001B[200~${input.prompt}\u001B[201~`);
    await waitFor(
      () => output.includes('PASTE:'),
      'Provider recovery bracketed paste did not reach TUI',
      10_000
    );
    terminal.write('\r');

    await waitFor(
      () =>
        output.includes('Provider 故障已隔离，等待恢复探测') &&
        output.includes('Provider 正在执行唯一恢复探测'),
      'Raw PTY did not render shared Provider circuit recovery',
      60_000
    );
    const recoveryBoundary = output.length;
    let transcript = '';
    await waitFor(
      async () => {
        try {
          transcript = await readFile(
            findSessionTranscript(input.storageRoot, input.sessionId),
            'utf8'
          );
          return (
            transcript.includes(input.marker) &&
            transcript.includes('"type":"turn_completed"')
          );
        } catch {
          return false;
        }
      },
      'Raw PTY did not durably complete the Provider recovery turn',
      180_000
    );
    await waitFor(
      () => output.slice(recoveryBoundary).includes(input.marker),
      'Raw PTY did not render Provider recovery completion marker',
      30_000
    );
    if (output.includes(input.secret) || transcript.includes(input.secret)) {
      throw new Error('Raw PTY Provider recovery capture contained credentials');
    }

    process.kill(terminal.pid, 'SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Provider recovery TUI did not exit after SIGTERM')),
          15_000
        )
      ),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Provider recovery TUI exit code was ${exitCode}`);
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        sessionId: input.sessionId,
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
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
    }
  }
}

if (import.meta.main) {
  await main();
}
