import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';
import { createTuiPtyHarness } from './tuiPtyHarness.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing Browser Tool PTY setting: ${name}`);
  return value;
}

async function waitForDurableCompletion(
  workspace: string,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  const store = new PersistentStore(workspace);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await store.loadEvents(sessionId)) ?? [];
    const terminalIndex = events.findLastIndex(
      (event) => event.type === 'turn_completed'
    );
    if (
      terminalIndex >= 0 &&
      events
        .slice(terminalIndex + 1)
        .some(
          (event) =>
            event.type === 'session_updated' && event.data.taskStatus === 'completed'
        )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Browser Tool PTY did not reach durable completion');
}

const cliEntry = required('BLADE_BROWSER_TOOL_PTY_CLI_ENTRY');
const workspace = required('BLADE_BROWSER_TOOL_PTY_WORKSPACE');
const prompt = required('BLADE_BROWSER_TOOL_PTY_PROMPT');
const expected = required('BLADE_BROWSER_TOOL_PTY_EXPECTED');
const sessionId = required('BLADE_BROWSER_TOOL_PTY_SESSION_ID');
const secret = process.env.BLADE_BROWSER_TOOL_PTY_SECRET ?? '';
const handshake = createTuiPtyComposerReadyHandshake();
const pty = createTuiPtyHarness({
  cliEntry,
  workspace,
  args: [
    '--trust-workspace',
    '--permission-mode',
    'yolo',
    '--max-turns',
    '30',
    '--session-id',
    sessionId,
  ],
  env: handshake.env,
});
const { terminal } = pty;
let output = '';
let sawExpected = false;
terminal.onData((chunk) => {
  output = appendBoundedPtyEvidence(output, chunk);
  sawExpected = latchPtyMarker(sawExpected, output, expected);
});

try {
  await waitFor(() => output.includes(handshake.marker), 'PTY composer', 30_000);
  await writeBracketedPaste(terminal, prompt);
  await waitFor(() => output.includes('PASTE:'), 'bracketed paste', 10_000);
  terminal.write('\r');
  await waitFor(() => sawExpected, 'Browser Tool final marker', 270_000);
  await waitForDurableCompletion(workspace, sessionId, 15_000);
  process.stdout.write(
    JSON.stringify({
      success: true,
      sawExpected,
      output: projectForegroundBoundedPtyOutput(
        secret ? output.replaceAll(secret, '[REDACTED]') : output
      ),
    })
  );
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
  await pty.close();
}
