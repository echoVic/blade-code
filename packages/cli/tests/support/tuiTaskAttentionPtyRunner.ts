import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import {
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment, TUI_COMPOSER_MARKER } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  sessionId: string;
  title: string;
  terminalContent: string;
  completionFile: string;
}

interface LaunchResult {
  output: string;
  plainOutput: string;
}

interface PtyCapture {
  raw: string;
  plain: string;
}

let activeTerminal:
  | {
      pid: number;
      kill(signal?: string): void;
      exitPromise: Promise<void>;
      exited: () => boolean;
    }
  | undefined;

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TUI_ATTENTION_INPUT;
  if (!encoded) throw new Error('Missing BLADE_TUI_ATTENTION_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const inspect = async () => {
      try {
        if (await predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(message));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    };
    const timer = setInterval(() => void inspect(), 50);
    void inspect();
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
    '/usr/bin/env',
    [
      'node',
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
      env: createTuiPtyEnvironment(),
    }
  );
  let output = '';
  let plainOutput = '';
  let exited = false;
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
  });

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
    return { output, plainOutput };
  } finally {
    options.capture?.(projectForegroundBoundedPtyOutput(output).slice(-3_000));
    if (!exited) {
      terminal.write('\u0003');
      terminal.write('\u0003');
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 750)),
      ]);
    }
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
    if (activeTerminal?.pid === terminal.pid) activeTerminal = undefined;
  }
}

async function stopForSignal(): Promise<void> {
  const terminal = activeTerminal;
  if (terminal && !terminal.exited()) {
    signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
    await Promise.race([
      terminal.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
  if (terminal && !terminal.exited()) {
    signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
    await Promise.race([
      terminal.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
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
    const firstMarkerAbsent = !first.plainOutput.includes('[NEW]');
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
      30_000
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
        markerCleared = !capture().plain.includes(`[NEW] [DONE] ${input.title}`);
      },
    });
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
