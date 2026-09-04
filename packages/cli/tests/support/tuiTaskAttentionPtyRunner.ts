import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import {
  ArmedPtyMarkerLatch,
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment, TUI_COMPOSER_MARKER } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  nodeExecutable: string;
  workspace: string;
  sessionId: string;
  title: string;
  terminalContent: string;
  completionFile: string;
  completionTimeoutMs: number;
}

interface LaunchResult {
  output: string;
  plainOutput: string;
  sawNewMarker: boolean;
}

interface PtyCapture {
  raw: string;
  plain: string;
}

interface ActiveTerminal {
  pid: number;
  kill(signal?: string): void;
  exitPromise: Promise<void>;
  exited(): boolean;
}

let activeTerminal: ActiveTerminal | undefined;

function readBoundedString(
  value: unknown,
  label: string,
  maximumLength = 8_192
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function readBoundedTimeout(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > 300_000
  ) {
    throw new Error('Invalid task completion timeout');
  }
  return value;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TUI_ATTENTION_INPUT;
  if (!encoded || encoded.length > 64 * 1024) {
    throw new Error('Missing or oversized BLADE_TUI_ATTENTION_INPUT');
  }
  const value: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid task attention PTY input');
  }
  const candidate = value as Record<string, unknown>;
  return {
    cliEntry: readBoundedString(candidate.cliEntry, 'CLI entry'),
    nodeExecutable: readBoundedString(candidate.nodeExecutable, 'Node executable'),
    workspace: readBoundedString(candidate.workspace, 'workspace'),
    sessionId: readBoundedString(candidate.sessionId, 'Session ID', 512),
    title: readBoundedString(candidate.title, 'title', 512),
    terminalContent: readBoundedString(candidate.terminalContent, 'terminal content'),
    completionFile: readBoundedString(candidate.completionFile, 'completion file'),
    completionTimeoutMs: readBoundedTimeout(candidate.completionTimeoutMs),
  };
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

function signalTerminalTree(
  pid: number,
  signal: NodeJS.Signals,
  fallback: () => void
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      try {
        fallback();
      } catch {
        // The PTY process already exited.
      }
    }
  }
}

async function terminateTerminal(
  terminal: ActiveTerminal,
  graceMs: number
): Promise<void> {
  if (terminal.exited()) return;
  signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
  await Promise.race([
    terminal.exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ]);
  if (terminal.exited()) return;
  signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
  await Promise.race([
    terminal.exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!terminal.exited()) {
    throw new Error('Task attention PTY remained alive after SIGKILL');
  }
}

async function launch(
  input: RunnerInput,
  options: {
    resume: boolean;
    act?: (
      terminal: { write(data: string): void },
      capture: () => PtyCapture
    ) => Promise<void>;
    capture?: (output: string) => void;
  }
): Promise<LaunchResult> {
  const terminal = spawn(
    input.nodeExecutable,
    [
      input.cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      ...(options.resume ? ['--resume'] : []),
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 120,
      rows: 40,
      env: createTuiPtyEnvironment({ BLADE_VERSION: '999.0.0' }),
    }
  );
  let output = '';
  let plainOutput = '';
  let exited = false;
  const newMarkerLatch = new ArmedPtyMarkerLatch('[NEW]');
  newMarkerLatch.arm();
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  activeTerminal = {
    pid: terminal.pid,
    kill: (signal) => terminal.kill(signal),
    exitPromise,
    exited: () => exited,
  };
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk, 48_000);
    plainOutput = appendBoundedPtyEvidence(
      plainOutput,
      stripVTControlCharacters(chunk),
      48_000
    );
    newMarkerLatch.observe(stripVTControlCharacters(chunk));
  });

  let primaryError: unknown;
  try {
    await waitFor(
      () =>
        options.resume
          ? plainOutput.includes('选择要恢复的会话:')
          : plainOutput.includes(TUI_COMPOSER_MARKER),
      options.resume
        ? 'Timed out waiting for the production resume selector'
        : 'Timed out waiting for the production TUI composer',
      30_000
    );
    try {
      await options.act?.(terminal, () => ({ raw: output, plain: plainOutput }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; PTY=${projectForegroundBoundedPtyOutput(output).slice(-8_000)}`
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (!exited) {
      terminal.write('\u0003');
      terminal.write('\u0003');
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 750)),
      ]);
    }
    await terminateTerminal(
      {
        pid: terminal.pid,
        kill: (signal) => terminal.kill(signal),
        exitPromise,
        exited: () => exited,
      },
      2_000
    );
  } catch (error) {
    cleanupError = error;
  } finally {
    options.capture?.(projectForegroundBoundedPtyOutput(output).slice(-3_000));
    if (activeTerminal?.pid === terminal.pid) activeTerminal = undefined;
  }
  const failures = [primaryError, cleanupError].filter(
    (error): error is NonNullable<typeof error> => error !== undefined
  );
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Task attention PTY launch and cleanup failed');
  }
  if (failures.length === 1) throw failures[0];
  return {
    output,
    plainOutput,
    sawNewMarker: newMarkerLatch.seen,
  };
}

async function stopForSignal(): Promise<void> {
  const terminal = activeTerminal;
  try {
    if (terminal) await terminateTerminal(terminal, 1_000);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.exit(143);
}

process.once('SIGTERM', () => void stopForSignal());

async function main(): Promise<void> {
  const input = loadInput();
  let output = '';
  const stageOutput: Partial<Record<'baseline' | 'resume' | 'cleared', string>> = {};
  try {
    const first = await launch(input, {
      resume: false,
      capture: (value) => {
        stageOutput.baseline = value;
      },
    });
    output = appendBoundedPtyEvidence(output, first.output, 48_000);
    const firstMarkerAbsent = !first.sawNewMarker;
    const ledgerPath = path.join(
      process.env.BLADE_STORAGE_ROOT ?? '',
      'tui-task-attention-v1.json'
    );
    await waitFor(
      async () => {
        try {
          const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
            entries?: Array<{ signature?: unknown; unread?: unknown }>;
          };
          return (
            ledger.entries?.length === 1 &&
            ledger.entries[0]?.signature === null &&
            ledger.entries[0]?.unread === false
          );
        } catch {
          return false;
        }
      },
      'Production TUI did not persist the running task baseline',
      10_000
    );
    await writeFile(input.completionFile, 'baseline\n', { mode: 0o600 });
    await waitFor(
      async () => {
        try {
          await access(`${input.completionFile}.done`);
          return true;
        } catch {
          return false;
        }
      },
      'Timed out waiting for task completion after TUI exit',
      input.completionTimeoutMs
    );

    let newMarkerSeen = false;
    let exactSessionSelected = false;
    let terminalContentSeen = false;
    const second = await launch(input, {
      resume: true,
      capture: (value) => {
        stageOutput.resume = value;
      },
      act: async (terminal, capture) => {
        await waitFor(
          () => capture().plain.includes(`[NEW] [DONE] ${input.title}`),
          'Resume selector did not render the exact NEW Session',
          30_000
        );
        newMarkerSeen = true;
        terminal.write('\r');
        await waitFor(
          () =>
            capture().plain.includes(TUI_COMPOSER_MARKER) &&
            capture().plain.includes('Resuming…'),
          'Exact Session did not finish local activation',
          30_000
        );
        exactSessionSelected = true;
        terminal.write('\u000f');
        await waitFor(
          () => capture().plain.includes(input.terminalContent),
          'Selected Session transcript did not render terminal content',
          30_000
        );
        terminalContentSeen = true;
      },
    });
    output = appendBoundedPtyEvidence(output, second.output, 48_000);

    let markerCleared = false;
    const third = await launch(input, {
      resume: true,
      capture: (value) => {
        stageOutput.cleared = value;
      },
      act: async (_terminal, capture) => {
        await waitFor(
          () => capture().plain.includes(`[DONE] ${input.title}`),
          'Third resume selector did not render the selected Session',
          30_000
        );
      },
    });
    markerCleared = !third.sawNewMarker;
    output = appendBoundedPtyEvidence(output, third.output, 48_000);

    process.stdout.write(
      JSON.stringify({
        success: true,
        baselinePersisted: true,
        firstMarkerAbsent,
        newMarkerSeen,
        exactSessionSelected,
        terminalContentSeen,
        markerCleared,
        stageOutput,
        output: projectForegroundBoundedPtyOutput(output),
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stageOutput,
        output: projectForegroundBoundedPtyOutput(output),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
