import { spawn } from 'bun-pty';

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
const MAX_EVIDENCE_CHARS = 24_000;

function waitForOutput(
  readOutput: () => string,
  marker: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (readOutput().includes(marker)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for TUI marker: ${marker}`));
      }
    }, 50);
  });
}

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
);
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
    env: childEnv,
  }
);
let output = '';
terminal.onData((chunk) => {
  output = `${output}${chunk}`.slice(-MAX_EVIDENCE_CHARS);
});

try {
  await waitForOutput(() => output, '请输入您的问题', 30_000);
  terminal.write(`\u001B[200~${prompt}\u001B[201~`);
  await waitForOutput(() => output, 'BRACKETED_', 10_000);
  terminal.write('\r');
  await waitForOutput(() => output, expected, 180_000);
  process.stdout.write(
    JSON.stringify({
      success: true,
      sawExpected: output.includes(expected),
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
