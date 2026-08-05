import {
  type SafeParseResult,
  type Static,
  StringEnum,
  Type,
  safeParseSchema,
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

const mcpServerConfigSchema = Type.Object({
  type: StringEnum(['stdio', 'sse', 'http']),
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  url: Type.Optional(Type.String({ format: 'uri' })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  oauth: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      clientId: Type.Optional(Type.String()),
      clientSecret: Type.Optional(Type.String()),
      authorizationUrl: Type.Optional(Type.String({ format: 'uri' })),
      tokenUrl: Type.Optional(Type.String({ format: 'uri' })),
      scopes: Type.Optional(Type.Array(Type.String())),
      redirectUri: Type.Optional(Type.String({ format: 'uri' })),
    })
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

export function validateMcpConfig(data: unknown): SafeParseResult<McpConfigFileInput> {
  return safeParseSchema(mcpConfigFileSchema, data);
}
