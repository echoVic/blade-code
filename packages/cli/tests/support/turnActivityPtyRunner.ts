import { writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import {
  ArmedPtyMarkerLatch,
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import {
  createTuiPtyComposerReadyHandshake,
  TUI_COMPOSER_MARKER,
  writeBracketedPaste,
} from './ptyInput.js';
import { createTuiTaskAttentionRunnerEnvironment } from './tuiTaskAttentionPtyDriver.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  secret: string;
  allowedTools?: string;
  maxTurns?: number;
  releaseFile?: string;
}

export const BLADE_TURN_ACTIVITY_PTY_USES_PRODUCTION_DIST = true;

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TURN_ACTIVITY_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_TURN_ACTIVITY_PTY_INPUT');
  delete process.env.BLADE_TURN_ACTIVITY_PTY_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
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
  const markerLatch = new ArmedPtyMarkerLatch(input.marker);
  const secretLatch = new ArmedPtyMarkerLatch(input.secret);
  secretLatch.arm();
  const handshake = createTuiPtyComposerReadyHandshake({
    ...createTuiTaskAttentionRunnerEnvironment(process.env, {
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    }),
    BLADE_API_KEY: input.secret,
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
      String(input.maxTurns ?? 4),
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      input.allowedTools ?? 'Bash',
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
  let sawThinking = false;
  let sawTool = false;
  let releasedTool = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    markerLatch.observe(chunk);
    secretLatch.observe(chunk);
    output = appendBoundedPtyEvidence(output, chunk, 128_000);
    plainOutput = appendBoundedPtyEvidence(
      plainOutput,
      stripVTControlCharacters(chunk),
      128_000
    );
    sawThinking ||= plainOutput.includes('正在思考');
    sawTool ||=
      plainOutput.includes('正在执行 1 个工具') && plainOutput.includes('Bash');
    if (sawTool && input.releaseFile && !releasedTool) {
      releasedTool = true;
      void writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    }
  });

  try {
    await waitFor(
      () => output.includes(handshake.marker),
      'Turn activity TUI composer did not become ready',
      60_000
    );
    await writeBracketedPaste(terminal, input.prompt);
    await new Promise((resolve) => setTimeout(resolve, 250));
    markerLatch.arm();
    terminal.write('\r');
    await waitFor(() => sawThinking, 'Turn activity TUI did not render thinking');
    await waitFor(() => sawTool, 'Turn activity TUI did not render active Bash');
    if (input.releaseFile && !releasedTool) {
      releasedTool = true;
      await writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    }
    await waitFor(
      () =>
        markerLatch.seen &&
        plainOutput.lastIndexOf(TUI_COMPOSER_MARKER) >
          plainOutput.lastIndexOf(input.marker),
      'Turn activity TUI did not complete and return to the composer',
      60_000
    );
    if (secretLatch.seen) throw new Error('Turn activity TUI leaked a credential');

    signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
    await waitForPtyExit(exitPromise, 'Turn activity TUI did not exit after SIGTERM');
    if (exitCode !== 0) throw new Error(`Turn activity TUI exited ${exitCode}`);
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawThinking,
        sawTool,
        phases: [
          ...(sawThinking ? ['thinking'] : []),
          ...(sawTool ? ['executing_tools'] : []),
          ...(markerLatch.seen ? ['responding'] : []),
          'clear',
        ],
        generationCount: 1,
        sawBash: sawTool,
        terminalClearSeen: true,
        finalMarkerSeen: markerLatch.seen,
        cleanupComplete: true,
        leakedSecrets: [],
        output: projectForegroundBoundedPtyOutput(output),
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[REDACTED]'
        ),
        output: projectForegroundBoundedPtyOutput(output).replaceAll(
          input.secret,
          '[REDACTED]'
        ),
      })
    );
    process.exitCode = 1;
  } finally {
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await waitForPtyExit(
        exitPromise,
        'Turn activity TUI cleanup timed out',
        2_000
      ).catch(() => undefined);
    }
    if (!exited) {
      signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
    }
  }
}

if (import.meta.main) await main();
