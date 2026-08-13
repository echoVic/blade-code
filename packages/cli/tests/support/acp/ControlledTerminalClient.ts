import * as acp from '@agentclientprotocol/sdk';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface QueuedOutput {
  response: acp.TerminalOutputResponse | Error;
  barrier?: Promise<void>;
}

export interface OutputBarrier {
  release(): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class ControlledTerminalClient implements acp.Client {
  readonly createRequests: acp.CreateTerminalRequest[] = [];
  readonly outputRequests: acp.TerminalOutputRequest[] = [];
  readonly waitRequests: acp.WaitForTerminalExitRequest[] = [];
  readonly killRequests: acp.KillTerminalRequest[] = [];
  readonly releaseRequests: acp.ReleaseTerminalRequest[] = [];
  readonly callOrder: string[] = [];
  readonly sessionUpdates: acp.SessionNotification[] = [];
  readonly terminalId = 'controlled-terminal';

  activeOutputReads = 0;
  maxConcurrentOutputReads = 0;

  private readonly outputs: QueuedOutput[] = [];
  private wait = deferred<acp.WaitForTerminalExitResponse>();
  private createError: Error | undefined;
  private lastOutput: acp.TerminalOutputResponse = { output: '', truncated: false };

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    return { content: `controlled:${params.sessionId}:${params.path}` };
  }

  async writeTextFile(
    _params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    return {};
  }

  async createTerminal(
    params: acp.CreateTerminalRequest
  ): Promise<acp.CreateTerminalResponse> {
    this.createRequests.push(params);
    this.callOrder.push('create');
    if (this.createError) throw this.createError;
    return { terminalId: this.terminalId };
  }

  async terminalOutput(
    params: acp.TerminalOutputRequest
  ): Promise<acp.TerminalOutputResponse> {
    this.outputRequests.push(params);
    this.callOrder.push('output');
    this.activeOutputReads += 1;
    this.maxConcurrentOutputReads = Math.max(
      this.maxConcurrentOutputReads,
      this.activeOutputReads
    );

    try {
      const queued = this.outputs.shift();
      if (!queued) return this.lastOutput;
      await queued.barrier;
      if (queued.response instanceof Error) throw queued.response;
      this.lastOutput = queued.response;
      return queued.response;
    } finally {
      this.activeOutputReads -= 1;
    }
  }

  async waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest
  ): Promise<acp.WaitForTerminalExitResponse> {
    this.waitRequests.push(params);
    this.callOrder.push('wait');
    return this.wait.promise;
  }

  async killTerminal(
    params: acp.KillTerminalRequest
  ): Promise<acp.KillTerminalResponse> {
    this.killRequests.push(params);
    this.callOrder.push('kill');
    return {};
  }

  async releaseTerminal(
    params: acp.ReleaseTerminalRequest
  ): Promise<acp.ReleaseTerminalResponse> {
    this.releaseRequests.push(params);
    this.callOrder.push('release');
    return {};
  }

  enqueueOutput(response: acp.TerminalOutputResponse): void {
    this.outputs.push({ response });
  }

  enqueueOutputError(error: Error): void {
    this.outputs.push({ response: error });
  }

  enqueueBlockedOutput(response: acp.TerminalOutputResponse): OutputBarrier {
    const gate = deferred<void>();
    this.outputs.push({ response, barrier: gate.promise });
    return { release: () => gate.resolve() };
  }

  enqueueBlockedOutputError(error: Error): OutputBarrier {
    const gate = deferred<void>();
    this.outputs.push({ response: error, barrier: gate.promise });
    return { release: () => gate.resolve() };
  }

  failCreate(error: Error): void {
    this.createError = error;
  }

  resolveWait(response: acp.WaitForTerminalExitResponse): void {
    this.wait.resolve(response);
  }

  rejectWait(error: Error): void {
    this.wait.reject(error);
  }
}
