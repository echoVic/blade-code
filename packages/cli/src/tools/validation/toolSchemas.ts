import { Default, StringEnum, Type } from '../../schema/index.js';

const ABSOLUTE_PATH_PATTERN = '^(?:/|[A-Za-z]:[\\\\/])';

export const ToolSchemas = {
  filePath: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      pattern: ABSOLUTE_PATH_PATTERN,
      description: options?.description || 'Absolute file path',
    }),

  encoding: () =>
    Default(
      StringEnum(['utf8', 'base64', 'binary'], {
        description: 'File encoding',
      }),
      'utf8'
    ),

  timeout: (min = 1000, max = 300000, defaultValue = 30000) =>
    Default(
      Type.Integer({
        minimum: min,
        maximum: max,
        description: `Timeout in milliseconds (default ${defaultValue}ms)`,
      }),
      defaultValue
    ),

  pattern: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      description: options?.description || 'Regex or glob pattern',
    }),

  glob: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      description: options?.description || 'Glob pattern (e.g., "*.js", "**/*.ts")',
    }),

  lineNumber: (options?: { min?: number; description?: string }) =>
    Type.Integer({
      minimum: options?.min ?? 0,
      description: options?.description || 'Line number',
    }),

  lineLimit: (options?: { min?: number; max?: number; description?: string }) =>
    Type.Integer({
      minimum: options?.min ?? 1,
      maximum: options?.max ?? 10000,
      description: options?.description || 'Limit on lines to read',
    }),

  workingDirectory: () =>
    Type.String({
      minLength: 1,
      pattern: ABSOLUTE_PATH_PATTERN,
      description: 'Absolute working directory',
    }),

  environment: () =>
    Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: 'Environment variables (key-value)',
      })
    ),

  outputMode: <const T extends readonly string[]>(
    modes: T,
    defaultMode?: T[number]
  ) => {
    const schema = StringEnum(modes);
    return defaultMode === undefined ? schema : Default(schema, defaultMode);
  },

  flag: (options?: { defaultValue?: boolean; description?: string }) =>
    Default(
      Type.Boolean({
        description: options?.description || 'Boolean flag',
      }),
      options?.defaultValue ?? false
    ),

  url: (options?: { description?: string }) =>
    Type.String({
      format: 'uri',
      description: options?.description || 'URL',
    }),

  port: () =>
    Type.Integer({
      minimum: 1,
      maximum: 65535,
      description: 'Port number',
    }),

  command: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      description: options?.description || 'Command to execute',
    }),

  sessionId: () =>
    Type.Optional(
      Type.String({
        minLength: 1,
        format: 'uuid',
        description: 'Session identifier (UUID)',
      })
    ),

  nonNegativeInt: (options?: { description?: string }) =>
    Type.Integer({
      minimum: 0,
      description: options?.description || 'Non-negative integer',
    }),

  positiveInt: (options?: { description?: string }) =>
    Type.Integer({
      minimum: 1,
      description: options?.description || 'Positive integer',
    }),
};
