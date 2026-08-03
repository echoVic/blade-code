import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
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
const cleanedFixtures = new WeakSet<ForkFixture>();
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

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
        isString(data.role) &&
        ['user', 'assistant', 'system', 'tool'].includes(data.role) &&
        isOptionalString(data.parentMessageId) &&
        isOptionalString(data.inboxMessageId) &&
        isString(data.createdAt)
      );
    case 'part_created':
    case 'part_updated':
      return (
        isString(data.partId) &&
        isString(data.messageId) &&
        isString(data.partType) &&
        [
          'text',
          'image',
          'tool_call',
          'tool_result',
          'diff',
          'patch',
          'summary',
          'subtask_ref',
        ].includes(data.partType) &&
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
  const lines = content.split(/\r?\n/);
  const lastDurableLine = lines.findLastIndex((line) => Boolean(line.trim()));
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      if (index < lastDurableLine) {
        throw new Error(
          `Blank line inside durable session JSONL at ${filePath} line ${index + 1}`
        );
      }
      continue;
    }
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
  const createdEvents = events.filter(
    (event): event is Extract<SessionEvent, { type: 'session_created' }> =>
      event.type === 'session_created'
  );
  if (createdEvents.length !== 1) {
    throw new Error('Fork transcript must contain exactly one session_created event');
  }
  const created = createdEvents[0];
  if (events[0] !== created) {
    throw new Error('Fork transcript session_created event must be first');
  }
  for (const [index, event] of events.entries()) {
    if (event.sessionId !== expected.childId) {
      throw new Error(
        `Fork child event ${index + 1} session ID must be ${expected.childId}`
      );
    }
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

  const matchesOptionalLineage = (
    event: Extract<SessionEvent, { type: 'session_updated' }>
  ): boolean =>
    (event.data.sessionId === undefined || event.data.sessionId === expected.childId) &&
    (event.data.rootId === undefined || event.data.rootId === expected.rootId) &&
    (event.data.parentId === undefined || event.data.parentId === expected.parentId) &&
    (event.data.relationType === undefined || event.data.relationType === 'fork');
  for (const event of events) {
    if (event.type === 'session_updated' && !matchesOptionalLineage(event)) {
      throw new Error('Fork session_updated event contains conflicting lineage');
    }
  }

  const boundary = events.find(
    (event): event is Extract<SessionEvent, { type: 'session_updated' }> =>
      event.type === 'session_updated' &&
      event.data.sessionId === expected.childId &&
      event.data.rootId === expected.rootId &&
      event.data.parentId === expected.parentId &&
      event.data.relationType === 'fork'
  );
  if (!boundary) {
    throw new Error('Fork transcript must contain a complete fork boundary lineage');
  }
}

export function assertParentUnchanged(before: string, parentPath: string): void {
  if (readFileSync(parentPath, 'utf8') !== before) {
    throw new Error(`Parent transcript changed during fork: ${parentPath}`);
  }
}

interface SecretEvidenceMatch {
  secretIndex: number;
  path: string;
}

interface IndexedSecret {
  value: string;
  originalIndex: number;
}

function secretMatchAt(
  value: string,
  secrets: readonly IndexedSecret[],
  path: string
): SecretEvidenceMatch | undefined {
  const secret = secrets.find((candidate) => value.includes(candidate.value));
  return secret ? { secretIndex: secret.originalIndex, path } : undefined;
}

function findSecretEvidence(
  value: unknown,
  secrets: readonly IndexedSecret[],
  seen: WeakSet<object>,
  evidencePath: string
): SecretEvidenceMatch | undefined {
  if (typeof value === 'string') {
    return secretMatchAt(value, secrets, evidencePath);
  }
  if (typeof value === 'bigint') {
    return secretMatchAt(value.toString(), secrets, evidencePath);
  }
  if (value instanceof Uint8Array) {
    return secretMatchAt(Buffer.from(value).toString('utf8'), secrets, evidencePath);
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (value instanceof Error) {
    const nameMatch = secretMatchAt(value.name, secrets, `${evidencePath}.name`);
    if (nameMatch) return nameMatch;
  }

  if (value instanceof Map) {
    let index = 0;
    for (const [key, entryValue] of value) {
      const entryPath = `${evidencePath}.map[${index}]`;
      const match =
        findSecretEvidence(key, secrets, seen, `${entryPath}.key`) ??
        findSecretEvidence(entryValue, secrets, seen, `${entryPath}.value`);
      if (match) return match;
      index++;
    }
    return undefined;
  }
  if (value instanceof Set) {
    let index = 0;
    for (const entry of value) {
      const match = findSecretEvidence(
        entry,
        secrets,
        seen,
        `${evidencePath}.set[${index}]`
      );
      if (match) return match;
      index++;
    }
    return undefined;
  }
  let keys: Array<string | symbol>;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`Unable to inspect evidence at ${evidencePath}`);
  }
  for (const [propertyIndex, key] of keys.entries()) {
    const keyText = typeof key === 'symbol' ? key.description : key;
    const keyPath =
      typeof key === 'symbol'
        ? `${evidencePath}.[symbol#${propertyIndex}]`
        : `${evidencePath}.[key#${propertyIndex}]`;
    if (keyText) {
      const keyMatch = secretMatchAt(keyText, secrets, keyPath);
      if (keyMatch) return keyMatch;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error(`Unable to inspect evidence at ${evidencePath}`);
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
    const entryPath = typeof key === 'symbol' ? keyPath : `${evidencePath}.${key}`;
    const match = findSecretEvidence(descriptor.value, secrets, seen, entryPath);
    if (match) return match;
  }
  return undefined;
}

export function assertNoSecrets(evidence: unknown, secrets: readonly string[]): void {
  const nonEmptySecrets = secrets.flatMap((value, originalIndex) =>
    value ? [{ value, originalIndex }] : []
  );
  const match = findSecretEvidence(evidence, nonEmptySecrets, new WeakSet(), '$');
  if (match) {
    throw new Error(`Secret material #${match.secretIndex + 1} found at ${match.path}`);
  }
}

export function cleanupForkFixture(fixture: ForkFixture): void {
  if (cleanedFixtures.has(fixture)) return;
  const fixtureRoot = fixtureRoots.get(fixture);
  if (!fixtureRoot) {
    throw new Error('Refusing to clean an unregistered fork fixture');
  }
  fixtureRoots.delete(fixture);
  cleanedFixtures.add(fixture);
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

function connectionHeaderNames(value: string | string[] | undefined): Set<string> {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(
    values
      .flatMap((entry) => entry.split(','))
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

function copyRequestHeaders(request: import('node:http').IncomingMessage): Headers {
  const headers = new Headers();
  const dynamicHopHeaders = connectionHeaderNames(request.headers.connection);
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      !value ||
      normalizedName === 'host' ||
      normalizedName === 'content-length' ||
      HOP_BY_HOP_HEADERS.has(normalizedName) ||
      dynamicHopHeaders.has(normalizedName)
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function copyResponseHeaders(headers: Headers): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  const dynamicHopHeaders = connectionHeaderNames(
    headers.get('connection') ?? undefined
  );
  headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalizedName) &&
      !dynamicHopHeaders.has(normalizedName) &&
      normalizedName !== 'content-encoding' &&
      normalizedName !== 'content-length'
    ) {
      copied[name] = value;
    }
  });
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) copied['set-cookie'] = setCookies;
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
  let rejectHeld: (reason: Error) => void = () => undefined;
  const requestHeld = new Promise<void>((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });
  void requestHeld.catch(() => undefined);
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
      if (!firstRequestSeen) {
        rejectHeld(new Error('Held provider proxy closed before first request'));
      }
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
