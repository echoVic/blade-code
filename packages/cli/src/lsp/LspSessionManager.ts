import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  CallHierarchyItem,
  Diagnostic,
  InitializeParams,
  PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { isAcpMode } from '../acp/AcpServiceContext.js';
import type { LspServerConfig } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { ExecutionContext, ToolResult } from '../tools/types/index.js';
import { LspClient } from './LspClient.js';

const logger = createLogger(LogCategory.SERVICE);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIAGNOSTICS_PER_FILE = 10;
const MAX_TOTAL_DIAGNOSTICS = 30;
const CONTENT_MODIFIED = -32801;

type LspServerState = 'stopped' | 'starting' | 'running' | 'error' | 'stopping';

interface ManagedServer {
  name: string;
  config: LspServerConfig;
  client: LspClient;
  state: LspServerState;
  restartCount: number;
  startPromise?: Promise<void>;
  lastError?: string;
  openedFiles: Map<string, number>;
}

export interface DiagnosticPublication {
  sequence: number;
  serverName: string;
  filePath: string;
  diagnostics: Diagnostic[];
}

interface DiagnosticWaiter {
  afterSequence: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspServerStatus {
  name: string;
  state: LspServerState;
  restartCount: number;
  extensions: string[];
  lastError?: string;
}

export interface LspSessionManagerOptions {
  sessionId: string;
  workspaceRoot: string;
  environment: Readonly<Record<string, string>>;
  servers: Readonly<Record<string, LspServerConfig>>;
  isRemoteSession?: () => boolean;
}

export interface LspQuery {
  operation:
    | 'goToDefinition'
    | 'findReferences'
    | 'hover'
    | 'documentSymbol'
    | 'workspaceSymbol'
    | 'goToImplementation'
    | 'prepareCallHierarchy'
    | 'incomingCalls'
    | 'outgoingCalls'
    | 'diagnostics';
  filePath: string;
  line?: number;
  character?: number;
  query?: string;
}

export interface LspQueryResult {
  operation: LspQuery['operation'];
  filePath: string;
  result: unknown;
  serverName?: string;
}

export class LspSessionManager {
  private readonly workspaceRoot: string;
  private readonly servers = new Map<string, ManagedServer>();
  private readonly diagnostics = new Map<string, DiagnosticPublication>();
  private readonly delivered = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, DiagnosticWaiter[]>();
  private readonly disposeController = new AbortController();
  private diagnosticSequence = 0;
  private disposed = false;

  constructor(private readonly options: LspSessionManagerOptions) {
    const resolvedRoot = path.resolve(options.workspaceRoot);
    try {
      this.workspaceRoot = realpathSync.native(resolvedRoot);
    } catch {
      this.workspaceRoot = resolvedRoot;
    }
    for (const [name, config] of Object.entries(options.servers)) {
      if (config.enabled === false) continue;
      const server: ManagedServer = {
        name,
        config: structuredClone(config),
        state: 'stopped',
        restartCount: 0,
        openedFiles: new Map(),
        client: new LspClient(name, (error) => {
          server.state = 'error';
          server.lastError = error.message;
          server.openedFiles.clear();
        }),
      };
      server.client.onNotification('textDocument/publishDiagnostics', (params) => {
        this.captureDiagnostics(name, params);
      });
      server.client.onRequest('workspace/configuration', (params) =>
        this.resolveWorkspaceConfiguration(config.settings, params)
      );
      server.client.onRequest('workspace/workspaceFolders', () => [
        {
          uri: pathToFileURL(this.workspaceRoot).href,
          name: path.basename(this.workspaceRoot),
        },
      ]);
      server.client.onRequest('window/workDoneProgress/create', () => null);
      this.servers.set(name, server);
    }
  }

  get available(): boolean {
    return this.servers.size > 0 && !this.isRemoteSession() && !this.disposed;
  }

  get workspacePath(): string {
    return this.workspaceRoot;
  }

  getStatus(): LspServerStatus[] {
    return [...this.servers.values()]
      .map((server) => ({
        name: server.name,
        state: server.state,
        restartCount: server.restartCount,
        extensions: Object.keys(server.config.extensionToLanguage).sort(),
        ...(server.lastError ? { lastError: server.lastError } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async afterToolUse(
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult,
    context: ExecutionContext
  ): Promise<void> {
    if (!this.available || this.disposed) return;
    let preferredFile: string | undefined;
    if (
      result.success &&
      (toolName === 'Write' || toolName === 'Edit') &&
      typeof params.file_path === 'string'
    ) {
      preferredFile = await this.syncAfterWrite(params.file_path, context.signal);
    } else if (result.success && toolName === 'ApplyPatch') {
      const changes = Array.isArray(result.metadata?.changes)
        ? result.metadata.changes
        : [];
      for (const change of changes) {
        if (
          !change ||
          typeof change !== 'object' ||
          !('path' in change) ||
          typeof change.path !== 'string'
        ) {
          continue;
        }
        if ('newContent' in change && change.newContent === null) {
          await this.syncAfterDelete(change.path);
        } else {
          preferredFile =
            (await this.syncAfterWrite(change.path, context.signal)) ?? preferredFile;
        }
      }
    }
    this.attachPendingDiagnostics(result, preferredFile);
  }

  async query(input: LspQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    if (!this.available) {
      throw new Error(
        this.isRemoteSession()
          ? 'LSP is unavailable for ACP-owned remote files'
          : 'No LSP servers are configured for this Session'
      );
    }
    const filePath = await this.resolveFile(input.filePath);
    if (input.operation === 'diagnostics') {
      return {
        operation: input.operation,
        filePath,
        result: this.getCurrentDiagnostics(filePath),
      };
    }

    const server = await this.ensureFileOpen(filePath, undefined, signal);
    if (!server) {
      throw new Error(`No LSP server handles ${path.extname(filePath) || 'this file'}`);
    }
    const position = {
      line: Math.max(0, (input.line ?? 1) - 1),
      character: Math.max(0, (input.character ?? 1) - 1),
    };
    const textDocument = { uri: pathToFileURL(filePath).href };
    const methodAndParams: Record<
      Exclude<LspQuery['operation'], 'diagnostics' | 'incomingCalls' | 'outgoingCalls'>,
      { method: string; params: unknown }
    > = {
      goToDefinition: {
        method: 'textDocument/definition',
        params: { textDocument, position },
      },
      findReferences: {
        method: 'textDocument/references',
        params: {
          textDocument,
          position,
          context: { includeDeclaration: true },
        },
      },
      hover: {
        method: 'textDocument/hover',
        params: { textDocument, position },
      },
      documentSymbol: {
        method: 'textDocument/documentSymbol',
        params: { textDocument },
      },
      workspaceSymbol: {
        method: 'workspace/symbol',
        params: { query: input.query ?? '' },
      },
      goToImplementation: {
        method: 'textDocument/implementation',
        params: { textDocument, position },
      },
      prepareCallHierarchy: {
        method: 'textDocument/prepareCallHierarchy',
        params: { textDocument, position },
      },
    };

    let result: unknown;
    if (input.operation === 'incomingCalls' || input.operation === 'outgoingCalls') {
      const items = await this.requestWithRetry<CallHierarchyItem[] | null>(
        server,
        'textDocument/prepareCallHierarchy',
        { textDocument, position },
        signal
      );
      const item = items?.[0];
      result = item
        ? await this.requestWithRetry(
            server,
            input.operation === 'incomingCalls'
              ? 'callHierarchy/incomingCalls'
              : 'callHierarchy/outgoingCalls',
            { item },
            signal
          )
        : [];
    } else {
      const request = methodAndParams[input.operation];
      result = await this.requestWithRetry(
        server,
        request.method,
        request.params,
        signal
      );
    }
    return {
      operation: input.operation,
      filePath,
      serverName: server.name,
      result,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();
    for (const entries of this.waiters.values()) {
      for (const waiter of entries) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
    this.waiters.clear();
    await Promise.allSettled(
      [...this.servers.values()].map(async (server) => {
        server.state = 'stopping';
        await server.client.stop(server.config.shutdownTimeout ?? 2_000);
        server.state = 'stopped';
        server.openedFiles.clear();
      })
    );
    this.diagnostics.clear();
    this.delivered.clear();
  }

  private isRemoteSession(): boolean {
    return this.options.isRemoteSession?.() ?? isAcpMode(this.options.sessionId);
  }

  private selectServer(filePath: string): ManagedServer | undefined {
    const extension = path.extname(filePath).toLowerCase();
    return [...this.servers.values()]
      .filter((server) => extension in server.config.extensionToLanguage)
      .sort(
        (a, b) =>
          (b.config.priority ?? 0) - (a.config.priority ?? 0) ||
          a.name.localeCompare(b.name)
      )[0];
  }

  private async ensureFileOpen(
    filePath: string,
    knownContent?: string,
    signal?: AbortSignal
  ): Promise<ManagedServer | undefined> {
    const server = this.selectServer(filePath);
    if (!server) return undefined;
    await this.ensureStarted(server, signal);
    const uri = pathToFileURL(filePath).href;
    if (server.openedFiles.has(uri)) return server;
    const content = knownContent ?? (await this.readBoundedFile(filePath));
    await server.client.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId:
          server.config.extensionToLanguage[path.extname(filePath).toLowerCase()],
        version: 1,
        text: content,
      },
    });
    server.openedFiles.set(uri, 1);
    return server;
  }

  private async syncAfterWrite(
    rawFilePath: string,
    turnSignal?: AbortSignal
  ): Promise<string | undefined> {
    try {
      const filePath = await this.resolveFile(rawFilePath);
      const content = await this.readBoundedFile(filePath);
      const server = await this.ensureFileOpen(filePath, content, turnSignal);
      if (!server) return undefined;
      const uri = pathToFileURL(filePath).href;
      const beforeSequence = this.diagnostics.get(uri)?.sequence ?? 0;
      this.delivered.delete(uri);
      const previousVersion = server.openedFiles.get(uri) ?? 0;
      if (previousVersion > 0) {
        const version = previousVersion + 1;
        await server.client.notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text: content }],
        });
        server.openedFiles.set(uri, version);
      }
      await server.client.notify('textDocument/didSave', {
        textDocument: { uri },
        text: content,
      });
      await this.waitForDiagnostics(
        uri,
        beforeSequence,
        server.config.diagnosticWaitTimeout ?? 750,
        turnSignal
      );
      return filePath;
    } catch (error) {
      if (!turnSignal?.aborted && !this.disposeController.signal.aborted) {
        logger.debug(
          `[LSP] post-edit sync skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return undefined;
    }
  }

  private async syncAfterDelete(rawFilePath: string): Promise<void> {
    const filePath = await this.resolveMissingFile(rawFilePath).catch(() => undefined);
    if (!filePath) return;
    if (!this.isInsideWorkspace(filePath)) return;
    const uri = pathToFileURL(filePath).href;
    for (const server of this.servers.values()) {
      if (!server.openedFiles.has(uri)) continue;
      await server.client
        .notify('textDocument/didClose', {
          textDocument: { uri },
        })
        .catch(() => undefined);
      server.openedFiles.delete(uri);
    }
    this.diagnostics.delete(uri);
    this.delivered.delete(uri);
  }

  private async ensureStarted(
    server: ManagedServer,
    signal?: AbortSignal
  ): Promise<void> {
    if (server.state === 'running') return;
    if (server.startPromise) return server.startPromise;
    if (server.state === 'error') {
      if (server.restartCount >= (server.config.maxRestarts ?? 3)) {
        throw new Error(`LSP server "${server.name}" exceeded its restart limit`);
      }
      server.restartCount++;
    }
    const start = this.startServer(server, signal).finally(() => {
      server.startPromise = undefined;
    });
    server.startPromise = start;
    return start;
  }

  private async startServer(
    server: ManagedServer,
    signal?: AbortSignal
  ): Promise<void> {
    server.state = 'starting';
    try {
      await server.client.start({
        command: server.config.command,
        args: server.config.args ?? [],
        cwd: this.workspaceRoot,
        environment: {
          ...this.options.environment,
          ...server.config.env,
          BLADE_SESSION_ID: this.options.sessionId,
        },
      });
      const workspaceUri = pathToFileURL(this.workspaceRoot).href;
      const params: InitializeParams = {
        processId: process.pid,
        rootPath: this.workspaceRoot,
        rootUri: workspaceUri,
        workspaceFolders: [
          { uri: workspaceUri, name: path.basename(this.workspaceRoot) },
        ],
        initializationOptions: server.config.initializationOptions ?? {},
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
            symbol: { dynamicRegistration: false },
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            implementation: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: { dynamicRegistration: false },
          },
          general: { positionEncodings: ['utf-16'] },
        },
      };
      await server.client.initialize(
        params,
        server.config.startupTimeout ?? 10_000,
        signal
      );
      if (server.config.settings !== undefined) {
        await server.client.notify('workspace/didChangeConfiguration', {
          settings: server.config.settings,
        });
      }
      server.state = 'running';
      server.lastError = undefined;
    } catch (error) {
      server.state = 'error';
      server.lastError = error instanceof Error ? error.message : String(error);
      await server.client
        .stop(server.config.shutdownTimeout ?? 2_000)
        .catch(() => undefined);
      throw error;
    }
  }

  private async requestWithRetry<T = unknown>(
    server: ManagedServer,
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await server.client.request<T>(
          method,
          params,
          server.config.requestTimeout ?? 10_000,
          signal
        );
      } catch (error) {
        lastError = error;
        if ((error as { code?: unknown }).code !== CONTENT_MODIFIED || attempt === 3) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private captureDiagnostics(serverName: string, value: unknown): void {
    if (
      this.disposed ||
      !value ||
      typeof value !== 'object' ||
      !('uri' in value) ||
      !('diagnostics' in value)
    ) {
      return;
    }
    const params = value as PublishDiagnosticsParams;
    if (!Array.isArray(params.diagnostics)) return;
    let filePath: string;
    try {
      filePath = params.uri.startsWith('file:')
        ? fileURLToPath(params.uri)
        : path.resolve(params.uri);
    } catch {
      return;
    }
    if (!this.isInsideWorkspace(filePath)) return;
    const uri = pathToFileURL(path.resolve(filePath)).href;
    const publication: DiagnosticPublication = {
      sequence: ++this.diagnosticSequence,
      serverName,
      filePath: path.resolve(filePath),
      diagnostics: params.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic &&
            typeof diagnostic.message === 'string' &&
            diagnostic.range !== undefined
        )
        .slice(0, 100)
        .map((diagnostic) => structuredClone(diagnostic)),
    };
    this.diagnostics.set(uri, publication);
    const waiters = this.waiters.get(uri) ?? [];
    const remaining: DiagnosticWaiter[] = [];
    for (const waiter of waiters) {
      if (publication.sequence > waiter.afterSequence) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length > 0) this.waiters.set(uri, remaining);
    else this.waiters.delete(uri);
  }

  private waitForDiagnostics(
    uri: string,
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (timeoutMs === 0 || (this.diagnostics.get(uri)?.sequence ?? 0) > afterSequence) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let waiter: DiagnosticWaiter;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', finish);
        const remaining = (this.waiters.get(uri) ?? []).filter(
          (entry) => entry !== waiter
        );
        if (remaining.length > 0) this.waiters.set(uri, remaining);
        else this.waiters.delete(uri);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiter = {
        afterSequence,
        resolve: finish,
        timer,
      };
      const entries = this.waiters.get(uri) ?? [];
      entries.push(waiter);
      this.waiters.set(uri, entries);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  private attachPendingDiagnostics(result: ToolResult, preferredFile?: string): void {
    const publications = [...this.diagnostics.values()].sort((a, b) => {
      if (preferredFile) {
        if (a.filePath === preferredFile && b.filePath !== preferredFile) return -1;
        if (b.filePath === preferredFile && a.filePath !== preferredFile) return 1;
      }
      return b.sequence - a.sequence;
    });
    const lines: string[] = [];
    const metadata: Array<Record<string, unknown>> = [];
    let count = 0;
    for (const publication of publications) {
      const uri = pathToFileURL(publication.filePath).href;
      const delivered = this.delivered.get(uri) ?? new Set<string>();
      const fresh = publication.diagnostics
        .sort((a, b) => (a.severity ?? 4) - (b.severity ?? 4))
        .filter((diagnostic) => !delivered.has(this.diagnosticKey(diagnostic)))
        .slice(0, Math.min(MAX_DIAGNOSTICS_PER_FILE, MAX_TOTAL_DIAGNOSTICS - count));
      if (fresh.length === 0) continue;
      const relative = path.relative(this.workspaceRoot, publication.filePath);
      lines.push(`${relative}:`);
      for (const diagnostic of fresh) {
        const line = diagnostic.range.start.line + 1;
        const character = diagnostic.range.start.character + 1;
        const severity = ['Error', 'Warning', 'Info', 'Hint'][
          (diagnostic.severity ?? 1) - 1
        ];
        const message = diagnostic.message.replace(/\s+/g, ' ').slice(0, 500);
        lines.push(
          `  ${severity ?? 'Error'} ${line}:${character} ${message}` +
            (diagnostic.code !== undefined ? ` [${String(diagnostic.code)}]` : '')
        );
        delivered.add(this.diagnosticKey(diagnostic));
        metadata.push({
          file: relative,
          line,
          character,
          severity: severity ?? 'Error',
          message,
          server: publication.serverName,
        });
        count++;
      }
      this.delivered.set(uri, delivered);
      if (count >= MAX_TOTAL_DIAGNOSTICS) break;
    }
    if (lines.length === 0) return;
    const current =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : JSON.stringify(result.llmContent);
    result.llmContent =
      `${current}\n\n<new-diagnostics>\n` +
      `LSP reported new issues after this operation:\n${lines.join('\n')}\n` +
      '</new-diagnostics>';
    result.metadata = {
      ...result.metadata,
      lsp_diagnostics: metadata,
      lsp_diagnostic_count: metadata.length,
    };
  }

  private getCurrentDiagnostics(filePath: string): DiagnosticPublication | null {
    return this.diagnostics.get(pathToFileURL(path.resolve(filePath)).href) ?? null;
  }

  private diagnosticKey(diagnostic: Diagnostic): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          range: diagnostic.range,
          severity: diagnostic.severity,
          code: diagnostic.code,
          source: diagnostic.source,
          message: diagnostic.message,
        })
      )
      .digest('hex');
  }

  private async readBoundedFile(filePath: string): Promise<string> {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error(`LSP target is not a file: ${filePath}`);
    if (stats.size > MAX_FILE_BYTES) {
      throw new Error('LSP target exceeds the 10 MiB file limit');
    }
    return fs.readFile(filePath, 'utf8');
  }

  private async resolveFile(rawFilePath: string): Promise<string> {
    const absolute = path.isAbsolute(rawFilePath)
      ? path.resolve(rawFilePath)
      : path.resolve(this.workspaceRoot, rawFilePath);
    const canonical = await fs.realpath(absolute);
    if (!this.isInsideWorkspace(canonical)) {
      throw new Error('LSP target resolves outside the Session workspace');
    }
    return canonical;
  }

  private async resolveMissingFile(rawFilePath: string): Promise<string> {
    const absolute = path.isAbsolute(rawFilePath)
      ? path.resolve(rawFilePath)
      : path.resolve(this.workspaceRoot, rawFilePath);
    const missing: string[] = [];
    let current = absolute;
    while (true) {
      try {
        const ancestor = await fs.realpath(current);
        const canonical = path.join(ancestor, ...missing.reverse());
        if (!this.isInsideWorkspace(canonical)) {
          throw new Error('LSP target resolves outside the Session workspace');
        }
        return canonical;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error('Cannot resolve deleted LSP target');
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }

  private isInsideWorkspace(candidate: string): boolean {
    const relative = path.relative(this.workspaceRoot, path.resolve(candidate));
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative))
    );
  }

  private resolveWorkspaceConfiguration(settings: unknown, params: unknown): unknown[] {
    const items =
      params &&
      typeof params === 'object' &&
      'items' in params &&
      Array.isArray((params as { items?: unknown }).items)
        ? (params as { items: Array<{ section?: unknown }> }).items
        : [];
    return items.map((item) => {
      if (
        typeof item.section !== 'string' ||
        !settings ||
        typeof settings !== 'object'
      ) {
        return settings ?? null;
      }
      let current: unknown = settings;
      for (const segment of item.section.split('.')) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
          return null;
        }
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    });
  }
}
