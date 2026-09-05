import { access } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import {
  ArmedPtyMarkerLatch,
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  memoryDir: string;
  sessionId: string;
  historyReady: string;
  prompt: string;
  marker: string;
  discoveryPrompt: string;
  discoveryMarker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_MEMORY_CONSOLIDATION_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_MEMORY_CONSOLIDATION_PTY_INPUT');
  delete process.env.BLADE_MEMORY_CONSOLIDATION_PTY_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 90_000
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
      // The PTY process already exited.
    }
  }
}

async function main(): Promise<void> {
  const input = loadInput();
  const finalMarker = new ArmedPtyMarkerLatch(input.marker);
  const discoveryMarker = new ArmedPtyMarkerLatch(input.discoveryMarker);
  const secret = new ArmedPtyMarkerLatch(input.secret);
  secret.arm();
  const handshake = createTuiPtyComposerReadyHandshake({
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '1',
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
      '--no-verification-agent',
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 140,
      rows: 48,
      env: handshake.env,
    }
  );
  let output = '';
  let plainOutput = '';
  let exited = false;
  let exitCode: number | undefined;
  let memoryNoticeSeen = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    finalMarker.observe(chunk);
    discoveryMarker.observe(chunk);
    secret.observe(chunk);
    output = appendBoundedPtyEvidence(output, chunk, 256_000);
    plainOutput = appendBoundedPtyEvidence(
      plainOutput,
      stripVTControlCharacters(chunk),
      256_000
    );
    memoryNoticeSeen ||= plainOutput.includes('Saved 1 project memories');
  });

  try {
    await waitFor(
      () =>
        output.includes(handshake.marker) && plainOutput.includes(input.historyReady),
      'Memory consolidation TUI did not restore the target Session',
      60_000
    );
    await writeBracketedPaste(terminal, input.prompt);
    await new Promise((resolve) => setTimeout(resolve, 250));
    finalMarker.arm();
    terminal.write('\r');
    await waitFor(
      () =>
        finalMarker.seen &&
        memoryNoticeSeen &&
        plainOutput.lastIndexOf('yolo mode on') > plainOutput.lastIndexOf(input.marker),
      'Memory consolidation TUI did not complete with its memory notice'
    );
    await waitFor(
      () =>
        access(path.join(input.memoryDir, 'MEMORY.md')).then(
          () => true,
          () => false
        ),
      'Memory consolidation TUI did not persist the memory index',
      10_000
    );
    if (secret.seen) throw new Error('Memory consolidation TUI leaked a credential');

    signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
    await waitForPtyExit(exitPromise, 'Memory consolidation TUI did not exit');
    if (exitCode !== 0) throw new Error(`Memory consolidation TUI exited ${exitCode}`);

    const discoveryHandshake = createTuiPtyComposerReadyHandshake({
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '1',
      BLADE_TELEMETRY_DISABLED: '1',
      BLADE_VERSION: '999.0.0',
      BLADE_API_KEY: input.secret,
      TERM: 'xterm-256color',
    });
    const discoveryTerminal = spawn(
      '/usr/bin/env',
      [
        'node',
        input.cliEntry,
        '--trust-workspace',
        '--permission-mode',
        'yolo',
        '--max-turns',
        '1',
        '--no-verification-agent',
      ],
      {
        name: 'xterm-256color',
        cwd: input.workspace,
        cols: 140,
        rows: 48,
        env: discoveryHandshake.env,
      }
    );
    let discoveryOutput = '';
    let discoveryExited = false;
    let discoveryExitCode: number | undefined;
    const discoveryExit = new Promise<void>((resolve) => {
      discoveryTerminal.onExit((event) => {
        discoveryExited = true;
        discoveryExitCode = event.exitCode;
        resolve();
      });
    });
    discoveryTerminal.onData((chunk) => {
      discoveryMarker.observe(chunk);
      secret.observe(chunk);
      discoveryOutput = appendBoundedPtyEvidence(discoveryOutput, chunk, 128_000);
    });
    try {
      await waitFor(
        () => discoveryOutput.includes(discoveryHandshake.marker),
        'Memory discovery TUI composer did not become ready',
        60_000
      );
      await writeBracketedPaste(discoveryTerminal, input.discoveryPrompt);
      await new Promise((resolve) => setTimeout(resolve, 250));
      discoveryMarker.arm();
      discoveryTerminal.write('\r');
      await waitFor(
        () =>
          discoveryMarker.seen &&
          stripVTControlCharacters(discoveryOutput).lastIndexOf('yolo mode on') >
            stripVTControlCharacters(discoveryOutput).lastIndexOf(
              input.discoveryMarker
            ),
        'Memory consolidation TUI did not discover the new memory index'
      );
      if (secret.seen) {
        throw new Error('Memory discovery TUI leaked a credential');
      }
    } finally {
      if (!discoveryExited) {
        signalTerminalTree(discoveryTerminal.pid, 'SIGTERM', () =>
          discoveryTerminal.kill('SIGTERM')
        );
        await waitForPtyExit(
          discoveryExit,
          'Memory discovery TUI did not exit',
          2_000
        ).catch(() => undefined);
      }
      if (!discoveryExited) {
        signalTerminalTree(discoveryTerminal.pid, 'SIGKILL', () =>
          discoveryTerminal.kill('SIGKILL')
        );
      }
    }
    if (discoveryExited && discoveryExitCode !== 0) {
      throw new Error(`Memory discovery TUI exited ${discoveryExitCode}`);
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        finalMarkerSeen: finalMarker.seen,
        compactionRendered: plainOutput.includes('正在压缩上下文'),
        memoryNoticeSeen,
        discoveryMarkerSeen: discoveryMarker.seen,
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
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await waitForPtyExit(
        exitPromise,
        'Memory consolidation TUI cleanup timed out',
        2_000
      ).catch(() => undefined);
    }
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
    }
  }
}

if (import.meta.main) await main();
