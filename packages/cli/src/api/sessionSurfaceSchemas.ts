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

export const SessionSurfaceLocatorSchema = Runtime(
  Type.Union([
    StrictObject({
      kind: Type.Literal('local'),
      sessionId: Type.String({ minLength: 1 }),
      projectPath: Type.String({ minLength: 1 }),
    }),
    StrictObject({
      kind: Type.Literal('remote'),
      ref: SessionSurfaceRemoteRefSchema,
    }),
  ])
);
export type SessionSurfaceLocator = Static<typeof SessionSurfaceLocatorSchema>;

export const SessionSurfaceCapabilitiesSchema = Runtime(
  StrictObject({
    canOpen: Type.Boolean(),
    canSummarize: Type.Boolean(),
    canReadHistory: Type.Boolean(),
    canFork: Type.Boolean(),
    canListCatalog: Type.Boolean(),
  })
);
export type SessionSurfaceCapabilities = Static<
  typeof SessionSurfaceCapabilitiesSchema
>;

export const SessionSurfaceMessageSchema = Runtime(
  StrictObject({
    id: Type.String({ minLength: 1 }),
    role: StringEnum(['user', 'assistant', 'system', 'tool']),
    content: Type.String(),
    timestamp: Type.Number(),
    truncated: Type.Boolean(),
  })
);
export type SessionSurfaceMessage = Static<typeof SessionSurfaceMessageSchema>;

export const SessionSurfaceCatalogEntrySchema = Runtime(
  StrictObject({
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
  })
);
export type SessionSurfaceCatalogEntry = Static<
  typeof SessionSurfaceCatalogEntrySchema
>;

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
    }),
  })
);
export type SessionSurfaceErrorEnvelope = Static<
  typeof SessionSurfaceErrorEnvelopeSchema
>;

const SessionSurfaceLimitSchema = Type.Integer({ minimum: 1, maximum: 100 });

export const SessionSurfaceSummaryRequestSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
  })
);
export type SessionSurfaceSummaryRequest = Static<
  typeof SessionSurfaceSummaryRequestSchema
>;

export const SessionSurfaceSummaryResultSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    summary: Type.String(),
    capabilities: SessionSurfaceCapabilitiesSchema,
  })
);
export type SessionSurfaceSummaryResult = Static<
  typeof SessionSurfaceSummaryResultSchema
>;

export const SessionSurfaceOpenRequestSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
  })
);
export type SessionSurfaceOpenRequest = Static<typeof SessionSurfaceOpenRequestSchema>;

export const SessionSurfaceOpenResultSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    opened: Type.Boolean(),
    readOnly: Type.Boolean(),
    capabilities: SessionSurfaceCapabilitiesSchema,
  })
);
export type SessionSurfaceOpenResult = Static<typeof SessionSurfaceOpenResultSchema>;

export const SessionSurfaceHistoryRequestSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    limit: SessionSurfaceLimitSchema,
  })
);
export type SessionSurfaceHistoryRequest = Static<
  typeof SessionSurfaceHistoryRequestSchema
>;

export const SessionSurfaceHistoryResultSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    messages: Type.Array(SessionSurfaceMessageSchema),
    hasMore: Type.Boolean(),
  })
);
export type SessionSurfaceHistoryResult = Static<
  typeof SessionSurfaceHistoryResultSchema
>;

export const SessionSurfaceHistoryOpenRequestSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    cursor: Type.String({ minLength: 1 }),
    limit: SessionSurfaceLimitSchema,
  })
);
export type SessionSurfaceHistoryOpenRequest = Static<
  typeof SessionSurfaceHistoryOpenRequestSchema
>;

export const SessionSurfaceHistoryOpenResultSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    cursor: Type.String({ minLength: 1 }),
    messages: Type.Array(SessionSurfaceMessageSchema),
    hasMore: Type.Boolean(),
  })
);
export type SessionSurfaceHistoryOpenResult = Static<
  typeof SessionSurfaceHistoryOpenResultSchema
>;

export const SessionSurfaceCatalogRequestSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    limit: SessionSurfaceLimitSchema,
  })
);
export type SessionSurfaceCatalogRequest = Static<
  typeof SessionSurfaceCatalogRequestSchema
>;

export const SessionSurfaceCatalogResultSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    entries: Type.Array(SessionSurfaceCatalogEntrySchema),
    hasMore: Type.Boolean(),
  })
);
export type SessionSurfaceCatalogResult = Static<
  typeof SessionSurfaceCatalogResultSchema
>;

export const SessionSurfaceForkRequestSchema = Runtime(
  StrictObject({
    locator: SessionSurfaceLocatorSchema,
    message: SessionSurfaceMessageSchema,
  })
);
export type SessionSurfaceForkRequest = Static<typeof SessionSurfaceForkRequestSchema>;
