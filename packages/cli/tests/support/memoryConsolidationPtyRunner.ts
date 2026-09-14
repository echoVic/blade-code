import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import {
  finalAssistantText,
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';
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
  compactionObservedFile?: string;
  manualCompaction?: { readyFile: string; cancelledFile: string };
  sessionId: string;
  discoverySessionId: string;
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
  process.env.HOME = input.home;
  process.env.BLADE_STORAGE_ROOT = input.storageRoot;
  process.env.BLADE_AUTO_MEMORY = '1';
  const compactionMarker = new ArmedPtyMarkerLatch('正在压缩上下文');
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
      process.execPath,
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
    compactionMarker.observe(stripVTControlCharacters(chunk));
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
    if (input.manualCompaction) {
      const { readyFile, cancelledFile } = input.manualCompaction;
      const transcript = findSessionTranscript(input.storageRoot, input.sessionId);
      const before = await readFile(transcript);
      const cancelledMarker = new ArmedPtyMarkerLatch('上下文压缩已取消');
      cancelledMarker.arm();
      terminal.onData((chunk) =>
        cancelledMarker.observe(stripVTControlCharacters(chunk))
      );
      await writeBracketedPaste(terminal, '/compact');
      await waitFor(
        () => plainOutput.includes('/compact'),
        'Manual compaction command did not reach the composer',
        5_000
      );
      terminal.write('\r');
      await waitFor(
        () =>
          access(readyFile).then(
            () => true,
            () => false
          ),
        'Manual compaction Provider did not start'
      );
      const started = Date.now();
      terminal.write('\u001b');
      await waitFor(
        () => cancelledMarker.seen,
        'Manual compaction did not acknowledge Escape',
        10_000
      );
      await waitFor(
        () =>
          access(cancelledFile).then(
            () => true,
            () => false
          ),
        'Manual compaction did not close its Provider request',
        10_000
      );
      if (!(await readFile(transcript)).equals(before))
        throw new Error('Cancelled manual compaction changed the transcript');
      const draft = 'MANUAL_COMPACTION_DRAFT';
      await writeBracketedPaste(terminal, draft);
      await waitFor(
        () => plainOutput.includes(draft),
        'Composer did not recover after manual compaction cancellation',
        5_000
      );
      terminal.write('\u0015');
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await waitForPtyExit(exitPromise, 'Manual compaction TUI did not exit');
      if (exitCode !== 0) throw new Error(`Manual compaction TUI exited ${exitCode}`);
      process.stdout.write(
        JSON.stringify({
          success: true,
          cancelled: true,
          transcriptUnchanged: true,
          composerRecovered: true,
          cancellationMs: Date.now() - started,
        })
      );
      return;
    }
    await writeBracketedPaste(terminal, input.prompt);
    await new Promise((resolve) => setTimeout(resolve, 250));
    finalMarker.arm();
    compactionMarker.arm();
    terminal.write('\r');
    if (input.compactionObservedFile) {
      await waitFor(
        () => compactionMarker.seen,
        'PTY did not render compaction',
        10_000
      );
      await writeFile(input.compactionObservedFile, 'rendered', { mode: 0o600 });
    }
    await waitFor(
      () =>
        finalMarker.seen &&
        memoryNoticeSeen &&
        plainOutput.lastIndexOf('yolo mode on') > plainOutput.lastIndexOf(input.marker),
      'Memory consolidation TUI did not complete with its memory notice'
    );
    await waitFor(
      () =>
        finalAssistantText(
          readSessionEvents(findSessionTranscript(input.storageRoot, input.sessionId))
        ) === input.marker,
      'Memory consolidation TUI did not persist its exact final marker',
      10_000
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
    const { buildSystemPrompt } = await import('../../src/prompts/builder.js');
    const discoverySystemPrompt = await buildSystemPrompt({
      projectPath: input.workspace,
      includeEnvironment: false,
      projectTrusted: true,
    });
    if (!discoverySystemPrompt.prompt.includes('conventions.md')) {
      throw new Error('Memory consolidation TUI could not load the memory index');
    }
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
        process.execPath,
        input.cliEntry,
        '--trust-workspace',
        '--permission-mode',
        'yolo',
        '--max-turns',
        '1',
        '--session-id',
        input.discoverySessionId,
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
      await waitFor(
        () => {
          try {
            return (
              finalAssistantText(
                readSessionEvents(
                  findSessionTranscript(input.storageRoot, input.discoverySessionId)
                )
              ) === input.discoveryMarker
            );
          } catch {
            return false;
          }
        },
        'Memory discovery TUI did not persist its exact final marker',
        10_000
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
        compactionRendered: compactionMarker.seen,
        memoryNoticeSeen,
        discoveryIndexLoaded: true,
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
