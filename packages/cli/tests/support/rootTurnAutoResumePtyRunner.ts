import { stripVTControlCharacters } from 'node:util';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import {
  createTuiPtyEnvironment,
  TUI_COMPOSER_MARKER,
  writeBracketedPaste,
} from './ptyInput.js';
import { createTuiPtyHarness } from './tuiPtyHarness.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required root-resume PTY setting: ${name}`);
  return value;
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

async function waitForDurableCompletion(
  workspace: string,
  sessionId: string,
  inputMessageId: string,
  timeoutMs: number
): Promise<void> {
  const store = new PersistentStore(workspace);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await store.loadEvents(sessionId)) ?? [];
    const turn = events.findLast(
      (event) =>
        event.type === 'turn_started' &&
        event.data.inputMessageIds?.includes(inputMessageId)
    );
    const turnId = turn?.type === 'turn_started' ? turn.data.turnId : undefined;
    const acknowledgement = events.findLast(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.includes(inputMessageId)
    );
    const acknowledgementSeq = acknowledgement?.seq;
    if (
      typeof acknowledgementSeq === 'number' &&
      events.some(
        (event) =>
          event.type === 'turn_completed' &&
          event.data.turnId === turnId &&
          typeof event.seq === 'number' &&
          event.seq > acknowledgementSeq
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    'TUI root-turn response did not reach durable acknowledgement and completion'
  );
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_ROOT_RESUME_PTY_CLI_ENTRY');
  const workspace = required('BLADE_ROOT_RESUME_PTY_WORKSPACE');
  const sessionId = required('BLADE_ROOT_RESUME_PTY_SESSION_ID');
  const inputMessageId = required('BLADE_ROOT_RESUME_PTY_INPUT_MESSAGE_ID');
  const expected = required('BLADE_ROOT_RESUME_PTY_EXPECTED');
  const secret = process.env.BLADE_ROOT_RESUME_PTY_SECRET ?? '';
  const childEnv = createTuiPtyEnvironment();
  childEnv.BLADE_VERSION = '999.0.0';
  const pty = createTuiPtyHarness({
    cliEntry,
    workspace,
    args: [
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '4',
      '--resume',
      sessionId,
    ],
    env: childEnv,
    signal: (terminal, signal) =>
      signalTerminalTree(terminal.pid, signal, () => terminal.kill(signal)),
  });
  const { terminal } = pty;
  let output = '';
  let plainOutput = '';
  let sawAttention = false;
  let sawExpected = false;
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
    plainOutput = appendBoundedPtyEvidence(
      plainOutput,
      stripVTControlCharacters(chunk)
    );
    sawAttention ||= /Turn recovery requires attention|Runtime Recovery/.test(
      plainOutput
    );
    sawExpected = latchPtyMarker(sawExpected, output, expected);
  });

  try {
    const evidenceDeadline = Date.now() + 270_000;
    await waitFor(
      () => sawAttention && plainOutput.includes(TUI_COMPOSER_MARKER),
      'Timed out waiting for root-turn TUI recovery attention',
      Math.min(30_000, Math.max(1, evidenceDeadline - Date.now()))
    );
    const confirmation =
      'I inspected the workspace and external state. Continue safely without ' +
      'repeating any write or other side effect.';
    await writeBracketedPaste(terminal, confirmation);
    await waitFor(
      () => plainOutput.includes(confirmation.slice(0, 32)),
      'Root-turn recovery confirmation did not reach the TUI composer',
      Math.min(10_000, Math.max(1, evidenceDeadline - Date.now()))
    );
    terminal.write('\r');
    await waitFor(
      () => sawExpected,
      'Timed out waiting for root-turn TUI auto-resume',
      Math.max(1, evidenceDeadline - Date.now())
    );
    await waitForDurableCompletion(
      workspace,
      sessionId,
      inputMessageId,
      Math.max(1, evidenceDeadline - Date.now())
    );
    terminal.resize(100, 36);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawAttention,
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
}

if (import.meta.main) {
  await main();
}
