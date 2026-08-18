import { spawn } from 'bun-pty';
import {
  appendBoundedPtyEvidence,
  latchForegroundBoundedPtyMarkers,
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
  let readerPaused = false;
  let pauseInjected = false;
  let receivedAfterResume = false;
  let resizeOutput = '';
  let captureResizeOutput = false;
  let markers = {
    sawExpected: false,
    sawStdoutTail: false,
    sawStderrTail: false,
    sawTruncation: false,
  };
  terminal.onData((chunk) => {
    if (readerPaused) return;
    if (pauseInjected) receivedAfterResume = true;
    output = appendBoundedPtyEvidence(output, chunk);
    markers = latchForegroundBoundedPtyMarkers(markers, output, {
      expected,
      stdoutTail,
      stderrTail,
    });
    if (captureResizeOutput) {
      resizeOutput = appendBoundedPtyEvidence(resizeOutput, chunk);
    }
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
    readerPaused = true;
    pauseInjected = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    readerPaused = false;
    await waitFor(
      () =>
        markers.sawExpected &&
        markers.sawTruncation &&
        markers.sawStdoutTail &&
        markers.sawStderrTail,
      'Timed out waiting for bounded foreground TUI evidence',
      270_000
    );
    const noticeBeforeResize = markers.sawTruncation;
    captureResizeOutput = true;
    terminal.resize(100, 36);
    await waitFor(
      () => resizeOutput.includes('Output truncated'),
      'TUI resize did not preserve completed output',
      10_000
    );
    const evidence = {
      success: true,
      sawExpected: markers.sawExpected,
      sawStdoutTail: markers.sawStdoutTail,
      sawStderrTail: markers.sawStderrTail,
      noticeBeforeResize,
      noticeAfterResize: resizeOutput.includes('Output truncated'),
      readerPaused: pauseInjected,
      renderedAfterReaderResume: receivedAfterResume && markers.sawExpected,
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
