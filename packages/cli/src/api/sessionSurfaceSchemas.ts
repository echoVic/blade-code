import {
  Runtime,
  type Static,
  StringEnum,
  type TSchema,
  Type,
} from '../schema/index.js';

function StrictObject<T extends Record<string, TSchema>>(
  properties: T
): ReturnType<typeof Type.Object<T>> {
  return Type.Object(properties, { additionalProperties: false });
}

const SessionSurfaceRemoteRefSchema = Type.String({
  pattern: '^acp-remote-workspace:[A-Za-z0-9_-]{43}$',
});

const SessionSurfaceLimitSchema = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 100 })
);
const SessionIdSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$',
});

export const SessionLocatorV2Schema = Runtime(
  Type.Union([
    StrictObject({
      version: Type.Literal(2),
      sessionId: SessionIdSchema,
      workspace: StrictObject({
        kind: Type.Literal('local'),
        projectPath: Type.String({ minLength: 1 }),
      }),
    }),
    StrictObject({
      version: Type.Literal(2),
      sessionId: SessionIdSchema,
      workspace: StrictObject({
        kind: Type.Literal('acp-remote'),
        workspaceRef: SessionSurfaceRemoteRefSchema,
      }),
    }),
  ])
);
export type SessionLocatorV2 = Static<typeof SessionLocatorV2Schema>;

export const SurfaceUnavailableReasonSchema = Runtime(
  StringEnum([
    'history-only',
    'owner-offline',
    'owner-mismatch',
    'archived',
    'surface-not-supported',
    'capability-not-advertised',
  ])
);
export type SurfaceUnavailableReason = Static<typeof SurfaceUnavailableReasonSchema>;

export const SessionSurfaceCapabilitiesSchema = Runtime(
  StrictObject({
    connection: StringEnum(['local', 'online', 'offline']),
    history: StrictObject({
      read: Type.Boolean(),
      fork: Type.Boolean(),
    }),
    turn: StrictObject({
      start: Type.Boolean(),
      reason: Type.Optional(SurfaceUnavailableReasonSchema),
    }),
    files: StrictObject({
      readText: Type.Boolean(),
      writeText: Type.Boolean(),
      browse: StringEnum(['none', 'known-files', 'tree']),
      reason: Type.Optional(SurfaceUnavailableReasonSchema),
    }),
    terminal: StrictObject({
      mode: StringEnum(['none', 'command', 'interactive']),
      owner: StringEnum(['none', 'local', 'acp-remote']),
      reason: Type.Optional(SurfaceUnavailableReasonSchema),
    }),
  })
);
export type SessionSurfaceCapabilities = Static<
  typeof SessionSurfaceCapabilitiesSchema
>;

export const SessionSurfaceMessageSchema = Runtime(
  StrictObject({
    id: Type.String({ pattern: '^surface-message:[0-9]+:.+$' }),
    role: StringEnum(['user', 'assistant']),
    content: Type.String(),
    timestamp: Type.String({ minLength: 1 }),
    truncated: Type.Optional(Type.Boolean()),
  })
);
export type SessionSurfaceMessage = Static<typeof SessionSurfaceMessageSchema>;

const SessionTaskStatusSchema = StringEnum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const SessionSurfacePathStyleSchema = StringEnum(['posix', 'win32']);

const SessionSurfaceRelationTypeSchema = StringEnum(['subagent', 'fork']);

const SessionSurfaceCursorSchema = Type.String({ minLength: 1 });

const SessionSurfaceSnapshotSchema = Type.String({ minLength: 1 });
const SESSION_SURFACE_TIMESTAMP_MAX_LENGTH = 40;
const SESSION_SURFACE_ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;
const SESSION_SURFACE_CANONICAL_TIMESTAMP_PATTERN =
  '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T' +
  '(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}Z$';

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function canonicalizeSessionSurfaceTimestamp(
  value: string | undefined
): string | undefined {
  if (
    value === undefined ||
    value.length < 20 ||
    value.length > SESSION_SURFACE_TIMESTAMP_MAX_LENGTH
  ) {
    return undefined;
  }
  const match = SESSION_SURFACE_ISO_INSTANT_PATTERN.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  const offsetHour = Number(match[9]);
  const offsetMinute = Number(match[10]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offset !== 'Z' && (offsetHour > 23 || offsetMinute > 59))
  ) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const canonical = new Date(timestamp).toISOString();
  return canonical.length === 24 ? canonical : undefined;
}

const SessionSurfaceTaskCompletedAtSchema = Type.Refine(
  Type.String({
    minLength: 24,
    maxLength: 24,
    pattern: SESSION_SURFACE_CANONICAL_TIMESTAMP_PATTERN,
  }),
  (value) => canonicalizeSessionSurfaceTimestamp(value) === value,
  () => 'must be a canonical ISO instant'
);

export const SessionSurfaceSummarySchema = Runtime(
  StrictObject({
    locator: SessionLocatorV2Schema,
    displayCwd: Type.String({ minLength: 1 }),
    pathStyle: Type.Optional(SessionSurfacePathStyleSchema),
    title: Type.Optional(Type.String()),
    rootId: SessionIdSchema,
    parentId: Type.Optional(SessionIdSchema),
    relationType: Type.Optional(SessionSurfaceRelationTypeSchema),
    taskStatus: SessionTaskStatusSchema,
    taskCompletedAt: Type.Optional(SessionSurfaceTaskCompletedAtSchema),
    messageCount: Type.Integer({ minimum: 0 }),
    firstMessageTime: Type.String({ minLength: 1 }),
    lastMessageTime: Type.String({ minLength: 1 }),
    hasErrors: Type.Boolean(),
    archivedAt: Type.Optional(Type.String({ minLength: 1 })),
    selectedModelId: Type.Optional(Type.String({ minLength: 1 })),
    capabilities: SessionSurfaceCapabilitiesSchema,
  })
);
export type SessionSurfaceSummary = Static<typeof SessionSurfaceSummarySchema>;

export const SessionSurfaceErrorCodeSchema = Runtime(
  StringEnum([
    'invalid_session_surface_request',
    'invalid_session_locator',
    'session_surface_not_found',
    'workspace_binding_mismatch',
    'session_surface_cursor_invalid',
    'session_surface_snapshot_changed',
    'session_surface_read_only',
    'session_surface_capability_unavailable',
    'session_surface_capacity',
    'session_surface_unavailable',
    'session_surface_state_invalid',
  ])
);
export type SessionSurfaceErrorCode = Static<typeof SessionSurfaceErrorCodeSchema>;

export const SessionSurfaceErrorEnvelopeSchema = Runtime(
  StrictObject({
    error: StrictObject({
      code: SessionSurfaceErrorCodeSchema,
      message: Type.String({ minLength: 1 }),
      retryable: Type.Boolean(),
    }),
  })
);
export type SessionSurfaceErrorEnvelope = Static<
  typeof SessionSurfaceErrorEnvelopeSchema
>;

export const SessionSurfaceCatalogPageSchema = Runtime(
  StrictObject({
    sessions: Type.Array(SessionSurfaceSummarySchema),
    nextCursor: Type.Optional(SessionSurfaceCursorSchema),
  })
);
export type SessionSurfaceCatalogPage = Static<typeof SessionSurfaceCatalogPageSchema>;

export const SessionSurfaceHistoryPageSchema = Runtime(
  StrictObject({
    messages: Type.Array(SessionSurfaceMessageSchema),
    olderCursor: Type.Optional(SessionSurfaceCursorSchema),
    snapshot: SessionSurfaceSnapshotSchema,
    truncated: Type.Boolean(),
  })
);
export type SessionSurfaceHistoryPage = Static<typeof SessionSurfaceHistoryPageSchema>;
export type SessionSurfaceHistoryResult = SessionSurfaceHistoryPage;

export const SessionSurfaceOpenRequestSchema = Runtime(
  StrictObject({
    locator: SessionLocatorV2Schema,
    limit: SessionSurfaceLimitSchema,
  })
);
export type SessionSurfaceOpenRequest = Static<typeof SessionSurfaceOpenRequestSchema>;

export const SessionSurfaceOpenResultSchema = Runtime(
  StrictObject({
    session: SessionSurfaceSummarySchema,
    history: SessionSurfaceHistoryPageSchema,
  })
);
export type SessionSurfaceOpenResult = Static<typeof SessionSurfaceOpenResultSchema>;
export type SessionSurfaceForkResult = SessionSurfaceOpenResult;

export const SessionSurfaceHistoryRequestSchema = Runtime(
  StrictObject({
    locator: SessionLocatorV2Schema,
    cursor: SessionSurfaceCursorSchema,
    expectedSnapshot: SessionSurfaceSnapshotSchema,
    limit: SessionSurfaceLimitSchema,
  })
);
export type SessionSurfaceHistoryRequest = Static<
  typeof SessionSurfaceHistoryRequestSchema
>;

export const SessionSurfaceForkRequestSchema = Runtime(
  StrictObject({
    locator: SessionLocatorV2Schema,
  })
);
export type SessionSurfaceForkRequest = Static<typeof SessionSurfaceForkRequestSchema>;
