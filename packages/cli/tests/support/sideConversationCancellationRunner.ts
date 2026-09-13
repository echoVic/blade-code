import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { spawn as spawnPty } from 'bun-pty';
import { parseSchema, type Static, Type } from '../../src/schema/index.js';
import {
  captureProcessIdentity,
  processIdentityMatches,
} from '../../src/utils/process/ProcessIdentity.js';
import {
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildProcessRecordingAcpClient } from './acp/ChildProcessRecordingAcpClient.js';
import {
  latestCompleteStandardPtyFrame,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from './foregroundBoundedOutputWebDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';
import {
  createTuiTaskAttentionRunnerEnvironment,
  createTuiTaskAttentionSecretScanner,
} from './tuiTaskAttentionPtyDriver.js';

const Input = Type.Object({
  surface: Type.Union([Type.Literal('pty'), Type.Literal('acp')]),
  cliEntry: Type.String(),
  workspace: Type.String(),
  home: Type.String(),
  storageRoot: Type.String(),
  sessionId: Type.String(),
  mainPrompt: Type.String(),
  toolStarted: Type.String(),
  holdFile: Type.String(),
  releaseFile: Type.String(),
  traceFile: Type.String(),
  pidFile: Type.String(),
  marker: Type.String(),
  followupQuestion: Type.String(),
  secret: Type.String(),
});

type Input = Static<typeof Input>;

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label);
}

function environment(input: Input) {
  return {
    ...createTuiTaskAttentionRunnerEnvironment(process.env, {
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    }),
    BLADE_API_KEY: input.secret,
  };
}

async function runPty(input: Input) {
  const handshake = createTuiPtyComposerReadyHandshake(environment(input));
  const terminal = spawnPty(
    '/usr/bin/env',
    [
      'node',
      input.cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '4',
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
    ],
    {
      cwd: input.workspace,
      cols: 150,
      rows: 48,
      env: handshake.env,
    }
  );
  const identity = captureProcessIdentity(terminal.pid);
  const scanner = createTuiTaskAttentionSecretScanner([input.secret]);
  let output = '';
  let plain = '';
  let exited = false;
  let exitCode: number | undefined;
  const exit = new Promise<void>((resolve) =>
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    })
  );
  terminal.onData((chunk) => {
    scanner.observe(chunk);
    output = (output + chunk).slice(-128_000);
    plain = (plain + stripVTControlCharacters(chunk)).slice(-128_000);
  });
  const stop = (signal: NodeJS.Signals) => {
    if (exited) return;
    if (identity && !processIdentityMatches(terminal.pid, identity))
      throw new Error('PTY identity changed');
    try {
      process.kill(-terminal.pid, signal);
    } catch {
      terminal.kill(signal);
    }
  };
  const send = async (text: string) => {
    await writeBracketedPaste(terminal, text);
    const projectedPaste = text.length > 500 || text.split('\n').length > 10;
    const expectedPaste = projectedPaste
      ? `${text.length} chars, ${text.split('\n').length} lines:`
      : text.split('\n')[0]!.slice(0, 40);
    await waitFor(() => plain.includes(expectedPaste), 'PTY paste was not rendered');
    terminal.write('\r');
  };
  try {
    await waitFor(
      () => output.includes(handshake.marker),
      'TUI composer was not ready',
      60_000
    );
    await send(input.mainPrompt);
    await waitFor(
      () => existsSync(input.toolStarted),
      'Real main Bash did not start',
      90_000
    );
    const transcript = findSessionTranscript(input.storageRoot, input.sessionId);
    await writeFile(input.holdFile, 'hold');
    await waitFor(
      async () => (await readFile(input.traceFile, 'utf8')).includes('catalog_held'),
      'MCP refresh did not hold'
    );
    const before = await readFile(transcript);
    plain = '';
    await send('/btw Explain the running task without using tools.');
    await waitFor(
      () => plain.includes('Answering...'),
      'TUI side question did not start'
    );
    plain = '';
    output = '';
    terminal.write('\u001b');
    await waitFor(
      () => {
        const frame = latestCompleteStandardPtyFrame(output);
        return (
          frame !== undefined &&
          frame.includes('Bash') &&
          !frame.includes('Answering...')
        );
      },
      'First Escape did not dismiss the side question',
      3_000
    );
    if (!(await readFile(transcript)).equals(before))
      throw new Error('Side cancellation changed the main transcript');
    if (readSessionEvents(transcript).some((event) => event.type === 'turn_aborted'))
      throw new Error('First Escape cancelled the main task');
    const mainStoppedAt = Date.now();
    terminal.write('\u001b');
    await waitFor(
      () =>
        readSessionEvents(transcript).some((event) => event.type === 'turn_aborted'),
      'Second Escape did not cancel the main task',
      3_000
    );
    const cancellationMs = Date.now() - mainStoppedAt;
    const toolPid = Number(await readFile(input.toolStarted, 'utf8'));
    await waitFor(
      () => {
        try {
          process.kill(toolPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      'Cancelled TUI main tool remained alive',
      3_000
    );
    if ((await readFile(input.traceFile, 'utf8')).includes('catalog_released')) {
      throw new Error('TUI cancellation released the shared MCP refresh');
    }
    await waitFor(
      () =>
        readSessionEvents(transcript).some(
          (event) =>
            event.type === 'session_updated' && event.data.taskStatus === 'cancelled'
        ),
      'TUI main task status did not settle',
      3_000
    );
    const afterAbort = await readFile(transcript);
    await writeFile(input.releaseFile, 'release');
    await waitFor(
      async () =>
        (await readFile(input.traceFile, 'utf8')).includes('catalog_released'),
      'Shared MCP refresh did not resume'
    );
    const contextPercent = () =>
      [...stripVTControlCharacters(output).matchAll(/(\d+)%\s*·\s*Cache/g)].at(-1)?.[1];
    await waitFor(
      () => contextPercent() !== undefined,
      'TUI context meter was not rendered'
    );
    const mainContextPercent = contextPercent();
    plain = '';
    output = '';
    const prompt = `/btw ${input.followupQuestion}`;
    await send(prompt);
    await waitFor(
      () =>
        plain.split(/\r?\n/).some((line) => {
          const content = line.trim();
          return (
            content.startsWith('│') &&
            content.endsWith('│') &&
            content.slice(1, -1).trim() === input.marker
          );
        }),
      'TUI side follow-up did not render the exact answer line',
      90_000
    );
    output = '';
    terminal.write('\u001b');
    await waitFor(
      () => contextPercent() !== undefined,
      'TUI context meter did not return after side dismissal'
    );
    if (contextPercent() !== mainContextPercent) {
      throw new Error(
        `Side usage replaced main context: ${mainContextPercent}% -> ${contextPercent()}%`
      );
    }
    if (!(await readFile(transcript)).equals(afterAbort)) {
      const baselineLength = afterAbort.toString().trim().split('\n').length;
      const appended = readSessionEvents(transcript)
        .slice(baselineLength)
        .map((event) => ({
          type: event.type,
          ...(event.type === 'session_updated' ? { update: event.data } : {}),
        }));
      throw new Error(
        `TUI side follow-up changed the main transcript: ${JSON.stringify(appended)}`
      );
    }
    const events = readSessionEvents(transcript);
    if (
      events.filter((event) => event.type === 'turn_aborted').length !== 1 ||
      events.some((event) => event.type === 'turn_completed')
    )
      throw new Error('TUI main terminal record was not exactly one abort');
    if (scanner.leakedSecretLabels().length)
      throw new Error('TUI output leaked credentials');
    stop('SIGTERM');
    await waitForPtyExit(exit, 'TUI did not exit gracefully', 5_000);
    if (exitCode !== 0) throw new Error(`TUI exit code ${exitCode}`);
    const mcpPid = Number(await readFile(input.pidFile, 'utf8'));
    await waitFor(
      () => {
        try {
          process.kill(mcpPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      'TUI MCP process remained after shutdown',
      3_000
    );
    return {
      surface: 'pty',
      sessionId: input.sessionId,
      cancellationMs,
      sideDismissedWithoutMainAbort: true,
      mainContextPreserved: true,
      mainAbortCommitted: true,
      followup: input.marker,
      cleanupComplete: true,
    };
  } catch (error) {
    const frame = latestCompleteStandardPtyFrame(output);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; terminal=${JSON.stringify(
        {
          outputChars: output.length,
          completeFrameSeen: frame !== undefined,
          mainToolVisible: frame?.includes('Bash') ?? false,
          sidePanelVisible: frame?.includes('Answering...') ?? false,
        }
      )}`
    );
  } finally {
    if (!exited) {
      stop('SIGTERM');
      await waitForPtyExit(exit, 'TUI cleanup deadline', 5_000).catch(() => undefined);
    }
    if (!exited) {
      stop('SIGKILL');
      await waitForPtyExit(exit, 'TUI force cleanup deadline', 5_000);
    }
  }
}

async function runAcp(input: Input) {
  const child = spawnChild(
    'node',
    [input.cliEntry, '--debug', 'Agent', '--trust-workspace', '--acp'],
    {
      cwd: input.workspace,
      env: environment(input),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }
  );
  let identity:
    | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
    | undefined;
  let output = '';
  const scanner = createTuiTaskAttentionSecretScanner([input.secret]);
  child.stderr.on('data', (chunk: Buffer) => {
    scanner.observe(chunk);
    output = (output + chunk.toString()).slice(-64_000);
  });
  const client = new ChildProcessRecordingAcpClient();
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      new ReadableStream<Uint8Array>({
        start(controller) {
          child.stdout.on('data', (chunk: Buffer) => {
            scanner.observe(chunk);
            controller.enqueue(chunk);
          });
          child.stdout.once('end', () => controller.close());
          child.stdout.once('error', (error) => controller.error(error));
        },
      })
    )
  );
  const text = () =>
    client.sessionUpdates
      .flatMap(({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
          ? [update.content.text]
          : []
      )
      .join('');
  try {
    if (!child.pid) throw new Error('ACP child has no PID');
    identity = await captureForegroundGuiLauncherIdentity(child.pid);
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    const session = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    const warmupQuestion = 'Reply exactly ACP_SIDE_READY and do not use tools.';
    const warmup = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: `/btw ${warmupQuestion}` }],
    });
    if (
      warmup.stopReason !== 'end_turn' ||
      text().trim() !== `**/btw** ${warmupQuestion}\n\nACP_SIDE_READY`
    )
      throw new Error(
        `ACP side warmup did not answer: ${JSON.stringify({ stopReason: warmup.stopReason, text: text(), output: output.slice(-4_000) })}`
      );
    const transcript = findSessionTranscript(input.storageRoot, session.sessionId);
    const before = await readFile(transcript);
    await writeFile(input.holdFile, 'hold');
    await waitFor(
      async () => (await readFile(input.traceFile, 'utf8')).includes('catalog_held'),
      'ACP MCP refresh did not hold'
    );
    client.sessionUpdates.length = 0;
    output = '';
    const question = '/btw Explain the waiting task without using tools.';
    let result: acp.PromptResponse | undefined;
    const failures: unknown[] = [];
    const pending = connection
      .prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: question }],
      })
      .then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          failures.push(error);
        }
      );
    await waitFor(
      () => output.includes(`Executing slash command: ${question}`),
      'ACP did not accept side question'
    );
    const stoppedAt = Date.now();
    await connection.cancel({ sessionId: session.sessionId });
    await waitFor(
      () => result !== undefined || failures.length > 0,
      'ACP side cancellation did not settle',
      3_000
    );
    await pending;
    if (failures.length) throw failures[0];
    if (result?.stopReason !== 'cancelled')
      throw new Error('ACP cancellation stop reason was incorrect');
    const cancellationMs = Date.now() - stoppedAt;
    if (!(await readFile(transcript)).equals(before))
      throw new Error('ACP side cancellation changed the main transcript');
    if ((await readFile(input.traceFile, 'utf8')).includes('catalog_released'))
      throw new Error('ACP cancelled the shared catalog');
    await writeFile(input.releaseFile, 'release');
    await waitFor(
      async () =>
        (await readFile(input.traceFile, 'utf8')).includes('catalog_released'),
      'ACP catalog did not resume'
    );
    client.sessionUpdates.length = 0;
    const followupQuestion = input.followupQuestion;
    const followup = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: `/btw ${followupQuestion}` }],
    });
    if (
      followup.stopReason !== 'end_turn' ||
      text().trim() !== `**/btw** ${followupQuestion}\n\n${input.marker}`
    )
      throw new Error(
        `ACP side follow-up answer mismatch: ${JSON.stringify({ stopReason: followup.stopReason, text: text() })}`
      );
    if (!(await readFile(transcript)).equals(before))
      throw new Error('ACP follow-up changed the main transcript');
    scanner.observe(JSON.stringify(client.sessionUpdates));
    if (scanner.leakedSecretLabels().length)
      throw new Error('ACP output leaked credentials');
    await stopForegroundGuiLauncher(child, identity);
    if (child.exitCode !== 0) throw new Error('ACP did not exit cleanly');
    const mcpPid = Number(await readFile(input.pidFile, 'utf8'));
    await waitFor(
      () => {
        try {
          process.kill(mcpPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      'ACP MCP process remained after shutdown',
      3_000
    );
    return {
      surface: 'acp',
      sessionId: session.sessionId,
      cancellationMs,
      transcriptUnchanged: true,
      followup: input.marker,
      cleanupComplete: true,
    };
  } finally {
    await Promise.all([stopForegroundGuiLauncher(child, identity), client.close()]);
    await connection.closed;
  }
}

async function main(): Promise<void> {
  const encoded = process.env.BLADE_SIDE_CANCELLATION_INPUT;
  delete process.env.BLADE_SIDE_CANCELLATION_INPUT;
  if (!encoded) throw new Error('Missing side cancellation input');
  const input = parseSchema(
    Input,
    JSON.parse(Buffer.from(encoded, 'base64').toString())
  );
  try {
    const evidence =
      input.surface === 'pty' ? await runPty(input) : await runAcp(input);
    process.stdout.write(JSON.stringify({ success: true, ...evidence }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[REDACTED]'
        ),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
