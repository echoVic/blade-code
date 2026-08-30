import type * as acp from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';

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

type ControlledReadBehavior =
  | { kind: 'pass-through' }
  | { kind: 'throw'; error: Error };

export class ControlledFileClient implements acp.Client {
  readonly files = new Map<string, string>();
  readonly requests: ControlledFileRequest[] = [];
  readonly sessionUpdates: acp.SessionNotification[] = [];
  private readonly writeBehaviors: ControlledWriteBehavior[] = [];
  private readonly readBehaviors: ControlledReadBehavior[] = [];

  enqueueWriteBehavior(behavior: ControlledWriteBehavior): void {
    this.writeBehaviors.push(behavior);
  }

  enqueueReadBehavior(behavior: ControlledReadBehavior): void {
    this.readBehaviors.push(behavior);
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
    this.requests.push({ kind: 'read', request: params });
    const behavior = this.readBehaviors.shift();
    if (behavior?.kind === 'throw') {
      throw behavior.error;
    }
    const content = this.files.get(params.path);
    if (content === undefined) {
      throw RequestError.resourceNotFound(params.path);
    }
    return { content };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    this.requests.push({ kind: 'write', request: params });
    const behavior = this.writeBehaviors.shift() ?? { kind: 'apply-and-ack' };
    if (behavior.kind === 'blocked') {
      await behavior.promise;
      this.files.set(params.path, params.content);
      return {};
    }
    if (behavior.kind === 'apply-and-ack') {
      this.files.set(params.path, params.content);
      return {};
    }
    if (behavior.kind === 'ack-without-apply') {
      return {};
    }
    if (behavior.kind === 'ack-with-replacement') {
      this.files.set(params.path, behavior.content);
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
  }
}
