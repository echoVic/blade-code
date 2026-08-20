import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'bun-pty';
import { appendBoundedPtyEvidence } from './foregroundBoundedOutputPtyDriver.js';
import {
  driveToolAdmissionFixture,
  TOOL_ADMISSION_CALL_IDS,
  waitForToolAdmissionSessionCompletion,
} from './toolAdmissionFixtureDriver.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  stateDir: string;
  sessionId: string;
  prompt: string;
  marker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TOOL_ADMISSION_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_TOOL_ADMISSION_PTY_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
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

async function releaseAll(stateDir: string): Promise<void> {
  const releaseDir = path.join(stateDir, 'release');
  await mkdir(releaseDir, { recursive: true });
  await Promise.all(
    TOOL_ADMISSION_CALL_IDS.map((callId) =>
      writeFile(path.join(releaseDir, callId), 'release')
    )
  );
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
      '4',
      '--session-id',
      input.sessionId,
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
    output = appendBoundedPtyEvidence(output, chunk, 128_000);
  });

  try {
    await waitFor(
      () => output.includes('请输入您的问题'),
      'Timed out waiting for TUI composer',
      30_000
    );
    terminal.write(`\u001B[200~${input.prompt}\u001B[201~`);
    await waitFor(
      () => output.includes('PASTE:'),
      'Bracketed paste did not reach the TUI composer',
      10_000
    );
    terminal.write('\r');

    await driveToolAdmissionFixture({
      storageRoot: input.storageRoot,
      sessionId: input.sessionId,
      stateDir: input.stateDir,
      waitForQueuedEvidence: () =>
        waitFor(
          () => countOccurrences(output, 'Waiting for tool execution capacity') >= 2,
          'Raw PTY did not project two queued tool calls'
        ),
    });
    await waitForToolAdmissionSessionCompletion(input.storageRoot, input.sessionId);
    await waitFor(
      () => output.includes(input.marker),
      'Raw PTY did not render the final admission marker'
    );
    if (output.includes(input.secret)) {
      throw new Error('Raw PTY admission capture contained provider credentials');
    }

    process.kill(terminal.pid, 'SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TUI did not exit after SIGTERM')), 15_000)
      ),
    ]);
    if (exitCode !== 0) throw new Error(`TUI graceful exit code was ${exitCode}`);
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
    await releaseAll(input.stateDir).catch(() => undefined);
    if (!exited) terminal.kill('SIGKILL');
  }
}

if (import.meta.main) {
  await main();
}
