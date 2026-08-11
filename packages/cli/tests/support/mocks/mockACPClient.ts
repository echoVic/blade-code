/**
 * Mock ACP Client
 *
 * 用于测试 BladeAgent 和 Session，模拟 ACP 协议的 AgentSideConnection
 * 注意：这是一个简化的 mock，只实现了测试所需的基本功能
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';

interface MockTerminalRequest {
  command: string;
  cwd?: string;
  env?: Array<{ name: string; value: string }>;
}

interface MockTerminalHandle {
  terminalId: string;
  currentOutput(): Promise<{ output: string }>;
  waitForExit(): Promise<{ exitCode: number | null }>;
  kill(): Promise<void>;
  release(): Promise<void>;
}

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
  createTerminal(request: MockTerminalRequest): Promise<MockTerminalHandle>;
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
  public terminals: Map<
    string,
    {
      output: string[];
      child?: ChildProcess;
      exit: Promise<{ exitCode: number | null }>;
    }
  > = new Map();
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

  async createTerminal(request: MockTerminalRequest): Promise<MockTerminalHandle> {
    const terminalId = `terminal-${this.terminals.size + 1}`;
    const output: string[] = [];
    const environment = {
      ...process.env,
      ...Object.fromEntries(
        (request.env ?? []).map(({ name, value }) => [name, value])
      ),
    };
    const child = spawn(request.command, {
      cwd: request.cwd,
      env: environment,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const exit = new Promise<{ exitCode: number | null }>((resolve) => {
      child.once('exit', (exitCode) => resolve({ exitCode }));
      child.once('error', () => resolve({ exitCode: null }));
    });
    this.terminals.set(terminalId, { output, child, exit });
    return {
      terminalId,
      currentOutput: async () => ({ output: output.join('') }),
      waitForExit: () => exit,
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
        }
      },
      release: async () => {
        this.terminals.delete(terminalId);
      },
    };
  }

  async runTerminalCommand(
    terminalId: string,
    command: string
  ): Promise<{ exitCode: number; output: string }> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    if (terminal.child) {
      throw new Error('Terminal is already running a command');
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
    const terminal = this.terminals.get(terminalId);
    if (
      terminal?.child &&
      terminal.child.exitCode === null &&
      terminal.child.signalCode === null
    ) {
      terminal.child.kill('SIGTERM');
    }
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
    for (const terminal of this.terminals.values()) {
      if (
        terminal.child &&
        terminal.child.exitCode === null &&
        terminal.child.signalCode === null
      ) {
        terminal.child.kill('SIGTERM');
      }
    }
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
