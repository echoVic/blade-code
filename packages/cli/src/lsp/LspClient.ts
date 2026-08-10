import type { ChildProcess } from 'node:child_process';
import type {
  CancellationTokenSource,
  MessageConnection,
} from 'vscode-jsonrpc/node.js';
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol';
import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type OwnedProcessTree,
  spawnOwnedProcess,
} from '../utils/process/OwnedProcessTree.js';

const logger = createLogger(LogCategory.SERVICE);
const MAX_STDERR_CHARS = 64 * 1024;

type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface LspClientStartOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}

export class LspClient {
  private child?: ChildProcess;
  private processTree?: OwnedProcessTree;
  private connection?: MessageConnection;
  private closePromise?: Promise<void>;
  private crashCleanup?: Promise<void>;
  private capabilities?: ServerCapabilities;
  private initialized = false;
  private stopping = false;
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly requestHandlers = new Map<string, RequestHandler>();

  constructor(
    readonly name: string,
    private readonly onCrash: (error: Error) => void
  ) {}

  get serverCapabilities(): ServerCapabilities | undefined {
    return this.capabilities;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async start(options: LspClientStartOptions): Promise<void> {
    await this.crashCleanup;
    this.crashCleanup = undefined;
    if (this.connection) return;
    const rpc = await import('vscode-jsonrpc/node.js');
    const { child, processTree } = spawnOwnedProcess(
      options.command,
      [...options.args],
      {
        cwd: options.cwd,
        env: {
          ...options.environment,
          PATH: options.environment.PATH ?? process.env.PATH ?? '',
          HOME: options.environment.HOME ?? process.env.HOME ?? '',
          USER: options.environment.USER ?? process.env.USER ?? '',
          SHELL: options.environment.SHELL ?? process.env.SHELL ?? '/bin/sh',
          BLADE_CLI: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      { releaseOnExit: false }
    );
    this.child = child;
    this.processTree = processTree;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          child.removeListener('spawn', onSpawn);
          child.removeListener('error', onError);
        };
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
      if (!child.stdout || !child.stdin) {
        throw new Error('LSP server stdio is unavailable');
      }

      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) {
          stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
        }
      });
      child.stdin.on('error', (error) => {
        if (!this.stopping) {
          logger.debug(`[LSP ${this.name}] stdin closed: ${error.message}`);
        }
      });
      this.closePromise = new Promise<void>((resolve) => {
        child.once('close', (code, signal) => {
          this.initialized = false;
          const crashed = !this.stopping;
          if (!this.stopping) {
            const suffix = stderr.trim()
              ? `: ${stderr.trim().slice(0, 512)}`
              : signal
                ? ` (${signal})`
                : '';
            this.onCrash(
              new Error(`LSP server "${this.name}" exited with code ${code}${suffix}`)
            );
          }
          if (this.child === child) {
            const ownedTree = this.processTree;
            try {
              this.connection?.dispose();
            } catch {
              // The process exit remains authoritative.
            }
            this.connection = undefined;
            this.child = undefined;
            this.closePromise = undefined;
            if (crashed && ownedTree) {
              this.crashCleanup = ownedTree.terminate().then(() => undefined);
              this.processTree = undefined;
            }
          }
          resolve();
        });
      });

      const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(child.stdout),
        new rpc.StreamMessageWriter(child.stdin)
      );
      this.connection = connection;
      connection.onError(([error]) => {
        if (!this.stopping) {
          logger.warn(`[LSP ${this.name}] connection error: ${error.message}`);
        }
      });
      connection.onClose(() => {
        this.initialized = false;
      });
      for (const [method, handlers] of this.notificationHandlers) {
        for (const handler of handlers) {
          connection.onNotification(method, handler);
        }
      }
      for (const [method, handler] of this.requestHandlers) {
        connection.onRequest(method, handler);
      }
      connection.listen();
    } catch (error) {
      await this.disposeTransport();
      throw error;
    }
  }

  async initialize(
    params: InitializeParams,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<InitializeResult> {
    const result = await this.request<InitializeResult>(
      'initialize',
      params,
      timeoutMs,
      signal,
      false
    );
    this.capabilities = result.capabilities;
    await this.notify('initialized', {});
    this.initialized = true;
    return result;
  }

  async request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    requireInitialized = true
  ): Promise<TResult> {
    const connection = this.connection;
    if (!connection) throw new Error(`LSP server "${this.name}" is not started`);
    if (requireInitialized && !this.initialized) {
      throw new Error(`LSP server "${this.name}" is not initialized`);
    }
    const rpc = await import('vscode-jsonrpc/node.js');
    const cancellation = new rpc.CancellationTokenSource();
    return this.awaitRequest(
      connection.sendRequest<TResult>(method, params, cancellation.token),
      cancellation,
      timeoutMs,
      signal,
      method
    );
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.connection) throw new Error(`LSP server "${this.name}" is not started`);
    await this.connection.sendNotification(method, params);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
    this.connection?.onNotification(method, handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
    this.connection?.onRequest(method, handler);
  }

  async stop(timeoutMs: number): Promise<void> {
    if (!this.child && !this.connection) {
      await this.crashCleanup;
      this.crashCleanup = undefined;
      return;
    }
    this.stopping = true;
    const connection = this.connection;
    try {
      if (connection && this.initialized) {
        const rpc = await import('vscode-jsonrpc/node.js');
        const cancellation = new rpc.CancellationTokenSource();
        await this.awaitRequest(
          connection.sendRequest('shutdown', cancellation.token),
          cancellation,
          timeoutMs,
          undefined,
          'shutdown'
        ).catch(() => undefined);
        await connection.sendNotification('exit').catch(() => undefined);
      }
      await Promise.race([
        this.closePromise ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(timeoutMs, 500))),
      ]);
    } finally {
      await this.disposeTransport();
      this.stopping = false;
      this.initialized = false;
      this.capabilities = undefined;
    }
  }

  private awaitRequest<T>(
    request: Promise<T>,
    cancellation: CancellationTokenSource,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    method: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = () => {
        cancellation.cancel();
        finish(() => reject(new Error(`LSP request "${method}" was aborted`)));
      };
      const timer = setTimeout(() => {
        cancellation.cancel();
        finish(() =>
          reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`))
        );
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      request.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
    });
  }

  private async disposeTransport(): Promise<void> {
    const connection = this.connection;
    const processTree = this.processTree;
    this.connection = undefined;
    this.processTree = undefined;
    this.child = undefined;
    this.closePromise = undefined;
    try {
      connection?.dispose();
    } catch {
      // Process-tree termination below remains authoritative.
    }
    await processTree?.terminate();
    await this.crashCleanup;
    this.crashCleanup = undefined;
  }
}
