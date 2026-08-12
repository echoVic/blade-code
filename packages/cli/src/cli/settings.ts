import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getOriginalCwd } from '../bootstrap/state.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { MAX_AGENT_TURNS } from '../config/maxTurns.js';
import {
  MAX_CONCURRENT_TASKS,
  MAX_QUEUED_TASKS,
  MIN_CONCURRENT_TASKS,
  MIN_QUEUED_TASKS,
} from '../config/taskConcurrency.js';
import { PermissionMode, type RuntimeConfig } from '../config/types.js';
import { StringEnum, safeParseSchema, Type } from '../schema/index.js';

const RUNTIME_SETTING_FIELDS = [
  'systemPrompt',
  'appendSystemPrompt',
  'initialMessage',
  'resumeSessionId',
  'forkSession',
  'allowedTools',
  'disallowedTools',
  'mcpConfigPaths',
  'strictMcpConfig',
  'model',
  'addDirs',
  'outputFormat',
  'inputFormat',
  'print',
  'includePartialMessages',
  'replayUserMessages',
  'agentsConfig',
  'settingSources',
] as const;

const KNOWN_SETTING_FIELDS = new Set([
  ...Object.keys(DEFAULT_CONFIG),
  ...RUNTIME_SETTING_FIELDS,
]);

const PositiveNumber = Type.Number({ exclusiveMinimum: 0 });
const NonEmptyString = Type.String({ minLength: 1 });
const StringArray = Type.Array(Type.String());

const RuntimeSettingsSchema = Type.Object({
  currentModelId: Type.Optional(Type.String()),
  modelProviders: Type.Optional(
    Type.Record(
      NonEmptyString,
      Type.Object({
        name: NonEmptyString,
        baseUrl: NonEmptyString,
        wireApi: StringEnum(['openai-completions', 'anthropic-messages']),
        apiKeyEnv: Type.Optional(NonEmptyString),
      })
    )
  ),
  models: Type.Optional(
    Type.Array(
      Type.Object({
        id: NonEmptyString,
        displayName: Type.Optional(NonEmptyString),
        provider: NonEmptyString,
        model: NonEmptyString,
        overrides: Type.Optional(
          Type.Object({
            baseUrl: Type.Optional(Type.String()),
            temperature: Type.Optional(Type.Number()),
            maxOutputTokens: Type.Optional(PositiveNumber),
            timeout: Type.Optional(PositiveNumber),
            streamIdleTimeout: Type.Optional(Type.Number({ minimum: 1_000 })),
            apiVersion: Type.Optional(Type.String()),
            customHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
            maxRetries: Type.Optional(Type.Integer({ minimum: 0 })),
            enablePromptCaching: Type.Optional(Type.Boolean()),
          })
        ),
        fallbackModels: Type.Optional(
          Type.Array(
            Type.Object({
              provider: NonEmptyString,
              model: NonEmptyString,
            })
          )
        ),
      })
    )
  ),
  temperature: Type.Optional(Type.Number()),
  maxOutputTokens: Type.Optional(PositiveNumber),
  stream: Type.Optional(Type.Boolean()),
  topP: Type.Optional(Type.Number()),
  topK: Type.Optional(Type.Number()),
  timeout: Type.Optional(PositiveNumber),
  codeTheme: Type.Optional(Type.String()),
  uiTheme: Type.Optional(StringEnum(['light', 'dark', 'system'])),
  language: Type.Optional(Type.String()),
  fontSize: Type.Optional(PositiveNumber),
  autoSaveSessions: Type.Optional(Type.Boolean()),
  notifyBuild: Type.Optional(Type.Boolean()),
  notifyErrors: Type.Optional(Type.Boolean()),
  notifySounds: Type.Optional(Type.Boolean()),
  privacyTelemetry: Type.Optional(Type.Boolean()),
  privacyCrash: Type.Optional(Type.Boolean()),
  debug: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
  mcpEnabled: Type.Optional(Type.Boolean()),
  mcpServers: Type.Optional(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()))
  ),
  lspServers: Type.Optional(
    Type.Record(
      NonEmptyString,
      Type.Object({
        command: NonEmptyString,
        args: Type.Optional(Type.Array(Type.String())),
        extensionToLanguage: Type.Record(NonEmptyString, NonEmptyString),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        initializationOptions: Type.Optional(Type.Unknown()),
        settings: Type.Optional(Type.Unknown()),
        enabled: Type.Optional(Type.Boolean()),
        priority: Type.Optional(Type.Integer()),
        startupTimeout: Type.Optional(Type.Integer({ minimum: 100 })),
        shutdownTimeout: Type.Optional(Type.Integer({ minimum: 100 })),
        requestTimeout: Type.Optional(Type.Integer({ minimum: 100 })),
        diagnosticWaitTimeout: Type.Optional(Type.Integer({ minimum: 0 })),
        maxRestarts: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      })
    )
  ),
  permissionMode: Type.Optional(Type.Enum(PermissionMode)),
  maxTurns: Type.Optional(Type.Integer({ minimum: -1, maximum: MAX_AGENT_TURNS })),
  maxConcurrentTasks: Type.Optional(
    Type.Integer({
      minimum: MIN_CONCURRENT_TASKS,
      maximum: MAX_CONCURRENT_TASKS,
    })
  ),
  maxQueuedTasks: Type.Optional(
    Type.Integer({
      minimum: MIN_QUEUED_TASKS,
      maximum: MAX_QUEUED_TASKS,
    })
  ),
  systemPrompt: Type.Optional(Type.String()),
  appendSystemPrompt: Type.Optional(Type.String()),
  initialMessage: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(Type.String()),
  forkSession: Type.Optional(Type.Boolean()),
  allowedTools: Type.Optional(Type.Array(NonEmptyString)),
  disallowedTools: Type.Optional(Type.Array(NonEmptyString)),
  mcpConfigPaths: Type.Optional(Type.Array(NonEmptyString)),
  strictMcpConfig: Type.Optional(Type.Boolean()),
  model: Type.Optional(NonEmptyString),
  addDirs: Type.Optional(Type.Array(NonEmptyString)),
  outputFormat: Type.Optional(StringEnum(['text', 'json', 'stream-json', 'jsonl'])),
  inputFormat: Type.Optional(StringEnum(['text', 'stream-json'])),
  print: Type.Optional(Type.Boolean()),
  includePartialMessages: Type.Optional(Type.Boolean()),
  replayUserMessages: Type.Optional(Type.Boolean()),
  agentsConfig: Type.Optional(Type.String()),
  settingSources: Type.Optional(Type.String()),
  permissions: Type.Optional(
    Type.Object({
      allow: Type.Optional(StringArray),
      ask: Type.Optional(StringArray),
      deny: Type.Optional(StringArray),
    })
  ),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  hooks: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  enabledPlugins: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
  pluginSourcePolicy: Type.Optional(
    Type.Object({
      restrictToAllowedSources: Type.Optional(Type.Boolean()),
      requireGitCommitSha: Type.Optional(Type.Boolean()),
      allowedGitHosts: Type.Optional(Type.Array(NonEmptyString)),
      allowedMarketplaces: Type.Optional(Type.Array(NonEmptyString)),
      allowedLocalRoots: Type.Optional(Type.Array(NonEmptyString)),
    })
  ),
  disableAllHooks: Type.Optional(Type.Boolean()),
});

const ARGUMENT_MAPPINGS = [
  ['systemPrompt', 'systemPrompt'],
  ['appendSystemPrompt', 'appendSystemPrompt'],
  ['initialMessage', 'initialMessage'],
  ['resumeSessionId', 'sessionId'],
  ['forkSession', 'forkSession'],
  ['allowedTools', 'allowedTools'],
  ['disallowedTools', 'disallowedTools'],
  ['mcpConfigPaths', 'mcpConfig'],
  ['strictMcpConfig', 'strictMcpConfig'],
  ['model', 'model'],
  ['addDirs', 'addDir'],
  ['outputFormat', 'outputFormat'],
  ['inputFormat', 'inputFormat'],
  ['print', 'print'],
  ['includePartialMessages', 'includePartialMessages'],
  ['replayUserMessages', 'replayUserMessages'],
  ['agentsConfig', 'agents'],
  ['settingSources', 'settingSources'],
  ['permissionMode', 'permissionMode'],
  ['maxTurns', 'maxTurns'],
  ['maxConcurrentTasks', 'maxConcurrentTasks'],
  ['maxQueuedTasks', 'maxQueuedTasks'],
] as const;

function parseSettingsJson(content: string, source: string): Partial<RuntimeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Invalid JSON provided to --settings (${source})${detail}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--settings must contain a JSON object');
  }

  for (const field of Object.keys(parsed)) {
    if (!KNOWN_SETTING_FIELDS.has(field)) {
      throw new Error(`Unknown --settings field: ${field}`);
    }
  }

  const validation = safeParseSchema(RuntimeSettingsSchema, parsed);
  if (!validation.success) {
    const detail = validation.error.issues
      .map((issue) => `${issue.path.join('.') || 'settings'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid --settings value: ${detail}`);
  }

  return validation.data as Partial<RuntimeConfig>;
}

export async function loadCliSettings(
  input: string | undefined
): Promise<Partial<RuntimeConfig> | undefined> {
  if (input === undefined) return undefined;

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('--settings requires a JSON object or file path');
  }

  if (trimmed.startsWith('{')) {
    return parseSettingsJson(trimmed, 'inline JSON');
  }

  const filePath = path.resolve(getOriginalCwd(), trimmed);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Unable to read --settings file ${filePath}${detail}`);
  }

  return parseSettingsJson(content, filePath);
}

export function applyCliSettingsToArguments(
  argv: Record<string, unknown>,
  settings: Partial<RuntimeConfig> | undefined
): void {
  if (!settings) return;

  const source = settings as Record<string, unknown>;
  for (const [settingsField, argumentField] of ARGUMENT_MAPPINGS) {
    if (settingsField === 'permissionMode' && argv.yolo === true) {
      continue;
    }
    if (argv[argumentField] === undefined && source[settingsField] !== undefined) {
      argv[argumentField] = source[settingsField];
    }
  }
}
