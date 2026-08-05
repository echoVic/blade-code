/**
 * Mock ACP Client
 *
 * 用于测试 BladeAgent 和 Session，模拟 ACP 协议的 AgentSideConnection
 * 注意：这是一个简化的 mock，只实现了测试所需的基本功能
 */

import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';

export interface MockPermissionResponse {
  outcome: {
    outcome: 'selected' | 'dismissed';
    optionId?: string;
  };
}

export interface MockACPClientInterface {
  readonly signal: AbortSignal;
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<MockPermissionResponse>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  createTerminal(): Promise<{ terminalId: string }>;
  runTerminalCommand(
    terminalId: string,
    command: string
  ): Promise<{ exitCode: number; output: string }>;
  getTerminalOutput(terminalId: string): Promise<string>;
  closeTerminal(terminalId: string): Promise<void>;
  showNotification(message: string): Promise<void>;
}

export class MockACPClient implements MockACPClientInterface {
  public readonly signal = new AbortController().signal;
  public sessionUpdates: SessionNotification[] = [];
  public permissionRequests: RequestPermissionRequest[] = [];
  public permissionResponses: Map<string, MockPermissionResponse> = new Map();
  public files: Map<string, string> = new Map();
  public terminals: Map<string, { output: string[] }> = new Map();
  public notifications: string[] = [];

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
    return Promise.resolve();
  }

  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<MockPermissionResponse> {
    this.permissionRequests.push(params);

    const toolCallId = params.toolCall.toolCallId;
    const response = this.permissionResponses.get(toolCallId) || {
      outcome: {
        outcome: 'selected' as const,
        optionId: 'allow_once',
      },
    };

    return Promise.resolve(response);
  }

  async readTextFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async createTerminal(): Promise<{ terminalId: string }> {
    const terminalId = `terminal-${this.terminals.size + 1}`;
    this.terminals.set(terminalId, { output: [] });
    return { terminalId };
  }

  async runTerminalCommand(
    terminalId: string,
    command: string
  ): Promise<{ exitCode: number; output: string }> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    const output = `Executed: ${command}`;
    terminal.output.push(output);
    return { exitCode: 0, output };
  }

  async getTerminalOutput(terminalId: string): Promise<string> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return terminal.output.join('\n');
  }

  async closeTerminal(terminalId: string): Promise<void> {
    this.terminals.delete(terminalId);
  }

  async showNotification(message: string): Promise<void> {
    this.notifications.push(message);
  }

  setPermissionResponse(toolCallId: string, response: MockPermissionResponse): void {
    this.permissionResponses.set(toolCallId, response);
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  clear(): void {
    this.sessionUpdates = [];
    this.permissionRequests = [];
    this.permissionResponses.clear();
    this.files.clear();
    this.terminals.clear();
    this.notifications = [];
  }

  getLastSessionUpdate(): SessionNotification | undefined {
    return this.sessionUpdates[this.sessionUpdates.length - 1];
  }

  getLastPermissionRequest(): RequestPermissionRequest | undefined {
    return this.permissionRequests[this.permissionRequests.length - 1];
  }
}

export function createMockACPClient(): MockACPClient {
  return new MockACPClient();
}
