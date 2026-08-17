import { execFile } from 'node:child_process';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { promisify } from 'node:util';
import type { ForegroundBoundedOutputFixture } from '../integration/real-api/foregroundBoundedOutputFixture.js';

const execFileAsync = promisify(execFile);
const SERIALIZED_PTY_OUTPUT_MAX_CHARS = 8_000;

export interface ForegroundBoundedOutputPtyEvidence {
  success: boolean;
  sawExpected: boolean;
  sawStdoutTail: boolean;
  sawStderrTail: boolean;
  noticeBeforeResize: boolean;
  noticeAfterResize: boolean;
  readerPaused: boolean;
  renderedAfterReaderResume: boolean;
  output: string;
}

export interface ForegroundBoundedPtyMarkers {
  sawExpected: boolean;
  sawStdoutTail: boolean;
  sawStderrTail: boolean;
  sawTruncation: boolean;
}

export function appendBoundedPtyEvidence(
  current: string,
  chunk: string,
  maxChars: number = 24_000
): string {
  return `${current}${chunk}`.slice(-maxChars);
}

export function projectForegroundBoundedPtyOutput(output: string): string {
  const plain = [...stripVTControlCharacters(output)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
  return appendBoundedPtyEvidence('', plain, SERIALIZED_PTY_OUTPUT_MAX_CHARS);
}

export function latchPtyMarker(
  current: boolean,
  output: string,
  marker: string
): boolean {
  return current || output.includes(marker);
}

export function latchForegroundBoundedPtyMarkers(
  current: ForegroundBoundedPtyMarkers,
  output: string,
  expected: {
    expected: string;
    stdoutTail: string;
    stderrTail: string;
  }
): ForegroundBoundedPtyMarkers {
  return {
    sawExpected: latchPtyMarker(current.sawExpected, output, expected.expected),
    sawStdoutTail: latchPtyMarker(current.sawStdoutTail, output, expected.stdoutTail),
    sawStderrTail: latchPtyMarker(current.sawStderrTail, output, expected.stderrTail),
    sawTruncation: latchPtyMarker(current.sawTruncation, output, 'Output truncated'),
  };
}

export function parseForegroundBoundedOutputPtyEvidence(
  stdout: string,
  secrets: readonly string[] = []
): ForegroundBoundedOutputPtyEvidence {
  if (stdout.length > 30_000) {
    throw new Error('Bounded PTY evidence exceeded its serialized budget');
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const requiredFlags = [
    'success',
    'sawExpected',
    'sawStdoutTail',
    'sawStderrTail',
    'noticeBeforeResize',
    'noticeAfterResize',
    'readerPaused',
    'renderedAfterReaderResume',
  ] as const;
  const incomplete: string[] = requiredFlags.filter((field) => parsed[field] !== true);
  const projectedOutput = parsed.output;
  if (typeof projectedOutput !== 'string') incomplete.push('output');
  const safeOutput = typeof projectedOutput === 'string' ? projectedOutput : '';
  if (incomplete.length > 0) {
    let runnerError =
      typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : undefined;
    for (const secret of secrets) {
      if (secret && runnerError) {
        runnerError = runnerError.replaceAll(secret, '[REDACTED]');
      }
    }
    throw new Error(
      `Bounded PTY evidence is incomplete: ${JSON.stringify({
        incomplete,
        ...(runnerError ? { runnerError } : {}),
      })}`
    );
  }
  for (const secret of secrets) {
    if (secret && safeOutput.includes(secret)) {
      throw new Error('Bounded PTY evidence contains secret material');
    }
  }
  return {
    ...parsed,
    output: safeOutput,
  } as unknown as ForegroundBoundedOutputPtyEvidence;
}

export async function runForegroundBoundedOutputPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  fixture: ForegroundBoundedOutputFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<ForegroundBoundedOutputPtyEvidence> {
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const runner = path.resolve(
    import.meta.dirname,
    'foregroundBoundedOutputPtyRunner.ts'
  );
  const expected = `BOUNDED_FOREGROUND_OK_${input.fixture.stdoutTail.replace(
    'STDOUT_RETAINED_TAIL_',
    ''
  )}`;
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_BOUNDED_PTY_CLI_ENTRY: cliEntry,
      BLADE_BOUNDED_PTY_WORKSPACE: input.workspace,
      BLADE_BOUNDED_PTY_PROMPT: input.fixture.localPrompt,
      BLADE_BOUNDED_PTY_EXPECTED: expected,
      BLADE_BOUNDED_PTY_STDOUT_TAIL: input.fixture.stdoutTail,
      BLADE_BOUNDED_PTY_STDERR_TAIL: input.fixture.stderrTail,
      BLADE_BOUNDED_PTY_SESSION_ID: input.sessionId,
      BLADE_BOUNDED_PTY_SECRET: input.secret,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const result = await execFileAsync('bun', [runner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env,
    timeout: input.timeoutMs ?? 210_000,
    maxBuffer: 64 * 1024,
    killSignal: 'SIGKILL',
  });
  return parseForegroundBoundedOutputPtyEvidence(result.stdout, [input.secret]);
}
