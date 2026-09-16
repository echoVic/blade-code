import { stripVTControlCharacters } from 'node:util';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import { latchPtyMarker } from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment } from './ptyInput.js';
import { createTuiPtyHarness } from './tuiPtyHarness.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required prompt cache PTY setting: ${name}`);
  return value;
};

async function main(): Promise<void> {
  const cliEntry = required('BLADE_CACHE_PTY_CLI_ENTRY');
  const workspace = required('BLADE_CACHE_PTY_WORKSPACE');
  const sessionId = required('BLADE_CACHE_PTY_SESSION_ID');
  const childEnv = createTuiPtyEnvironment();
  const pty = createTuiPtyHarness({
    cliEntry,
    workspace,
    args: [
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '2',
      '--session-id',
      sessionId,
    ],
    env: childEnv,
  });
  const { terminal } = pty;
  let output = '';
  let sawCacheUnavailable = false;
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
    await pty.close();
  }
}

if (import.meta.main) {
  await main();
}
