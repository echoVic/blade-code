import {
  type SafeParseResult,
  type Static,
  StringEnum,
  safeParseSchema,
  Type,
} from '../schema/index.js';

const pluginNameSchema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$',
});

const semverSchema = Type.String({
  pattern: '^\\d+\\.\\d+\\.\\d+(-[\\w.]+)?(\\+[\\w.]+)?$',
});

const pluginAuthorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.Optional(Type.String({ format: 'email' })),
  url: Type.Optional(Type.String({ format: 'uri' })),
});

export const pluginManifestSchema = Type.Object({
  name: pluginNameSchema,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  version: semverSchema,
  author: Type.Optional(pluginAuthorSchema),
  license: Type.Optional(Type.String()),
  repository: Type.Optional(Type.String({ format: 'uri' })),
  homepage: Type.Optional(Type.String({ format: 'uri' })),
  keywords: Type.Optional(Type.Array(Type.String())),
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  bladeVersion: Type.Optional(Type.String()),
});

const pluginInstallSourceSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('git'),
      url: Type.String({ minLength: 1 }),
      ref: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('local'),
      path: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('marketplace'),
      marketplace: pluginNameSchema,
    },
    { additionalProperties: false }
  ),
]);

const installedPluginRecordSchema = Type.Object(
  {
    name: pluginNameSchema,
    source: pluginInstallSourceSchema,
    installPath: Type.String({ minLength: 1 }),
    version: semverSchema,
    revision: Type.String({ minLength: 1, maxLength: 128 }),
    contentDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    installedAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

const pluginMarketplaceSourceSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('git'),
      url: Type.String({ minLength: 1 }),
      ref: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('local'),
      path: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
]);

const pluginMarketplaceRecordSchema = Type.Object(
  {
    name: pluginNameSchema,
    source: pluginMarketplaceSourceSchema,
    installPath: Type.String({ minLength: 1 }),
    revision: Type.String({ minLength: 1, maxLength: 128 }),
    contentDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    addedAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const pluginPackageStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    installed: Type.Record(Type.String(), installedPluginRecordSchema),
    marketplaces: Type.Record(Type.String(), pluginMarketplaceRecordSchema),
  },
  { additionalProperties: false }
);

const marketplaceAuthorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.Optional(Type.String({ format: 'email' })),
  url: Type.Optional(Type.String({ format: 'uri' })),
});

const marketplaceEntrySchema = Type.Object({
  name: pluginNameSchema,
  description: Type.Optional(Type.String({ maxLength: 500 })),
  version: Type.Optional(semverSchema),
  author: Type.Optional(
    Type.Union([Type.String({ minLength: 1 }), marketplaceAuthorSchema])
  ),
  source: Type.Union([
    Type.String({ minLength: 1 }),
    Type.Object({
      source: Type.Literal('url'),
      url: Type.String({ minLength: 1 }),
      ref: Type.Optional(Type.String({ minLength: 1 })),
      sha: Type.Optional(Type.String({ pattern: '^[a-fA-F0-9]{40}$' })),
    }),
  ]),
  category: Type.Optional(Type.String()),
  homepage: Type.Optional(Type.String({ format: 'uri' })),
  tags: Type.Optional(Type.Array(Type.String())),
});

export const pluginMarketplaceManifestSchema = Type.Object({
  name: pluginNameSchema,
  description: Type.Optional(Type.String({ maxLength: 500 })),
  owner: Type.Optional(marketplaceAuthorSchema),
  metadata: Type.Optional(
    Type.Object({
      description: Type.Optional(Type.String({ maxLength: 500 })),
      version: Type.Optional(Type.String()),
    })
  ),
  plugins: Type.Array(marketplaceEntrySchema, { maxItems: 5000 }),
});

const mcpServerConfigSchema = Type.Object({
  type: StringEnum(['stdio', 'sse', 'http']),
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  cwd: Type.Optional(Type.String()),
  url: Type.Optional(Type.String({ format: 'uri' })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeout: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 30 * 60 * 1_000 })),
  idleTimeout: Type.Optional(
    Type.Integer({ minimum: 1_000, maximum: 30 * 60 * 1_000 })
  ),
  sampling: Type.Optional(
    Type.Object({
      enabled: Type.Boolean(),
      maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_096 })),
      maxRequestsPerToolCall: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      maxInputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })),
    })
  ),
  oauth: Type.Optional(
    Type.Object(
      {
        enabled: Type.Optional(Type.Boolean()),
        clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        scopes: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            maxItems: 32,
          })
        ),
        callbackPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
      },
      { additionalProperties: false }
    )
  ),
  healthCheck: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      interval: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      failureThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    })
  ),
});

const mcpConfigFileSchema = Type.Union([
  Type.Object({
    mcpServers: Type.Record(Type.String(), mcpServerConfigSchema),
  }),
  Type.Record(Type.String(), mcpServerConfigSchema),
]);

type McpConfigFileInput = Static<typeof mcpConfigFileSchema>;
export type PluginPackageStateInput = Static<typeof pluginPackageStateSchema>;
export type PluginMarketplaceManifestInput = Static<
  typeof pluginMarketplaceManifestSchema
>;

export function validateMcpConfig(data: unknown): SafeParseResult<McpConfigFileInput> {
  return safeParseSchema(mcpConfigFileSchema, data);
}

export function validatePluginPackageState(
  data: unknown
): SafeParseResult<PluginPackageStateInput> {
  return safeParseSchema(pluginPackageStateSchema, data);
}

export function validatePluginMarketplaceManifest(
  data: unknown
): SafeParseResult<PluginMarketplaceManifestInput> {
  return safeParseSchema(pluginMarketplaceManifestSchema, data);
}
