import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import { latchPtyMarker } from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment } from './ptyInput.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required prompt cache PTY setting: ${name}`);
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
  const cliEntry = required('BLADE_CACHE_PTY_CLI_ENTRY');
  const workspace = required('BLADE_CACHE_PTY_WORKSPACE');
  const sessionId = required('BLADE_CACHE_PTY_SESSION_ID');
  const childEnv = createTuiPtyEnvironment();
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
  let sawCacheUnavailable = false;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = `${output}${chunk}`.slice(-32_000);
    sawCacheUnavailable = latchPtyMarker(
      sawCacheUnavailable,
      stripVTControlCharacters(output),
      'Cache —'
    );
  });

  try {
    await waitFor(
      () => sawCacheUnavailable,
      'Timed out waiting for prompt cache TUI status',
      60_000
    );
    const plain = stripVTControlCharacters(output);
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawCacheUnavailable,
        output: plain.slice(-8_000),
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        output: stripVTControlCharacters(output).slice(-8_000),
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
