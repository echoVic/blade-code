import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import {
  captureProcessIdentity,
  type ProcessIdentity,
} from '../../../src/utils/process/ProcessIdentity.js';

const ACP_TERMINAL_CAPTURE_MAX_CHARS = 4 * 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface PtyProcess {
  pid: number;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitInfo: { exitCode: number }) => void): void;
}

interface TerminalState {
  process: PtyProcess;
  output: string;
  outputTruncated: boolean;
  exit: Deferred<number>;
  exited: boolean;
  exitCode: number | null;
  released: boolean;
  identity?: ProcessIdentity;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendTerminalOutput(state: TerminalState, chunk: string): void {
  const next = state.output + chunk;
  if (next.length <= ACP_TERMINAL_CAPTURE_MAX_CHARS) {
    state.output = next;
    return;
  }
  state.output = next.slice(-ACP_TERMINAL_CAPTURE_MAX_CHARS);
  state.outputTruncated = true;
}

export class ChildBackedRecordingAcpClient implements acp.Client {
  readonly sessionUpdates: acp.SessionNotification[] = [];
  readonly createRequests: acp.CreateTerminalRequest[] = [];
  readonly releaseCounts = new Map<string, number>();
  readonly releasedProcesses: Array<{ pid: number; identity: ProcessIdentity }> = [];

  private readonly terminals = new Map<string, TerminalState>();

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    return { content: await Bun.file(params.path).text() };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    await Bun.write(params.path, params.content);
    return {};
  }

  async createTerminal(
    params: acp.CreateTerminalRequest
  ): Promise<acp.CreateTerminalResponse> {
    this.createRequests.push(params);
    const { spawn } = await import('bun-pty');
    const terminalId = `child-terminal-${randomUUID()}`;
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
      ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])),
    };
    const command =
      `stty -onlcr 2>/dev/null || true; ` +
      `exec /bin/bash -c ${shellQuote(params.command)}`;
    const processHandle = spawn('/bin/bash', ['-c', command], {
      name: 'xterm-256color',
      cwd: params.cwd ?? undefined,
      cols: 120,
      rows: 40,
      env,
    }) as PtyProcess;
    const exit = deferred<number>();
    const state: TerminalState = {
      process: processHandle,
      output: '',
      outputTruncated: false,
      exit,
      exited: false,
      exitCode: null,
      released: false,
      identity: captureProcessIdentity(processHandle.pid) ?? undefined,
    };
    processHandle.onData((chunk) => {
      appendTerminalOutput(state, chunk);
    });
    processHandle.onExit(({ exitCode }) => {
      state.exited = true;
      state.exitCode = exitCode;
      state.exit.resolve(exitCode);
    });
    this.terminals.set(terminalId, state);
    return { terminalId };
  }

  async terminalOutput(
    params: acp.TerminalOutputRequest
  ): Promise<acp.TerminalOutputResponse> {
    const state = this.requireTerminal(params.terminalId);
    return {
      output: state.output,
      truncated: state.outputTruncated,
      ...(state.exited ? { exitStatus: { exitCode: state.exitCode ?? 1 } } : {}),
    };
  }

  async waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest
  ): Promise<acp.WaitForTerminalExitResponse> {
    const state = this.requireTerminal(params.terminalId);
    return { exitCode: state.exited ? state.exitCode : await state.exit.promise };
  }

  async killTerminal(
    params: acp.KillTerminalRequest
  ): Promise<acp.KillTerminalResponse> {
    const state = this.requireTerminal(params.terminalId);
    if (!state.exited) {
      state.process.kill('SIGTERM');
      const graceful = await Promise.race([
        state.exit.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!graceful && !state.exited) state.process.kill('SIGKILL');
      await state.exit.promise;
    }
    return {};
  }

  async releaseTerminal(
    params: acp.ReleaseTerminalRequest
  ): Promise<acp.ReleaseTerminalResponse> {
    const state = this.terminals.get(params.terminalId);
    if (!state || state.released) return {};
    state.released = true;
    this.releaseCounts.set(
      params.terminalId,
      (this.releaseCounts.get(params.terminalId) ?? 0) + 1
    );
    if (!state.exited) await state.exit.promise;
    if (state.identity) {
      this.releasedProcesses.push({
        pid: state.process.pid,
        identity: state.identity,
      });
    }
    this.terminals.delete(params.terminalId);
    return {};
  }

  activeTerminalCount(): number {
    return this.terminals.size;
  }

  terminalPids(): number[] {
    return [...this.terminals.values()].map((state) => state.process.pid);
  }

  async close(): Promise<void> {
    for (const [terminalId, state] of [...this.terminals]) {
      if (!state.exited) {
        await this.killTerminal({ sessionId: '', terminalId }).catch(() => undefined);
      }
      await this.releaseTerminal({ sessionId: '', terminalId }).catch(() => undefined);
    }
  }

  private requireTerminal(terminalId: string): TerminalState {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`Unknown terminal: ${terminalId}`);
    return state;
  }
}
