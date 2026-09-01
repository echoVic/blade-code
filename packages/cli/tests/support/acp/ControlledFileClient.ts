import * as acp from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import { createAcpRemoteConnectionPathIdentity } from '../../../src/acp/AcpFileRequestCoordinator.js';
import { parseAcpRemotePath } from '../../../src/acp/AcpRemotePath.js';

export type ControlledFileRequest =
  | {
      kind: 'read';
      request: acp.ReadTextFileRequest;
    }
  | {
      kind: 'write';
      request: acp.WriteTextFileRequest;
    };

export type ControlledWriteBehavior =
  | { kind: 'apply-and-ack' }
  | { kind: 'ack-without-apply' }
  | { kind: 'ack-with-replacement'; content: string }
  | { kind: 'apply-and-throw'; error: Error }
  | { kind: 'leave-old-and-throw'; error: Error }
  | { kind: 'replace-and-throw'; content: string; error: Error }
  | {
      kind: 'blocked';
      promise: Promise<void>;
    };

export interface ControlledFileRequestObservation {
  readonly kind: 'read' | 'write';
  readonly requestId: acp.JsonRpcId;
  readonly signal: AbortSignal;
  cancelled: boolean;
  settled: 'pending' | 'fulfilled' | 'rejected';
  settledAfterCancel: boolean;
}

export interface ControlledObservedBlockedHandle {
  readonly started: Promise<ControlledFileRequestObservation>;
  release(): void;
  reject(error: Error): void;
}

type ControlledObservedBlockedMode =
  | 'cooperate-with-cancel'
  | 'ignore-cancel-until-release';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

interface ControlledObservedBlockedBehavior {
  kind: 'observed-blocked';
  mode: ControlledObservedBlockedMode;
  started: Deferred<ControlledFileRequestObservation>;
  outcome: Deferred<void>;
}

type ControlledReadBehavior =
  | { kind: 'pass-through' }
  | { kind: 'blocked'; promise: Promise<void> }
  | ControlledObservedBlockedBehavior
  | { kind: 'throw'; error: Error };

type ControlledQueuedWriteBehavior =
  | ControlledWriteBehavior
  | ControlledObservedBlockedBehavior;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class ControlledFileClient implements acp.Client {
  readonly files = new Map<string, string>();
  readonly requests: ControlledFileRequest[] = [];
  readonly sessionUpdates: acp.SessionNotification[] = [];
  readonly observations: ControlledFileRequestObservation[] = [];
  private readonly writeBehaviors: ControlledQueuedWriteBehavior[] = [];
  private readonly readBehaviors: ControlledReadBehavior[] = [];

  enqueueWriteBehavior(behavior: ControlledWriteBehavior): void {
    this.writeBehaviors.push(behavior);
  }

  enqueueReadBehavior(behavior: ControlledReadBehavior): void {
    this.readBehaviors.push(behavior);
  }

  enqueueReadPassThrough(): void {
    this.readBehaviors.push({ kind: 'pass-through' });
  }

  enqueueReadError(error: Error): void {
    this.readBehaviors.push({ kind: 'throw', error });
  }

  enqueueReadErrorAfter(count: number, error: Error): void {
    for (let index = 0; index < count; index += 1) {
      this.readBehaviors.push({ kind: 'pass-through' });
    }
    this.readBehaviors.push({ kind: 'throw', error });
  }

  enqueueBlockedWrite(): { release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.enqueueWriteBehavior({ kind: 'blocked', promise });
    return { release };
  }

  enqueueBlockedRead(): { release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.enqueueReadBehavior({ kind: 'blocked', promise });
    return { release };
  }

  enqueueObservedBlockedRead(input: {
    mode: ControlledObservedBlockedMode;
  }): ControlledObservedBlockedHandle {
    const outcome = deferred<void>();
    const behavior: ControlledObservedBlockedBehavior = {
      kind: 'observed-blocked',
      mode: input.mode,
      started: deferred<ControlledFileRequestObservation>(),
      outcome,
    };
    this.enqueueReadBehavior(behavior);
    return {
      started: behavior.started.promise,
      release: () => outcome.resolve(),
      reject: (error) => outcome.reject(error),
    };
  }

  enqueueObservedBlockedWrite(input: {
    mode: ControlledObservedBlockedMode;
  }): ControlledObservedBlockedHandle {
    const outcome = deferred<void>();
    const behavior: ControlledObservedBlockedBehavior = {
      kind: 'observed-blocked',
      mode: input.mode,
      started: deferred<ControlledFileRequestObservation>(),
      outcome,
    };
    this.writeBehaviors.push(behavior);
    return {
      started: behavior.started.promise,
      release: () => outcome.resolve(),
      reject: (error) => outcome.reject(error),
    };
  }

  pathIdentityFor(filePath: string): string {
    return createAcpRemoteConnectionPathIdentity(parseAcpRemotePath(filePath));
  }

  createApp(): acp.ClientApp {
    return acp
      .client({ name: 'blade-controlled-file-client' })
      .onRequest(acp.CLIENT_METHODS.session_request_permission, (ctx) =>
        this.requestPermission(ctx.params)
      )
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, (ctx) =>
        this.handleRead(ctx.params, ctx.requestId, ctx.signal)
      )
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, (ctx) =>
        this.handleWrite(ctx.params, ctx.requestId, ctx.signal)
      )
      .onNotification(acp.CLIENT_METHODS.session_update, (ctx) =>
        this.sessionUpdate(ctx.params)
      );
  }

  private createObservation(
    kind: ControlledFileRequestObservation['kind'],
    requestId: acp.JsonRpcId,
    signal: AbortSignal
  ): ControlledFileRequestObservation {
    const observation: ControlledFileRequestObservation = {
      kind,
      requestId,
      signal,
      cancelled: signal.aborted,
      settled: 'pending',
      settledAfterCancel: false,
    };
    signal.addEventListener(
      'abort',
      () => {
        observation.cancelled = true;
      },
      { once: true }
    );
    this.observations.push(observation);
    return observation;
  }

  private settleObservation(
    observation: ControlledFileRequestObservation,
    settled: ControlledFileRequestObservation['settled']
  ): void {
    observation.settled = settled;
    observation.settledAfterCancel = observation.cancelled;
  }

  private async awaitObservedBlockedBehavior(
    behavior: ControlledObservedBlockedBehavior,
    observation: ControlledFileRequestObservation
  ): Promise<void> {
    behavior.started.resolve(observation);
    if (behavior.mode === 'cooperate-with-cancel') {
      if (observation.signal.aborted) {
        throw observation.signal.reason ?? new Error('controlled request aborted');
      }
      let removeAbortListener = () => undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(observation.signal.reason ?? new Error('controlled request aborted'));
        };
        observation.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          observation.signal.removeEventListener('abort', onAbort);
        };
      });
      try {
        await Promise.race([behavior.outcome.promise, abortPromise]);
      } finally {
        removeAbortListener();
      }
      return;
    }
    await behavior.outcome.promise;
  }

  private async handleRead(
    params: acp.ReadTextFileRequest,
    requestId: acp.JsonRpcId,
    signal: AbortSignal
  ): Promise<acp.ReadTextFileResponse> {
    this.requests.push({ kind: 'read', request: params });
    const behavior = this.readBehaviors.shift();
    const observation = this.createObservation('read', requestId, signal);
    try {
      if (behavior?.kind === 'blocked') {
        await behavior.promise;
      }
      if (behavior?.kind === 'observed-blocked') {
        await this.awaitObservedBlockedBehavior(behavior, observation);
      }
      if (behavior?.kind === 'throw') {
        throw behavior.error;
      }
      const content = this.files.get(params.path);
      if (content === undefined) {
        throw RequestError.resourceNotFound(params.path);
      }
      this.settleObservation(observation, 'fulfilled');
      return { content };
    } catch (error) {
      this.settleObservation(observation, 'rejected');
      throw error;
    }
  }

  private async handleWrite(
    params: acp.WriteTextFileRequest,
    requestId: acp.JsonRpcId,
    signal: AbortSignal
  ): Promise<acp.WriteTextFileResponse> {
    this.requests.push({ kind: 'write', request: params });
    const behavior = this.writeBehaviors.shift() ?? { kind: 'apply-and-ack' };
    const observation = this.createObservation('write', requestId, signal);
    try {
      if (behavior.kind === 'blocked') {
        await behavior.promise;
        this.files.set(params.path, params.content);
        this.settleObservation(observation, 'fulfilled');
        return {};
      }
      if (behavior.kind === 'observed-blocked') {
        await this.awaitObservedBlockedBehavior(behavior, observation);
        this.files.set(params.path, params.content);
        this.settleObservation(observation, 'fulfilled');
        return {};
      }
      if (behavior.kind === 'apply-and-ack') {
        this.files.set(params.path, params.content);
        this.settleObservation(observation, 'fulfilled');
        return {};
      }
      if (behavior.kind === 'ack-without-apply') {
        this.settleObservation(observation, 'fulfilled');
        return {};
      }
      if (behavior.kind === 'ack-with-replacement') {
        this.files.set(params.path, behavior.content);
        this.settleObservation(observation, 'fulfilled');
        return {};
      }
      if (behavior.kind === 'apply-and-throw') {
        this.files.set(params.path, params.content);
        throw behavior.error;
      }
      if (behavior.kind === 'leave-old-and-throw') {
        throw behavior.error;
      }
      this.files.set(params.path, behavior.content);
      throw behavior.error;
    } catch (error) {
      this.settleObservation(observation, 'rejected');
      throw error;
    }
  }

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
    return this.handleRead(params, null, new AbortController().signal);
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    return this.handleWrite(params, null, new AbortController().signal);
  }
}
