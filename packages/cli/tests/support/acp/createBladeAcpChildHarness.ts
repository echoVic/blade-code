import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { waitForChildExit } from '../asyncTestUtils.js';
import { ChildBackedRecordingAcpClient } from './ChildBackedRecordingAcpClient.js';

interface BladeAcpChildHarnessOptions<TClient extends ChildBackedRecordingAcpClient> {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  client: TClient;
  args?: string[];
  autoMemory?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  stdioError?: string;
  stderrLimit?: number;
  stdoutLimit?: number;
  onStderr?(chunk: Buffer | string): void;
}

export interface BladeAcpChildHarness<TClient extends ChildBackedRecordingAcpClient> {
  child: ChildProcess;
  client: TClient;
  connection: acp.ClientSideConnection;
  readonly stderr: string;
  readonly stdout: string;
  shutdown(
    signal?: NodeJS.Signals,
    timeoutMs?: number
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): Promise<void>;
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): string {
  return `${current}${chunk.toString()}`.slice(-limit);
}

export function createBladeAcpChildHarness<
  TClient extends ChildBackedRecordingAcpClient,
>(options: BladeAcpChildHarnessOptions<TClient>): BladeAcpChildHarness<TClient> {
  const child = spawn(
    process.execPath,
    [options.cliEntry, ...(options.args ?? []), '--acp'],
    {
      cwd: options.workspace,
      env: {
        ...(options.baseEnv ?? process.env),
        HOME: options.home,
        BLADE_STORAGE_ROOT: options.storageRoot,
        BLADE_AUTO_MEMORY: options.autoMemory ? '1' : '0',
        BLADE_TELEMETRY_DISABLED: '1',
        TERM: 'xterm-256color',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error(options.stdioError ?? 'ACP child stdio was unavailable');
  }

  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    options.onStderr?.(chunk);
    stderr = appendBounded(stderr, chunk, options.stderrLimit ?? 64_000);
  });
  if (options.stdoutLimit) {
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk, options.stdoutLimit!);
    });
  }

  const connection = new acp.ClientSideConnection(
    () => options.client,
    acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );

  return {
    child,
    client: options.client,
    connection,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    async shutdown(signal = 'SIGTERM', timeoutMs = 30_000) {
      child.kill(signal);
      const exit = await waitForChildExit(child, timeoutMs);
      await connection.closed.catch(() => undefined);
      return exit;
    },
    async close() {
      await options.client.close().catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child, 10_000).catch(() => undefined);
      }
    },
  };
}
