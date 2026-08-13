import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';

const MAX_TERMINAL_OUTPUT_CHARS = 4 * 1024 * 1024;

interface TerminalState {
  child: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exit: Promise<number>;
  exitCode: number | null;
}

function appendOutput(state: TerminalState, chunk: Buffer): void {
  const next = state.output + chunk.toString('utf8');
  if (next.length <= MAX_TERMINAL_OUTPUT_CHARS) {
    state.output = next;
    return;
  }
  state.output = next.slice(-MAX_TERMINAL_OUTPUT_CHARS);
  state.truncated = true;
}

export class ChildProcessRecordingAcpClient implements acp.Client {
  readonly sessionUpdates: acp.SessionNotification[] = [];
  readonly createRequests: acp.CreateTerminalRequest[] = [];
  readonly releaseCounts = new Map<string, number>();
  private readonly terminals = new Map<string, TerminalState>();

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
  }

  async createTerminal(
    params: acp.CreateTerminalRequest
  ): Promise<acp.CreateTerminalResponse> {
    this.createRequests.push(params);
    const terminalId = `child-process-${randomUUID()}`;
    const env = {
      ...process.env,
      ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])),
    };
    const child = spawn('/bin/bash', ['-c', params.command], {
      cwd: params.cwd ?? undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveExit!: (exitCode: number) => void;
    const state: TerminalState = {
      child,
      output: '',
      truncated: false,
      exit: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      exitCode: null,
    };
    child.stdout.on('data', (chunk: Buffer) => appendOutput(state, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendOutput(state, chunk));
    child.once('error', (error) => {
      appendOutput(state, Buffer.from(error.message));
      state.exitCode = 1;
      resolveExit(1);
    });
    child.once('exit', (code) => {
      state.exitCode = code ?? 1;
      resolveExit(state.exitCode);
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
      truncated: state.truncated,
      ...(state.exitCode !== null ? { exitStatus: { exitCode: state.exitCode } } : {}),
    };
  }

  async waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest
  ): Promise<acp.WaitForTerminalExitResponse> {
    const state = this.requireTerminal(params.terminalId);
    return { exitCode: state.exitCode ?? (await state.exit) };
  }

  async killTerminal(
    params: acp.KillTerminalRequest
  ): Promise<acp.KillTerminalResponse> {
    const state = this.requireTerminal(params.terminalId);
    if (state.exitCode === null) {
      state.child.kill('SIGTERM');
      const graceful = await Promise.race([
        state.exit.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!graceful && state.exitCode === null) state.child.kill('SIGKILL');
      await state.exit;
    }
    return {};
  }

  async releaseTerminal(
    params: acp.ReleaseTerminalRequest
  ): Promise<acp.ReleaseTerminalResponse> {
    const state = this.terminals.get(params.terminalId);
    if (!state) return {};
    if (state.exitCode === null) await state.exit;
    this.releaseCounts.set(
      params.terminalId,
      (this.releaseCounts.get(params.terminalId) ?? 0) + 1
    );
    this.terminals.delete(params.terminalId);
    return {};
  }

  activeTerminalCount(): number {
    return this.terminals.size;
  }

  async close(): Promise<void> {
    for (const terminalId of [...this.terminals.keys()]) {
      await this.killTerminal({ sessionId: '', terminalId }).catch(() => undefined);
      await this.releaseTerminal({ sessionId: '', terminalId }).catch(() => undefined);
    }
  }

  private requireTerminal(terminalId: string): TerminalState {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`Unknown terminal: ${terminalId}`);
    return state;
  }
}
