import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import {
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  sessionId: string;
  primaryPrompt: string;
  firstMarker: string;
  deletedMarker: string;
  movedMarker: string;
  expectedOutput: string;
  activeFile: string;
  mutatedFile: string;
  releasedFile: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOLLOW_UP_PTY_INPUT;
  if (!encoded) throw new Error('Missing follow-up PTY runner input');
  delete process.env.BLADE_FOLLOW_UP_PTY_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function inboxText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('\n');
}

async function queuedTexts(workspace: string, sessionId: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      await readFile(getSessionInboxFilePath(workspace, sessionId), 'utf8')
    ) as { messages?: Array<{ content?: unknown }> };
    return (parsed.messages ?? []).map((message) => inboxText(message.content));
  } catch {
    return [];
  }
}

async function followUpTexts(input: RunnerInput): Promise<string[]> {
  return (await queuedTexts(input.workspace, input.sessionId)).filter(
    (text) => text !== input.primaryPrompt
  );
}

async function main(): Promise<void> {
  const input = loadInput();
  const handshake = createTuiPtyComposerReadyHandshake({
    BLADE_VERSION: '999.0.0',
  });
  const terminal = spawn(
    process.execPath,
    [
      input.cliEntry,
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '4',
      '--session-id',
      input.sessionId,
    ],
    {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: 120,
      rows: 40,
      env: handshake.env,
    }
  );
  let output = '';
  let plainOutput = '';
  let stageOutput = '';
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = appendBoundedPtyEvidence(output, chunk, 48_000);
    plainOutput = appendBoundedPtyEvidence(
      plainOutput,
      stripVTControlCharacters(chunk),
      48_000
    );
    stageOutput = appendBoundedPtyEvidence(
      stageOutput,
      stripVTControlCharacters(chunk),
      16_000
    );
  });

  let panelOpened = false;
  let reordered = false;
  let deleted = false;
  let resized = false;
  let reopened = false;
  let finalMarkerSeen = false;
  try {
    await waitFor(
      () =>
        output.includes(handshake.marker) &&
        plainOutput.includes('请输入您的问题，我将为您提供帮助。'),
      'Timed out waiting for the initialized production TUI composer',
      30_000
    );
    await writeBracketedPaste(terminal, input.primaryPrompt);
    await waitFor(
      () => plainOutput.includes(input.primaryPrompt.slice(0, 48)),
      'Bracketed primary prompt did not reach the TUI composer',
      10_000
    );
    terminal.write('\r');
    await waitFor(
      () => existsSync(input.activeFile),
      'Timed out waiting for the active Provider request',
      30_000
    );

    const followUps = [input.firstMarker, input.deletedMarker, input.movedMarker];
    for (const [index, marker] of followUps.entries()) {
      await writeBracketedPaste(terminal, marker);
      const visibleMarker = marker.split('.', 1)[0]!;
      await waitFor(
        () => stageOutput.includes(visibleMarker),
        `Follow-up ${index + 1} did not reach the TUI composer`,
        10_000
      );
      terminal.write('\r');
      await waitFor(
        async () => (await followUpTexts(input)).length === index + 1,
        `TUI did not durably enqueue follow-up ${index + 1}`,
        10_000
      );
    }

    stageOutput = '';
    await writeBracketedPaste(terminal, '/queue');
    await waitFor(
      () => stageOutput.includes('/queue'),
      'Queue command did not reach the TUI composer',
      10_000
    );
    terminal.write('\r');
    await waitFor(
      () =>
        stageOutput.includes('Follow-up queue · 3') &&
        stageOutput.includes(input.firstMarker) &&
        stageOutput.includes(input.deletedMarker) &&
        stageOutput.includes(input.movedMarker.split('.', 1)[0]!),
      'TUI queue panel did not render the three durable rows',
      15_000
    );
    panelOpened = true;

    for (const key of ['j', 'j', 'K']) {
      terminal.write(key);
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    await waitFor(
      async () => {
        const messages = await followUpTexts(input);
        return (
          messages[0] === input.firstMarker &&
          messages[1] === input.movedMarker &&
          messages[2] === input.deletedMarker
        );
      },
      'TUI queue move did not commit A, C, B',
      15_000
    );
    reordered = true;

    terminal.write('j');
    await new Promise((resolve) => setTimeout(resolve, 75));
    terminal.write('d');
    await waitFor(
      async () => {
        const messages = await followUpTexts(input);
        return (
          messages.length === 2 &&
          messages[0] === input.firstMarker &&
          messages[1] === input.movedMarker
        );
      },
      'TUI queue delete did not commit A, C',
      15_000
    );
    deleted = true;

    stageOutput = '';
    terminal.resize(100, 36);
    await waitFor(
      () => stageOutput.includes('Follow-up queue · 2'),
      'TUI queue panel did not survive resize',
      10_000
    );
    resized = true;

    terminal.write('q');
    await new Promise((resolve) => setTimeout(resolve, 100));
    stageOutput = '';
    await writeBracketedPaste(terminal, '/queue');
    await waitFor(
      () => stageOutput.includes('/queue'),
      'Second queue command did not reach the TUI composer',
      10_000
    );
    terminal.write('\r');
    await waitFor(
      () =>
        stageOutput.includes('Follow-up queue · 2') &&
        stageOutput.includes(input.firstMarker) &&
        stageOutput.includes(input.movedMarker.split('.', 1)[0]!),
      'TUI queue panel did not reopen with the committed order',
      15_000
    );
    reopened = true;
    terminal.write('q');

    stageOutput = '';
    await writeFile(input.mutatedFile, 'mutated\n', { mode: 0o600 });
    await waitFor(
      () => existsSync(input.releasedFile),
      'Timed out waiting for Provider release',
      30_000
    );
    await waitFor(
      async () => (await queuedTexts(input.workspace, input.sessionId)).length === 0,
      'TUI did not durably acknowledge the consumed queue',
      180_000
    );
    await waitFor(
      () => stageOutput.includes(input.expectedOutput),
      'TUI did not render the final Provider response',
      60_000
    );
    finalMarkerSeen = true;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        queuedTexts: await queuedTexts(input.workspace, input.sessionId),
        followUpTexts: await followUpTexts(input),
        panelOpened,
        reordered,
        deleted,
        resized,
        reopened,
        finalMarkerSeen,
        output: projectForegroundBoundedPtyOutput(output),
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
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!exited) {
      process.stderr.write('Follow-up TUI process remained alive after SIGKILL\n');
      process.exitCode = 1;
    }
    if (process.exitCode !== 1) {
      process.stdout.write(
        JSON.stringify({
          success: true,
          panelOpened,
          reordered,
          deleted,
          resized,
          reopened,
          finalMarkerSeen,
          cleanupComplete: true,
          output: projectForegroundBoundedPtyOutput(output),
        })
      );
    }
  }
}

if (import.meta.main) await main();
