import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitializeParams } from 'vscode-languageserver-protocol';
import { LspClient } from '../../../src/lsp/LspClient.js';

const processState = vi.hoisted(() => ({
  spawnOwnedProcess: vi.fn(),
}));

const rpcState = vi.hoisted(() => ({
  createMessageConnection: vi.fn(),
}));

vi.mock('../../../src/utils/process/OwnedProcessTree.js', () => ({
  spawnOwnedProcess: processState.spawnOwnedProcess,
}));

vi.mock('vscode-jsonrpc/node.js', () => ({
  CancellationTokenSource: class {
    readonly token = {};
    cancel(): void {
      // Test double: requests settle synchronously.
    }
  },
  StreamMessageReader: class {
    constructor(_stream: unknown) {
      // Test double: transport parsing is outside this lifecycle test.
    }
  },
  StreamMessageWriter: class {
    constructor(_stream: unknown) {
      // Test double: transport serialization is outside this lifecycle test.
    }
  },
  createMessageConnection: rpcState.createMessageConnection,
}));

interface MockConnection {
  sendRequest: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onNotification: ReturnType<typeof vi.fn>;
  onRequest: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  emitClose: () => void;
}

interface MockSpawn {
  child: ChildProcess;
  processTree: {
    terminate: ReturnType<typeof vi.fn>;
  };
}

function createMockConnection(): MockConnection {
  let closeHandler: (() => void) | undefined;
  return {
    sendRequest: vi.fn(async (method: string) =>
      method === 'initialize' ? { capabilities: {} } : null
    ),
    sendNotification: vi.fn(async () => undefined),
    onError: vi.fn(),
    onClose: vi.fn((handler: () => void) => {
      closeHandler = handler;
    }),
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
    emitClose: () => closeHandler?.(),
  };
}

function createMockSpawn(pid: number): MockSpawn {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  return {
    child,
    processTree: {
      terminate: vi.fn(async () => ({
        success: true,
        alreadyExited: false,
        forced: true,
      })),
    },
  };
}

describe('LspClient transport generations', () => {
  const startOptions = {
    command: 'fake-lsp',
    args: [],
    cwd: '/workspace',
    environment: {},
  };
  let spawns: MockSpawn[];
  let connections: MockConnection[];

  beforeEach(() => {
    spawns = [createMockSpawn(101), createMockSpawn(102)];
    connections = [createMockConnection(), createMockConnection()];
    processState.spawnOwnedProcess.mockReset().mockImplementation(() => {
      const spawn = spawns.shift();
      if (!spawn) throw new Error('No mock LSP spawn available');
      queueMicrotask(() => spawn.child.emit('spawn'));
      return spawn;
    });
    rpcState.createMessageConnection.mockReset().mockImplementation(() => {
      const connection = connections.shift();
      if (!connection) throw new Error('No mock LSP connection available');
      return connection;
    });
  });

  it('ignores close events from a disposed transport after a new transport starts', async () => {
    const firstSpawn = spawns[0];
    const firstConnection = connections[0];
    const onCrash = vi.fn();
    const client = new LspClient('typescript', onCrash);

    await client.start(startOptions);
    await client.initialize({} as InitializeParams, 100);
    await client.stop(0);

    await client.start(startOptions);
    await client.initialize({} as InitializeParams, 100);
    expect(client.isInitialized).toBe(true);

    firstSpawn.child.emit('close', 0, null);
    firstConnection.emitClose();

    expect(onCrash).not.toHaveBeenCalled();
    expect(client.isInitialized).toBe(true);

    await client.stop(0);
  });
});
