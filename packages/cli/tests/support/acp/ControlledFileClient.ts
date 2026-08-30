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

export class ControlledFileClient implements acp.Client {
  readonly files = new Map<string, string>();
  readonly requests: ControlledFileRequest[] = [];
  readonly sessionUpdates: acp.SessionNotification[] = [];

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
    this.files.set(params.path, params.content);
    return {};
  }
}
