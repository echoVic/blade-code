import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getOriginalCwd } from '../bootstrap/state.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { MAX_AGENT_TURNS } from '../config/maxTurns.js';
import { PermissionMode, type RuntimeConfig } from '../config/types.js';

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

const RuntimeSettingsSchema = z
  .object({
    currentModelId: z.string().optional(),
    models: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          provider: z.string().min(1),
          apiKey: z.string(),
          baseUrl: z.string(),
          model: z.string().min(1),
          temperature: z.number().optional(),
          maxContextTokens: z.number().positive().optional(),
          maxOutputTokens: z.number().positive().optional(),
          topP: z.number().optional(),
          topK: z.number().optional(),
          supportsThinking: z.boolean().optional(),
          thinkingBudget: z.number().positive().optional(),
          thinkingMode: z.enum(['off', 'budget', 'adaptive']).optional(),
          apiVersion: z.string().optional(),
          projectId: z.string().optional(),
          fallbackModels: z.array(z.string()).optional(),
          enablePromptCaching: z.boolean().optional(),
          customHeaders: z.record(z.string()).optional(),
          timeout: z.number().positive().optional(),
          maxRetries: z.number().int().min(0).optional(),
        })
      )
      .optional(),
    temperature: z.number().optional(),
    maxContextTokens: z.number().positive().optional(),
    maxOutputTokens: z.number().positive().optional(),
    stream: z.boolean().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    timeout: z.number().positive().optional(),
    theme: z.string().optional(),
    uiTheme: z.enum(['light', 'dark', 'system']).optional(),
    language: z.string().optional(),
    fontSize: z.number().positive().optional(),
    autoSaveSessions: z.boolean().optional(),
    notifyBuild: z.boolean().optional(),
    notifyErrors: z.boolean().optional(),
    notifySounds: z.boolean().optional(),
    privacyTelemetry: z.boolean().optional(),
    privacyCrash: z.boolean().optional(),
    debug: z.union([z.boolean(), z.string()]).optional(),
    mcpEnabled: z.boolean().optional(),
    mcpServers: z.record(z.record(z.unknown())).optional(),
    permissionMode: z.nativeEnum(PermissionMode).optional(),
    maxTurns: z.number().int().min(-1).max(MAX_AGENT_TURNS).optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    initialMessage: z.string().optional(),
    resumeSessionId: z.string().optional(),
    forkSession: z.boolean().optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    disallowedTools: z.array(z.string().min(1)).optional(),
    mcpConfigPaths: z.array(z.string().min(1)).optional(),
    strictMcpConfig: z.boolean().optional(),
    model: z.string().min(1).optional(),
    addDirs: z.array(z.string().min(1)).optional(),
    outputFormat: z.enum(['text', 'json', 'stream-json', 'jsonl']).optional(),
    inputFormat: z.enum(['text', 'stream-json']).optional(),
    print: z.boolean().optional(),
    includePartialMessages: z.boolean().optional(),
    replayUserMessages: z.boolean().optional(),
    agentsConfig: z.string().optional(),
    settingSources: z.string().optional(),
    permissions: z
      .object({
        allow: z.array(z.string()).optional(),
        ask: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .optional(),
    env: z.record(z.string()).optional(),
    hooks: z.record(z.unknown()).optional(),
    disableAllHooks: z.boolean().optional(),
  })
  .passthrough();

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

  const validation = RuntimeSettingsSchema.safeParse(parsed);
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
