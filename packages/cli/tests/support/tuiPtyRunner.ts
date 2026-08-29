import { spawn } from 'bun-pty';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
} from './foregroundBoundedOutputPtyDriver.js';
import {
  createTuiPtyComposerReadyHandshake,
  writeBracketedPaste,
} from './ptyInput.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required TUI PTY setting: ${name}`);
  return value;
};

const cliEntry = required('BLADE_TUI_TEST_CLI_ENTRY');
const workspace = required('BLADE_TUI_TEST_WORKSPACE');
const prompt = required('BLADE_TUI_TEST_PROMPT');
const expected = required('BLADE_TUI_TEST_EXPECTED');
const sessionId = required('BLADE_TUI_TEST_SESSION_ID');

function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for TUI marker: ${description}`));
      }
    }, 50);
  });
}

const handshake = createTuiPtyComposerReadyHandshake();
const terminal = spawn(
  '/usr/bin/env',
  [
    'node',
    cliEntry,
    '--trust-workspace',
    '--permission-mode',
    'yolo',
    '--max-turns',
    '2',
    '--session-id',
    sessionId,
  ],
  {
    name: 'xterm-256color',
    cwd: workspace,
    cols: 120,
    rows: 40,
    env: handshake.env,
  }
);
let output = '';
let sawExpected = false;
terminal.onData((chunk) => {
  output = appendBoundedPtyEvidence(output, chunk);
  sawExpected = latchPtyMarker(sawExpected, output, expected);
});

try {
  await waitFor(() => output.includes(handshake.marker), 'composer', 30_000);
  await writeBracketedPaste(terminal, prompt);
  await waitFor(() => output.includes('BRACKETED_'), 'bracketed paste', 10_000);
  terminal.write('\r');
  await waitFor(() => sawExpected, expected, 270_000);
  process.stdout.write(
    JSON.stringify({
      success: true,
      sawExpected,
      output,
    })
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      output,
    })
  );
  process.exitCode = 1;
} finally {
  terminal.kill();
}
