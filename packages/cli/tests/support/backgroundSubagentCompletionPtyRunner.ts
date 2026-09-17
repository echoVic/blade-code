import { waitForCondition as waitFor, waitForInboxRemoval } from './asyncTestUtils.js';
import {
  appendBoundedPtyEvidence,
  latchPtyMarker,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment } from './ptyInput.js';
import { createTuiPtyHarness } from './tuiPtyHarness.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing background completion PTY setting: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const cliEntry = required('BLADE_BACKGROUND_COMPLETION_PTY_CLI_ENTRY');
  const workspace = required('BLADE_BACKGROUND_COMPLETION_PTY_WORKSPACE');
  const sessionId = required('BLADE_BACKGROUND_COMPLETION_PTY_SESSION_ID');
  const childMarker = required('BLADE_BACKGROUND_COMPLETION_PTY_CHILD_MARKER');
  const secret = process.env.BLADE_BACKGROUND_COMPLETION_PTY_SECRET ?? '';
  const expectedParent = `BACKGROUND_PARENT_FINAL:${childMarker}`;
  const childEnv = createTuiPtyEnvironment();
  const pty = createTuiPtyHarness({
    cliEntry,
    workspace,
    args: [
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '8',
      '--resume',
      sessionId,
    ],
    env: childEnv,
  });
  const { terminal } = pty;
  let output = '';
  let sawProviderAdmission = false;
  let sawChildMarker = false;
  let sawParentFinal = false;
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk);
    sawProviderAdmission = latchPtyMarker(
      sawProviderAdmission,
      output,
      '等待 Provider 容量'
    );
    sawChildMarker = latchPtyMarker(sawChildMarker, output, childMarker);
    sawParentFinal = latchPtyMarker(sawParentFinal, output, expectedParent);
  });

  try {
    const evidenceDeadline = Date.now() + 270_000;
    await waitFor(
      () => sawProviderAdmission,
      'Raw PTY did not render Provider admission queue',
      Math.max(1, evidenceDeadline - Date.now())
    );
    await waitFor(
      () => sawChildMarker && sawParentFinal,
      'Timed out waiting for child marker and resumed parent in TUI',
      Math.max(1, evidenceDeadline - Date.now())
    );
    await waitForInboxRemoval(workspace, sessionId, 10_000);
    terminal.resize(100, 36);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(
      JSON.stringify({
        success: true,
        sawProviderAdmission,
        sawChildMarker,
        sawParentFinal,
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
