import { spawn } from 'bun-pty';
import {
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required bounded PTY setting: ${name}`);
  return value;
};

function waitFor(
  predicate: () => boolean,
  message: string,
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
        reject(new Error(message));
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_BOUNDED_PTY_CLI_ENTRY');
  const workspace = required('BLADE_BOUNDED_PTY_WORKSPACE');
  const prompt = required('BLADE_BOUNDED_PTY_PROMPT');
  const expected = required('BLADE_BOUNDED_PTY_EXPECTED');
  const stdoutTail = required('BLADE_BOUNDED_PTY_STDOUT_TAIL');
  const stderrTail = required('BLADE_BOUNDED_PTY_STDERR_TAIL');
  const sessionId = required('BLADE_BOUNDED_PTY_SESSION_ID');
  const secret = process.env.BLADE_BOUNDED_PTY_SECRET ?? '';
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
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
  });

  try {
    await waitFor(
      () => output.includes('请输入您的问题'),
      'Timed out waiting for TUI composer',
      30_000
    );
    terminal.write(`\u001B[200~${prompt}\u001B[201~`);
    await waitFor(
      () => output.includes('bounded foreground'),
      'Bracketed paste did not reach the TUI composer',
      10_000
    );
    terminal.write('\r');
    await waitFor(
      () =>
        output.includes(expected) &&
        output.includes('Output truncated') &&
        output.includes(stdoutTail) &&
        output.includes(stderrTail),
      'Timed out waiting for bounded foreground TUI evidence',
      180_000
    );
    const noticeBeforeResize = output.includes('Output truncated');
    terminal.resize(100, 36);
    const resizeBoundary = output.length;
    await waitFor(
      () =>
        output.slice(Math.max(0, resizeBoundary - 1)).includes('Output truncated') ||
        output.includes(expected),
      'TUI resize did not preserve completed output',
      10_000
    );
    const evidence = {
      success: true,
      sawExpected: output.includes(expected),
      sawStdoutTail: output.includes(stdoutTail),
      sawStderrTail: output.includes(stderrTail),
      noticeBeforeResize,
      noticeAfterResize: output.includes('Output truncated'),
      output: projectForegroundBoundedPtyOutput(
        secret ? output.replaceAll(secret, '[REDACTED]') : output
      ),
    };
    process.stdout.write(JSON.stringify(evidence));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        output: projectForegroundBoundedPtyOutput(
          secret ? output.replaceAll(secret, '[REDACTED]') : output
        ),
      })
    );
    process.exitCode = 1;
  } finally {
    terminal.write('\u0004');
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    if (!exited) terminal.kill('SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!exited) terminal.kill('SIGKILL');
  }
}

if (import.meta.main) {
  await main();
}
