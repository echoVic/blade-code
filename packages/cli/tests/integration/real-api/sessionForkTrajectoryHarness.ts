import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEvent } from '../../../src/context/types.js';

export interface ForkFixture {
  workspace: string;
  storageRoot: string;
  nonce: string;
  resultPath: string;
}

interface ProviderRequestEvidence {
  method: string;
  pathname: string;
  bodyBytes: number;
}

interface ProviderProxyEvidence {
  upstream: { origin: string; pathname: string };
  requests: ProviderRequestEvidence[];
}

const fixtureRoots = new WeakMap<ForkFixture, string>();

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return sanitized || fallback;
}

export function createForkFixture(surface: string, model: string): ForkFixture {
  const prefix = [
    'blade-fork',
    sanitizeSegment(surface, 'surface'),
    sanitizeSegment(model, 'model'),
  ].join('-');
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const workspace = path.join(fixtureRoot, 'workspace');
  const storageRoot = path.join(fixtureRoot, 'storage');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(storageRoot, { recursive: true });
  const nonce = path
    .basename(fixtureRoot)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const fixture: ForkFixture = {
    workspace,
    storageRoot,
    nonce,
    resultPath: path.join(fixtureRoot, 'result.json'),
  };
  fixtureRoots.set(fixture, fixtureRoot);
  return fixture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function hasValidSessionInfo(data: Record<string, unknown>, partial: boolean): boolean {
  if (!partial) {
    if (
      !isString(data.sessionId) ||
      !isString(data.rootId) ||
      !isString(data.createdAt) ||
      !isString(data.updatedAt)
    ) {
      return false;
    }
  }
  return (
    isOptionalString(data.sessionId) &&
    isOptionalString(data.rootId) &&
    isOptionalString(data.parentId) &&
    (data.relationType === undefined ||
      data.relationType === 'subagent' ||
      data.relationType === 'fork') &&
    isOptionalString(data.title) &&
    (data.status === undefined ||
      data.status === 'running' ||
      data.status === 'completed' ||
      data.status === 'failed') &&
    isOptionalString(data.agentType) &&
    isOptionalString(data.model) &&
    isOptionalString(data.createdAt) &&
    isOptionalString(data.updatedAt)
  );
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  if (
    !isString(value.id) ||
    !isString(value.sessionId) ||
    !isString(value.timestamp) ||
    !isString(value.type) ||
    !isString(value.cwd) ||
    !isOptionalString(value.gitBranch) ||
    !isString(value.version)
  ) {
    return false;
  }

  const data = value.data;
  switch (value.type) {
    case 'session_created':
      return hasValidSessionInfo(data, false);
    case 'session_updated':
      return hasValidSessionInfo(data, true);
    case 'inbox_acknowledged':
      return (
        Array.isArray(data.messageIds) &&
        data.messageIds.every(isString) &&
        isString(data.acknowledgedAt)
      );
    case 'message_created':
      return (
        isString(data.messageId) &&
        ['user', 'assistant', 'system', 'tool'].includes(String(data.role)) &&
        isOptionalString(data.parentMessageId) &&
        isOptionalString(data.inboxMessageId) &&
        isString(data.createdAt)
      );
    case 'part_created':
    case 'part_updated':
      return (
        isString(data.partId) &&
        isString(data.messageId) &&
        [
          'text',
          'image',
          'tool_call',
          'tool_result',
          'diff',
          'patch',
          'summary',
          'subtask_ref',
        ].includes(String(data.partType)) &&
        Object.hasOwn(data, 'payload') &&
        isString(data.createdAt)
      );
    default:
      return false;
  }
}

export function readSessionEvents(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, 'utf8');
  const events: SessionEvent[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid session JSONL at ${filePath} line ${index + 1}`, {
        cause: error,
      });
    }
    if (!isSessionEvent(parsed)) {
      throw new Error(
        `Invalid session event schema at line ${index + 1} in ${filePath}`
      );
    }
    events.push(parsed);
  }
  return events;
}

export function findSessionTranscript(storageRoot: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)) {
    throw new Error(`Invalid session ID for transcript lookup: ${sessionId}`);
  }
  const projectsRoot = path.join(storageRoot, 'projects');
  let projectEntries: Dirent[];
  try {
    projectEntries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Session transcript ${sessionId} was not found under ${projectsRoot}`,
      { cause: error }
    );
  }
  const matches = projectEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name, `${sessionId}.jsonl`))
    .filter((candidate) => {
      try {
        return readFileSync(candidate).length >= 0;
      } catch {
        return false;
      }
    });

  if (matches.length === 0) {
    throw new Error(
      `Session transcript ${sessionId} was not found under ${projectsRoot}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Session transcript ${sessionId} has multiple matches under ${projectsRoot}`
    );
  }

  const transcriptPath = matches[0];
  if (!transcriptPath) {
    throw new Error(`Session transcript ${sessionId} lookup failed unexpectedly`);
  }
  const created = readSessionEvents(transcriptPath).find(
    (event): event is Extract<SessionEvent, { type: 'session_created' }> =>
      event.type === 'session_created'
  );
  if (created?.sessionId !== sessionId || created.data.sessionId !== sessionId) {
    throw new Error(
      `Session transcript ${sessionId} session_created sessionId does not match the requested ID`
    );
  }
  return transcriptPath;
}

export function assertForkLineage(
  events: SessionEvent[],
  expected: { childId: string; parentId: string; rootId: string }
): void {
  const created = events.find(
    (event): event is Extract<SessionEvent, { type: 'session_created' }> =>
      event.type === 'session_created'
  );
  if (!created) {
    throw new Error('Fork transcript is missing its durable session_created event');
  }
  if (
    created.sessionId !== expected.childId ||
    created.data.sessionId !== expected.childId
  ) {
    throw new Error(`Fork child session ID must be ${expected.childId}`);
  }
  if (created.data.parentId !== expected.parentId) {
    throw new Error(`Fork parent session ID must be ${expected.parentId}`);
  }
  if (created.data.rootId !== expected.rootId) {
    throw new Error(`Fork root session ID must be ${expected.rootId}`);
  }
  if (created.data.relationType !== 'fork') {
    throw new Error('Fork relation type must be fork');
  }
}

export function assertParentUnchanged(before: string, parentPath: string): void {
  if (readFileSync(parentPath, 'utf8') !== before) {
    throw new Error(`Parent transcript changed during fork: ${parentPath}`);
  }
}

function evidenceContainsSecret(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>
): boolean {
  if (typeof value === 'string') {
    return secrets.some((secret) => value.includes(secret));
  }
  if (typeof value === 'bigint') {
    return secrets.some((secret) => value.toString().includes(secret));
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  if (value instanceof Error) {
    return (
      evidenceContainsSecret(value.name, secrets, seen) ||
      evidenceContainsSecret(value.message, secrets, seen) ||
      evidenceContainsSecret(value.stack, secrets, seen) ||
      evidenceContainsSecret(value.cause, secrets, seen)
    );
  }
  if (value instanceof Map) {
    for (const [key, entryValue] of value) {
      if (
        evidenceContainsSecret(key, secrets, seen) ||
        evidenceContainsSecret(entryValue, secrets, seen)
      ) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    for (const entry of value) {
      if (evidenceContainsSecret(entry, secrets, seen)) return true;
    }
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (evidenceContainsSecret(key, secrets, seen)) {
      return true;
    }
    if (evidenceContainsSecret(entry, secrets, seen)) return true;
  }
  return false;
}

export function assertNoSecrets(evidence: unknown, secrets: readonly string[]): void {
  const nonEmptySecrets = secrets.filter(Boolean);
  if (evidenceContainsSecret(evidence, nonEmptySecrets, new WeakSet())) {
    throw new Error('Secret material was found in fork qualification evidence');
  }
}

export function cleanupForkFixture(fixture: ForkFixture): void {
  const fixtureRoot = fixtureRoots.get(fixture);
  if (!fixtureRoot) {
    throw new Error('Refusing to clean an unregistered fork fixture');
  }
  fixtureRoots.delete(fixture);
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function buildUpstreamUrl(upstream: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://blade-proxy.invalid');
  const upstreamUrl = new URL(upstream.href);
  upstreamUrl.pathname = [
    upstream.pathname.replace(/\/+$/, ''),
    incoming.pathname.replace(/^\/+/, ''),
  ]
    .filter(Boolean)
    .join('/');
  for (const [name, value] of incoming.searchParams) {
    upstreamUrl.searchParams.append(name, value);
  }
  return upstreamUrl;
}

async function readRequestBody(
  request: import('node:http').IncomingMessage
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function copyRequestHeaders(request: import('node:http').IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || name === 'host' || name === 'content-length') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function copyResponseHeaders(headers: Headers): Record<string, string> {
  const copied: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (
      ![
        'connection',
        'content-encoding',
        'content-length',
        'transfer-encoding',
      ].includes(name)
    ) {
      copied[name] = value;
    }
  });
  return copied;
}

async function writeResponseBody(
  body: ReadableStream<Uint8Array> | null,
  response: import('node:http').ServerResponse
): Promise<void> {
  if (!body) {
    response.end();
    return;
  }
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!response.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => {
            cleanup();
            resolve();
          };
          const onClose = (): void => {
            cleanup();
            reject(new Error('Provider proxy downstream closed during streaming'));
          };
          const cleanup = (): void => {
            response.off('drain', onDrain);
            response.off('close', onClose);
          };
          response.once('drain', onDrain);
          response.once('close', onClose);
        });
      }
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

export async function startHeldProviderProxy(upstreamBaseUrl: string): Promise<{
  baseUrl: string;
  requestHeld: Promise<void>;
  release(): void;
  close(): Promise<void>;
  redactedEvidence(): unknown;
}> {
  let upstream: URL;
  try {
    upstream = new URL(upstreamBaseUrl);
  } catch {
    throw new Error('Held provider proxy requires a valid upstream base URL');
  }
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error('Held provider proxy upstream must use HTTP or HTTPS');
  }
  const evidence: ProviderProxyEvidence = {
    upstream: { origin: upstream.origin, pathname: upstream.pathname },
    requests: [],
  };
  let resolveHeld: () => void = () => undefined;
  const requestHeld = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  let resolveGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let released = false;
  let firstRequestSeen = false;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const controllers = new Set<AbortController>();
  const release = (): void => {
    if (released) return;
    released = true;
    resolveGate();
  };

  const server = createServer((request, response) => {
    void (async () => {
      const requestBody = await readRequestBody(request);
      evidence.requests.push({
        method: request.method ?? 'POST',
        pathname: new URL(request.url ?? '/', 'http://blade-proxy.invalid').pathname,
        bodyBytes: requestBody.byteLength,
      });
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        resolveHeld();
        await gate;
      }
      if (closing || response.destroyed) return;

      const controller = new AbortController();
      controllers.add(controller);
      let responseComplete = false;
      const abortUpstream = (): void => {
        if (!responseComplete) controller.abort();
      };
      request.once('aborted', abortUpstream);
      response.once('close', abortUpstream);
      try {
        const method = request.method ?? 'POST';
        const upstreamResponse = await fetch(
          buildUpstreamUrl(upstream, request.url ?? '/'),
          {
            method,
            headers: copyRequestHeaders(request),
            body:
              method === 'GET' || method === 'HEAD' || requestBody.length === 0
                ? undefined
                : Uint8Array.from(requestBody),
            redirect: 'manual',
            signal: controller.signal,
          }
        );
        response.writeHead(
          upstreamResponse.status,
          copyResponseHeaders(upstreamResponse.headers)
        );
        await writeResponseBody(upstreamResponse.body, response);
        responseComplete = true;
      } finally {
        responseComplete = true;
        controllers.delete(controller);
        request.off('aborted', abortUpstream);
        response.off('close', abortUpstream);
      }
    })().catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: 'Provider proxy forwarding failed',
            type: 'proxy_error',
          },
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestHeld,
    release,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      release();
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closePromise;
    },
    redactedEvidence: () => ({
      upstream: { ...evidence.upstream },
      requests: evidence.requests.map((request) => ({ ...request })),
    }),
  };
}
