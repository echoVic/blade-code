import { access, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { GoalStore } from '../../src/goals/GoalStore.js';
import {
  ArmedPtyMarkerLatch,
  appendBoundedPtyEvidence,
  latestCompleteStandardPtyFrame,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  readyFile: string;
  releaseFile: string;
  secret: string;
  settlementState: 'paused' | 'blocked';
  directSchemas: boolean;
  skillSchemas: boolean;
  followUpReadyFile: string;
  followUpPrompt: string;
  followUpMarker: string;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  const encoded = process.env.BLADE_GOAL_PAUSED_USAGE_PTY_INPUT;
  if (!encoded) throw new Error('Missing Goal paused usage PTY input');
  delete process.env.BLADE_GOAL_PAUSED_USAGE_PTY_INPUT;
  const input = JSON.parse(
    Buffer.from(encoded, 'base64').toString('utf8')
  ) as RunnerInput;
  process.env.BLADE_STORAGE_ROOT = input.storageRoot;
  const handshake = createTuiPtyComposerReadyHandshake({
    ...process.env,
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_API_KEY: input.secret,
    TERM: 'xterm-256color',
  });
  const terminal = spawn(
    '/usr/bin/env',
    [
      'node',
      input.cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--resume',
      input.sessionId,
      '--allowed-tools',
      input.skillSchemas
        ? 'Skill,ToolSearch,UpdateGoal'
        : input.directSchemas
          ? 'UpdateGoal'
          : input.settlementState === 'blocked'
            ? 'ToolSearch,UpdateGoal'
            : 'Read',
      ...(input.directSchemas ? ['--disallowed-tools', 'ToolSearch'] : []),
      '--no-verification-agent',
    ],
    { cwd: input.workspace, cols: 160, rows: 48, env: handshake.env }
  );
  let output = '';
  const responseMarker = new ArmedPtyMarkerLatch('GOAL_PAUSED_USAGE_READY');
  let exited = false;
  let exitCode: number | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    responseMarker.observe(chunk);
    output = appendBoundedPtyEvidence(output, chunk, 256_000);
  });
  const store = new GoalStore(input.workspace, input.sessionId);
  const submit = async (command: string) => {
    await writeBracketedPaste(terminal, command);
    await waitFor(
      () => output.includes(command),
      'Goal command did not reach composer'
    );
    terminal.write('\r');
  };
  const stop = (signal: NodeJS.Signals) => {
    try {
      process.kill(-terminal.pid, signal);
    } catch {
      terminal.kill(signal);
    }
  };
  try {
    await waitFor(() => output.includes(handshake.marker), 'Goal composer not ready');
    await waitFor(
      async () =>
        access(input.readyFile).then(
          () => true,
          () => false
        ),
      'Real Provider response did not reach the pause barrier'
    );
    if (input.settlementState === 'paused') await submit('/goal pause');
    await waitFor(
      async () => (await store.get())?.status === input.settlementState,
      'Goal did not reach its settlement state'
    );
    const turnLimit = (await readFile(input.readyFile, 'utf8')) === 'turn-limit';
    if (!turnLimit) {
      const paused = await store.get();
      if (paused?.tokensUsed !== 0)
        throw new Error('Goal settled before pause barrier');
      responseMarker.arm();
      await writeFile(input.releaseFile, 'release');
    }
    await waitFor(
      async () => ((await store.get())?.tokensUsed ?? 0) > 0,
      'Paused usage missing'
    );
    const settled = await store.get();
    if (settled?.status !== input.settlementState)
      throw new Error('Settlement changed Goal state');
    if (turnLimit) {
      const persistence = new PersistentStore(input.workspace);
      await waitFor(
        async () =>
          (await persistence.loadEvents(input.sessionId))?.some(
            (event) =>
              event.type === 'turn_aborted' &&
              event.data.turnId === settled.turnLineage?.currentTurnId &&
              event.data.cause === 'failed' &&
              event.data.turnsCount === 2 &&
              event.data.toolCallsCount === 2
          ) === true,
        'Blocked Goal did not persist its bounded turn outcome'
      );
    } else {
      await waitFor(() => responseMarker.seen, 'Real model response was not rendered');
    }
    await submit('/goal status');
    await waitFor(
      () =>
        projectForegroundBoundedPtyOutput(output).includes(
          `${settled.tokensUsed}/1 tokens`
        ),
      'Paused Goal token total was not rendered'
    );
    await submit('/goal resume');
    await waitFor(
      async () => (await store.get())?.status === 'budget_limited',
      'Goal resume bypassed exhausted budget'
    );
    await waitFor(
      () => projectForegroundBoundedPtyOutput(output).includes('budget_limited'),
      'Budget limit was not rendered'
    );
    if (input.skillSchemas) {
      if (input.followUpPrompt.includes(input.followUpMarker))
        throw new Error('Follow-up prompt leaks the marker');
      await writeFile(input.followUpReadyFile, 'ready');
      await writeBracketedPaste(terminal, input.followUpPrompt);
      await waitFor(() => {
        const frame = latestCompleteStandardPtyFrame(output, /lineage:[^\r\n]+\r?\n?$/);
        return (
          frame?.includes(input.followUpPrompt.slice(0, 64)) === true &&
          frame.includes(input.followUpPrompt.split('\n').at(-1) ?? '')
        );
      }, 'Follow-up input did not reach the latest composer frame');
      terminal.write('\r');
      await waitFor(
        () => projectForegroundBoundedPtyOutput(output).includes(input.followUpMarker),
        'Next ordinary task did not render'
      );
    }
    if (output.includes(input.secret)) throw new Error('PTY leaked a credential');
    stop('SIGTERM');
    await waitForPtyExit(exitPromise, 'Goal paused usage PTY did not exit');
    if (exitCode !== 0) throw new Error(`PTY exited ${exitCode}`);
    process.stdout.write(
      JSON.stringify({ success: true, tokensUsed: settled.tokensUsed })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[redacted]'
        ),
        output: projectForegroundBoundedPtyOutput(output).replaceAll(
          input.secret,
          '[redacted]'
        ),
      })
    );
    process.exitCode = 1;
  } finally {
    if (!exited) {
      stop('SIGTERM');
      await waitForPtyExit(exitPromise, 'Goal PTY cleanup timed out', 2_000).catch(
        () => undefined
      );
    }
    if (!exited) stop('SIGKILL');
  }
}

if (import.meta.main) await main();
