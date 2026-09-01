import { StringDecoder } from 'node:string_decoder';
import { BoundedOutputBuffer } from '../tools/builtin/shell/BoundedOutputBuffer.js';
import { OutputTruncator } from '../tools/builtin/shell/OutputTruncator.js';
import { spawnOwnedProcess } from '../utils/process/OwnedProcessTree.js';

export const MAX_USER_SHELL_COMMAND_CHARS = 32 * 1024;
export const MAX_USER_SHELL_CAPTURE_BYTES = 1024 * 1024;
export const MAX_USER_SHELL_STREAM_BYTES = 64 * 1024;
export const DEFAULT_USER_SHELL_TIMEOUT_MS = 60 * 60 * 1000;

const MAX_BINARY_SNIFF_BYTES = 4096;
const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC is the protocol marker.
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export type UserShellCommandStatus =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'timed_out'
  | 'spawn_error';

export interface UserShellCommandRecord {
  version: 1;
  command: string;
  status: UserShellCommandStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
  binaryOutput: boolean;
  truncated: boolean;
}

export interface UserShellExecutorResult {
  exitCode: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface UserShellExecutorOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string | Buffer) => void;
}

export interface UserShellExecutor {
  execute(
    command: string,
    options: UserShellExecutorOptions
  ): Promise<UserShellExecutorResult>;
}

export function createUnavailableUserShellExecutor(): UserShellExecutor {
  return {
    async execute() {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        error: 'ACP terminal capability is unavailable',
      };
    },
  };
}

export type UserShellCommandEvent =
  | {
      type: 'started';
      executionId: string;
      command: string;
    }
  | {
      type: 'output';
      executionId: string;
      stream: 'stdout' | 'stderr';
      chunk: string;
      streamedBytes: number;
      streamTruncated: boolean;
    }
  | {
      type: 'completed';
      executionId: string;
      record: UserShellCommandRecord;
    };

export interface ExecuteUserShellCommandOptions {
  executionId: string;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs?: number;
  executor?: UserShellExecutor;
  onEvent?: (event: UserShellCommandEvent) => void | Promise<void>;
}

interface StreamCaptureSnapshot {
  content: string;
  omittedBytes: number;
  binary: boolean;
}

class StreamCapture {
  private readonly output = new BoundedOutputBuffer(MAX_USER_SHELL_CAPTURE_BYTES / 2);
  private readonly decoder = new StringDecoder('utf8');
  private readonly sniffChunks: Buffer[] = [];
  private sniffBytes = 0;
  private binary = false;
  private totalBytes = 0;
  private streamedBytes = 0;
  private streamTruncated = false;
  private readonly pendingEvents: Promise<void>[] = [];

  constructor(
    private readonly stream: 'stdout' | 'stderr',
    private readonly executionId: string,
    private readonly onEvent?: ExecuteUserShellCommandOptions['onEvent']
  ) {}

  append(value: string | Buffer): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;

    if (this.sniffBytes < MAX_BINARY_SNIFF_BYTES) {
      const sniff = chunk.subarray(
        0,
        Math.min(chunk.length, MAX_BINARY_SNIFF_BYTES - this.sniffBytes)
      );
      this.sniffChunks.push(sniff);
      this.sniffBytes += sniff.length;
      this.binary = this.binary || Buffer.concat(this.sniffChunks).includes(0);
    }

    if (this.binary) {
      return;
    }

    const decoded = stripAnsi(this.decoder.write(chunk));
    this.output.append(decoded);
    this.emit(decoded);
  }

  finish(): void {
    if (this.binary) return;
    const remaining = stripAnsi(this.decoder.end());
    this.output.append(remaining);
    this.emit(remaining);
  }

  snapshot(): StreamCaptureSnapshot {
    const snapshot = this.output.peek();
    if (this.binary) {
      return {
        content: `[binary ${this.stream} omitted: ${this.totalBytes} bytes]`,
        omittedBytes: this.totalBytes,
        binary: true,
      };
    }
    return {
      content: snapshot.content,
      omittedBytes: snapshot.omittedBytes,
      binary: false,
    };
  }

  async flushEvents(): Promise<void> {
    await Promise.all(this.pendingEvents);
    this.pendingEvents.length = 0;
  }

  private emit(chunk: string): void {
    if (!chunk || !this.onEvent || this.streamTruncated) return;
    const remaining = MAX_USER_SHELL_STREAM_BYTES - this.streamedBytes;
    if (remaining <= 0) {
      this.streamTruncated = true;
      return;
    }
    const projected = truncateUtf8(chunk, remaining);
    this.streamedBytes += Buffer.byteLength(projected);
    if (projected.length < chunk.length) this.streamTruncated = true;
    this.pendingEvents.push(
      Promise.resolve(
        this.onEvent({
          type: 'output',
          executionId: this.executionId,
          stream: this.stream,
          chunk: projected,
          streamedBytes: this.streamedBytes,
          streamTruncated: this.streamTruncated,
        })
      ).then(() => undefined)
    );
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validateCommand(command: string): string {
  const normalized = command.trim();
  if (!normalized) throw new Error('User shell command cannot be empty');
  if (normalized.length > MAX_USER_SHELL_COMMAND_CHARS) {
    throw new Error(
      `User shell command exceeds ${MAX_USER_SHELL_COMMAND_CHARS} characters`
    );
  }
  if (normalized.includes('\0')) {
    throw new Error('User shell command contains a null byte');
  }
  return normalized;
}

export function createLocalUserShellExecutor(): UserShellExecutor {
  return {
    execute(command, options) {
      return new Promise((resolve) => {
        const executable =
          process.platform === 'win32'
            ? process.env.COMSPEC || 'cmd.exe'
            : process.env.SHELL || '/bin/bash';
        const args =
          process.platform === 'win32'
            ? ['/d', '/s', '/c', command]
            : ['-l', '-c', command];
        const { child, processTree } = spawnOwnedProcess(executable, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = '';
        const stderr = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let termination: ReturnType<typeof processTree.terminate> | undefined;
        const terminate = () => {
          termination ??= processTree.terminate();
          return termination;
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          void terminate();
        }, options.timeoutMs);
        const abort = () => {
          aborted = true;
          void terminate();
        };
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();

        child.stdout?.on('data', (chunk: Buffer) => {
          options.onOutput?.('stdout', chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          options.onOutput?.('stderr', chunk);
        });

        const settle = async (
          result: Omit<UserShellExecutorResult, 'stdout' | 'stderr'>
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          options.signal.removeEventListener('abort', abort);
          if (timedOut || aborted) await terminate();
          resolve({ ...result, stdout, stderr, timedOut, aborted });
        };
        child.once('error', (error) => {
          void settle({ exitCode: null, error: error.message });
        });
        child.once('close', (code) => {
          void settle({ exitCode: code });
        });
      });
    },
  };
}

export async function executeUserShellCommand(
  command: string,
  options: ExecuteUserShellCommandOptions
): Promise<UserShellCommandRecord> {
  const normalized = validateCommand(command);
  const timeoutMs = options.timeoutMs ?? DEFAULT_USER_SHELL_TIMEOUT_MS;
  const stdoutCapture = new StreamCapture(
    'stdout',
    options.executionId,
    options.onEvent
  );
  const stderrCapture = new StreamCapture(
    'stderr',
    options.executionId,
    options.onEvent
  );
  const startedAt = Date.now();
  await options.onEvent?.({
    type: 'started',
    executionId: options.executionId,
    command: normalized,
  });

  let rawResult: UserShellExecutorResult;
  let receivedStdout = false;
  let receivedStderr = false;
  try {
    rawResult = await (options.executor ?? createLocalUserShellExecutor()).execute(
      normalized,
      {
        cwd: options.cwd,
        env: options.env,
        timeoutMs,
        signal: options.signal,
        onOutput: (stream, chunk) => {
          if (stream === 'stdout') receivedStdout = true;
          else receivedStderr = true;
          (stream === 'stdout' ? stdoutCapture : stderrCapture).append(chunk);
        },
      }
    );
  } catch (error) {
    rawResult = {
      exitCode: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!receivedStdout) stdoutCapture.append(rawResult.stdout);
  if (!receivedStderr) stderrCapture.append(rawResult.stderr);
  stdoutCapture.finish();
  stderrCapture.finish();
  await Promise.all([stdoutCapture.flushEvents(), stderrCapture.flushEvents()]);
  const stdout = stdoutCapture.snapshot();
  const stderr = stderrCapture.snapshot();
  const truncated = OutputTruncator.truncateForLLM(
    stdout.content.trim(),
    stderr.content.trim(),
    normalized
  );
  const status: UserShellCommandStatus =
    rawResult.aborted || options.signal.aborted
      ? 'aborted'
      : rawResult.timedOut
        ? 'timed_out'
        : rawResult.error
          ? 'spawn_error'
          : rawResult.exitCode === 0
            ? 'completed'
            : 'failed';
  const record: UserShellCommandRecord = {
    version: 1,
    command: normalized,
    status,
    exitCode: rawResult.exitCode,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdout: truncated.stdout,
    stderr: rawResult.error
      ? [truncated.stderr, rawResult.error].filter(Boolean).join('\n')
      : truncated.stderr,
    stdoutOmittedBytes: stdout.omittedBytes,
    stderrOmittedBytes: stderr.omittedBytes,
    binaryOutput: stdout.binary || stderr.binary,
    truncated:
      Boolean(truncated.truncationInfo) ||
      stdout.omittedBytes > 0 ||
      stderr.omittedBytes > 0,
  };
  await options.onEvent?.({
    type: 'completed',
    executionId: options.executionId,
    record,
  });
  return record;
}

export function renderUserShellCommandForModel(record: UserShellCommandRecord): string {
  const output = [
    record.stdout ? `stdout:\n${record.stdout}` : '',
    record.stderr ? `stderr:\n${record.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    '<user_shell_command>',
    `<command>${escapeXml(record.command)}</command>`,
    '<result>',
    `Status: ${record.status}`,
    `Exit code: ${record.exitCode ?? 'null'}`,
    `Duration: ${(record.durationMs / 1000).toFixed(3)} seconds`,
    `Output:\n${escapeXml(output || '(no output)')}`,
    '</result>',
    '</user_shell_command>',
  ].join('\n');
}

export function renderUserShellCommandForDisplay(
  record: UserShellCommandRecord
): string {
  const output = [record.stdout, record.stderr ? `stderr:\n${record.stderr}` : '']
    .filter(Boolean)
    .join('\n');
  return [`! ${record.command}`, output || '(no output)'].join('\n');
}

export function parseUserShellCommandRecord(
  value: unknown
): UserShellCommandRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.command !== 'string' ||
    !['completed', 'failed', 'aborted', 'timed_out', 'spawn_error'].includes(
      String(record.status)
    ) ||
    (record.exitCode !== null && typeof record.exitCode !== 'number') ||
    typeof record.durationMs !== 'number' ||
    typeof record.stdout !== 'string' ||
    typeof record.stderr !== 'string' ||
    typeof record.stdoutOmittedBytes !== 'number' ||
    typeof record.stderrOmittedBytes !== 'number' ||
    typeof record.binaryOutput !== 'boolean' ||
    typeof record.truncated !== 'boolean'
  ) {
    return undefined;
  }
  return record as unknown as UserShellCommandRecord;
}

export function userShellCommandRecordFromMetadata(
  metadata: unknown
): UserShellCommandRecord | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  return parseUserShellCommandRecord(
    (metadata as Record<string, unknown>).userShellCommand
  );
}
