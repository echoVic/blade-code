import { createHash } from 'node:crypto';
import { type Context, Hono } from 'hono';
import {
  type SessionLocatorV2,
  SessionLocatorV2Schema,
  SessionSurfaceCatalogPageSchema,
  type SessionSurfaceErrorCode,
  SessionSurfaceErrorEnvelopeSchema,
  SessionSurfaceForkRequestSchema,
  SessionSurfaceHistoryPageSchema,
  SessionSurfaceHistoryRequestSchema,
  SessionSurfaceOpenRequestSchema,
  SessionSurfaceOpenResultSchema,
} from '../../api/sessionSurfaceSchemas.js';
import type { SqliteDb } from '../../context/storage/sqlite/driver.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import {
  SessionSurfaceCursorRegistry,
  type SessionSurfaceCursorRegistryOptions,
} from '../../services/SessionSurfaceCursorRegistry.js';
import {
  SessionSurfaceService,
  SessionSurfaceServiceError,
} from '../../services/SessionSurfaceService.js';

type SurfaceKind = SessionLocatorV2['workspace']['kind'] | 'unknown';
type Variables = {
  directory: string;
  surfaceKind: SurfaceKind;
  surfaceLocatorDigest: string;
};
type SurfaceHttpStatus = 400 | 403 | 404 | 409 | 429 | 500 | 503;

interface SurfaceRouteLogger {
  debug(message: string): void;
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface SurfaceRouteService {
  listPage(options?: {
    archived?: boolean;
    cursor?: string;
    limit?: number;
    workspaceKind?: 'local' | 'acp-remote';
  }): Promise<unknown>;
  open(locator: SessionLocatorV2, options?: { limit?: number }): Promise<unknown>;
  historyPage(
    locator: SessionLocatorV2,
    options: { cursor: string; expectedSnapshot: string; limit?: number }
  ): Promise<unknown>;
  fork(locator: SessionLocatorV2): Promise<unknown>;
  close(reason?: string): Promise<void>;
}

export interface SessionSurfaceRouteControllerOptions {
  database?: SqliteDb | null;
  cursorRegistryOptions?: SessionSurfaceCursorRegistryOptions;
  service?: SurfaceRouteService;
  logger?: SurfaceRouteLogger;
}

export interface SessionSurfaceRouteController {
  app: Hono<{ Variables: Variables }>;
  getStats(): { accepting: boolean; active: number; cursors: number };
  shutdown(reason?: string): Promise<void>;
}

const STATUS_BY_CODE = {
  invalid_session_surface_request: 400,
  invalid_session_locator: 400,
  session_surface_not_found: 404,
  workspace_binding_mismatch: 409,
  session_surface_cursor_invalid: 400,
  session_surface_snapshot_changed: 409,
  session_surface_read_only: 409,
  session_surface_capability_unavailable: 403,
  session_surface_capacity: 429,
  session_surface_unavailable: 503,
  session_surface_state_invalid: 500,
} satisfies Record<SessionSurfaceErrorCode, SurfaceHttpStatus>;

const CatalogQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
    archived: Type.Optional(StringEnum(['true', 'false'])),
    workspaceKind: Type.Optional(StringEnum(['local', 'acp-remote'])),
  },
  { additionalProperties: false }
);

export const SESSION_SURFACE_MAX_REQUEST_BODY_BYTES = 64 * 1024;
const CATALOG_QUERY_KEYS = new Set(['cursor', 'limit', 'archived', 'workspaceKind']);
const OPEN_BODY_KEYS = new Set(['locator', 'limit']);
const HISTORY_BODY_KEYS = new Set(['locator', 'cursor', 'expectedSnapshot', 'limit']);
const FORK_BODY_KEYS = new Set(['locator']);
const LOCATOR_KEYS = new Set(['version', 'sessionId', 'workspace']);
const LOCATOR_WORKSPACE_KEYS = new Set(['kind', 'projectPath', 'workspaceRef']);
const routeLogger = createLogger(LogCategory.SERVICE);

export function createSessionSurfaceRouteController(
  options: SessionSurfaceRouteControllerOptions = {}
): SessionSurfaceRouteController {
  const registry = options.service
    ? undefined
    : new SessionSurfaceCursorRegistry(options.cursorRegistryOptions);
  const service =
    options.service ??
    new SessionSurfaceService({
      database: options.database,
      cursorRegistry: registry,
    });
  const logger = options.logger ?? routeLogger;
  const app = new Hono<{ Variables: Variables }>();
  let accepting = true;
  let active = 0;
  let shutdownPromise: Promise<void> | undefined;
  const idleWaiters = new Set<() => void>();

  const unavailable = () =>
    new SessionSurfaceServiceError('session_surface_unavailable');

  const waitForIdle = (): Promise<void> => {
    if (active === 0) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  };

  app.onError((error, context) => {
    const mapped = mapSurfaceError(error);
    logger.warn(
      `[SessionSurfaceRoutes] method=${context.req.method} path=${context.req.path} code=${mapped.error.code} kind=${context.get('surfaceKind') ?? 'unknown'} locator=${context.get('surfaceLocatorDigest') ?? 'none'}`
    );
    return context.json(mapped, STATUS_BY_CODE[mapped.error.code]);
  });

  app.use('*', async (context, next) => {
    context.set('surfaceKind', 'unknown');
    context.set('surfaceLocatorDigest', 'none');
    if (!accepting) {
      const mapped = toErrorEnvelope(unavailable());
      return context.json(mapped, STATUS_BY_CODE[mapped.error.code]);
    }
    active += 1;
    try {
      await next();
      if (!accepting) {
        const mapped = toErrorEnvelope(unavailable());
        context.res = context.json(mapped, STATUS_BY_CODE[mapped.error.code]);
      }
      return context.res;
    } finally {
      active -= 1;
      if (active === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  });

  app.get('/catalog', async (context) => {
    const query = parseCatalogQuery(context.req.url);
    const result = await service.listPage(query);
    return context.json(SessionSurfaceCatalogPageSchema.parse(result));
  });

  app.post('/open', async (context) => {
    assertNoQuery(context.req.url);
    const body = await readStrictJson(context.req.raw);
    assertObjectKeys(body, OPEN_BODY_KEYS, invalidRequest());
    const locator = parseLocatorFromBody(body);
    setLocatorLogContext(context, locator);
    const request = safeParseSchema(SessionSurfaceOpenRequestSchema, body);
    if (!request.success) throw invalidRequest();
    const result = await service.open(locator, { limit: request.data.limit });
    return context.json(SessionSurfaceOpenResultSchema.parse(result));
  });

  app.post('/history', async (context) => {
    assertNoQuery(context.req.url);
    const body = await readStrictJson(context.req.raw);
    assertObjectKeys(body, HISTORY_BODY_KEYS, invalidRequest());
    const locator = parseLocatorFromBody(body);
    setLocatorLogContext(context, locator);
    const request = safeParseSchema(SessionSurfaceHistoryRequestSchema, body);
    if (!request.success) throw invalidRequest();
    const result = await service.historyPage(locator, {
      cursor: request.data.cursor,
      expectedSnapshot: request.data.expectedSnapshot,
      limit: request.data.limit,
    });
    return context.json(SessionSurfaceHistoryPageSchema.parse(result));
  });

  app.post('/fork', async (context) => {
    assertNoQuery(context.req.url);
    const body = await readStrictJson(context.req.raw);
    assertObjectKeys(body, FORK_BODY_KEYS, invalidRequest());
    const locator = parseLocatorFromBody(body);
    setLocatorLogContext(context, locator);
    const request = safeParseSchema(SessionSurfaceForkRequestSchema, body);
    if (!request.success) throw invalidRequest();
    const result = await service.fork(locator);
    return context.json(SessionSurfaceOpenResultSchema.parse(result));
  });

  const shutdown = (reason = 'server-shutdown'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    accepting = false;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => service.close(reason)),
        waitForIdle(),
      ]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (rejected) throw rejected.reason;
    })();
    return shutdownPromise;
  };

  return {
    app,
    getStats: () => ({
      accepting,
      active,
      cursors: registry?.stats().entryCount ?? 0,
    }),
    shutdown,
  };
}

function invalidRequest(): SessionSurfaceServiceError {
  return new SessionSurfaceServiceError('invalid_session_surface_request');
}

function parseCatalogQuery(url: string): {
  archived?: boolean;
  cursor?: string;
  limit?: number;
  workspaceKind?: 'local' | 'acp-remote';
} {
  const values = new URL(url).searchParams;
  const flattened: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of values) {
    if (!CATALOG_QUERY_KEYS.has(key) || seen.has(key)) throw invalidRequest();
    seen.add(key);
    flattened[key] = value;
  }
  const parsed = safeParseSchema(CatalogQuerySchema, flattened);
  if (!parsed.success) throw invalidRequest();
  return {
    ...(parsed.data.archived !== undefined
      ? { archived: parsed.data.archived === 'true' }
      : {}),
    ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    ...(parsed.data.limit !== undefined ? { limit: Number(parsed.data.limit) } : {}),
    ...(parsed.data.workspaceKind !== undefined
      ? { workspaceKind: parsed.data.workspaceKind }
      : {}),
  };
}

function assertNoQuery(url: string): void {
  if (new URL(url).searchParams.size > 0) throw invalidRequest();
}

function assertObjectKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  error: SessionSurfaceServiceError
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error;
  if (Object.keys(value).some((key) => !allowed.has(key))) throw error;
}

function parseLocatorFromBody(body: unknown): SessionLocatorV2 {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest();
  }
  const locator = Reflect.get(body, 'locator');
  if (locator === undefined) throw invalidRequest();
  const invalidLocator = new SessionSurfaceServiceError('invalid_session_locator');
  assertObjectKeys(locator, LOCATOR_KEYS, invalidLocator);
  assertObjectKeys(
    Reflect.get(locator, 'workspace'),
    LOCATOR_WORKSPACE_KEYS,
    invalidLocator
  );
  const parsed = safeParseSchema(SessionLocatorV2Schema, locator);
  if (!parsed.success) {
    throw invalidLocator;
  }
  return parsed.data;
}

function setLocatorLogContext(
  context: Context<{ Variables: Variables }>,
  locator: SessionLocatorV2
): void {
  context.set('surfaceKind', locator.workspace.kind);
  context.set('surfaceLocatorDigest', digestSessionSurfaceLocator(locator));
}

async function readStrictJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > SESSION_SURFACE_MAX_REQUEST_BODY_BYTES)
  ) {
    throw invalidRequest();
  }
  const reader = request.body?.getReader();
  if (!reader) throw invalidRequest();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > SESSION_SURFACE_MAX_REQUEST_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The fixed invalid-request response remains authoritative.
        }
        throw invalidRequest();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const source = new TextDecoder().decode(bytes);
  if (!source) {
    throw invalidRequest();
  }
  try {
    assertNoDuplicateJsonObjectKeys(source);
    return JSON.parse(source) as unknown;
  } catch {
    throw invalidRequest();
  }
}

function assertNoDuplicateJsonObjectKeys(source: string): void {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1;
  };
  const readString = (): string => {
    const start = index;
    if (source[index] !== '"') throw new Error('expected string');
    index += 1;
    while (index < source.length) {
      const current = source[index];
      if (current === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (current === '"') {
        return JSON.parse(source.slice(start, index)) as string;
      }
    }
    throw new Error('unterminated string');
  };
  const readValue = (): void => {
    skipWhitespace();
    const current = source[index];
    if (current === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw new Error('duplicate key');
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ':') throw new Error('expected colon');
        index += 1;
        readValue();
        skipWhitespace();
        if (source[index] === '}') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new Error('expected comma');
        index += 1;
      }
      throw new Error('unterminated object');
    }
    if (current === '[') {
      index += 1;
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      while (index < source.length) {
        readValue();
        skipWhitespace();
        if (source[index] === ']') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new Error('expected comma');
        index += 1;
      }
      throw new Error('unterminated array');
    }
    if (current === '"') {
      readString();
      return;
    }
    const primitive =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        source.slice(index)
      )?.[0];
    if (!primitive) throw new Error('invalid primitive');
    index += primitive.length;
  };
  readValue();
  skipWhitespace();
  if (index !== source.length) throw new Error('trailing JSON');
}

function mapSurfaceError(error: unknown) {
  if (error instanceof SessionSurfaceServiceError) {
    return toErrorEnvelope(error);
  }
  return toErrorEnvelope(
    new SessionSurfaceServiceError('session_surface_state_invalid')
  );
}

function toErrorEnvelope(error: SessionSurfaceServiceError) {
  return SessionSurfaceErrorEnvelopeSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

function digestSessionSurfaceLocator(locator: SessionLocatorV2 | undefined): string {
  if (!locator) return 'none';
  return createHash('sha256')
    .update('session-surface-route-locator-v2\0')
    .update(JSON.stringify(locator))
    .digest('hex')
    .slice(0, 16);
}
