import { Command, Option } from '@commander-js/extra-typings';
import { getDescription, getVersion } from '../utils/packageInfo.js';

export enum OutputFormat {
  text = 'text',
  json = 'json',
  'stream-json' = 'stream-json',
  jsonl = 'jsonl',
}

export enum InputFormat {
  text = 'text',
  'stream-json' = 'stream-json',
}

export enum PermissionMode {
  default = 'default',
  autoEdit = 'autoEdit',
  yolo = 'yolo',
  plan = 'plan',
}

function collectArray(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

export const globalOptionDefinitions = {
  debug: new Option(
    '-d, --debug [filter]',
    'Enable debug mode with optional category filtering (e.g., "agent,ui" or "!chat,!loop")'
  ).preset('true').helpGroup('Debug Options:'),

  print: new Option(
    '-p, --print',
    'Print response and exit (useful for pipes)'
  ).helpGroup('Output Options:'),

  headless: new Option(
    '--headless',
    'Run full agent loop without Ink UI and print all events to the terminal'
  ).helpGroup('Output Options:'),

  outputFormat: new Option(
    '--output-format <format>',
    'Output format (works with --print and --headless)'
  ).choices(['text', 'json', 'stream-json', 'jsonl'] as const)
    .default('text' as const)
    .helpGroup('Output Options:'),

  includePartialMessages: new Option(
    '--include-partial-messages',
    'Include partial message chunks as they arrive'
  ).helpGroup('Output Options:'),

  inputFormat: new Option(
    '--input-format <format>',
    'Input format'
  ).choices(['text', 'stream-json'] as const)
    .default('text' as const)
    .helpGroup('Input Options:'),

  replayUserMessages: new Option(
    '--replay-user-messages',
    'Re-emit user messages from stdin'
  ).helpGroup('Input Options:'),

  allowedTools: new Option(
    '--allowed-tools <tool>',
    'Tool name to allow (repeatable)'
  ).argParser(collectArray).default([] as string[]).helpGroup('Security Options:'),

  disallowedTools: new Option(
    '--disallowed-tools <tool>',
    'Tool name to deny (repeatable)'
  ).argParser(collectArray).default([] as string[]).helpGroup('Security Options:'),

  mcpConfig: new Option(
    '--mcp-config <path>',
    'Load MCP servers from JSON files or strings (repeatable)'
  ).argParser(collectArray).default([] as string[]).helpGroup('MCP Options:'),

  systemPrompt: new Option(
    '--system-prompt <prompt>',
    'System prompt to use for the session (replaces default)'
  ).helpGroup('AI Options:'),

  appendSystemPrompt: new Option(
    '--append-system-prompt <prompt>',
    'Append a system prompt to the default system prompt'
  ).helpGroup('AI Options:'),

  maxTurns: new Option(
    '--max-turns <n>',
    'Maximum conversation turns (-1: unlimited, 0: disable chat, N>0: limit to N turns)'
  ).argParser(Number).helpGroup('AI Options:'),

  permissionMode: new Option(
    '--permission-mode <mode>',
    'Permission mode (default: ask for non-read tools, autoEdit: auto-approve edits, yolo: auto-approve all, plan: reserved)'
  ).choices(['default', 'autoEdit', 'yolo', 'plan'] as const).helpGroup('Security Options:'),

  yolo: new Option(
    '--yolo',
    'Auto-approve all tools (shortcut for --permission-mode=yolo)'
  ).helpGroup('Security Options:'),

  continue: new Option(
    '-c, --continue',
    'Continue the most recent conversation'
  ).helpGroup('Session Options:'),

  resume: new Option(
    '-r, --resume [sessionId]',
    'Resume a conversation - provide a session ID or interactively select'
  ).preset('true').helpGroup('Session Options:'),

  forkSession: new Option(
    '--fork-session',
    'Create a new session ID when resuming'
  ).helpGroup('Session Options:'),

  settings: new Option(
    '--settings <path>',
    'Path to a settings JSON file or JSON string'
  ).helpGroup('Configuration:'),

  addDir: new Option(
    '--add-dir <dir>',
    'Additional directories to allow tool access to (repeatable)'
  ).argParser(collectArray).default([] as string[]).helpGroup('Security Options:'),

  ide: new Option(
    '--ide',
    'Automatically connect to IDE on startup'
  ).helpGroup('Integration:'),

  acp: new Option(
    '--acp',
    'Run in ACP (Agent Client Protocol) mode for IDE integration'
  ).helpGroup('Integration:'),

  strictMcpConfig: new Option(
    '--strict-mcp-config',
    'Only use MCP servers from --mcp-config'
  ).helpGroup('MCP Options:'),

  sessionId: new Option(
    '--session-id <id>',
    'Use a specific session ID for the conversation'
  ).helpGroup('Session Options:'),

  agents: new Option(
    '--agents <json>',
    'JSON object defining custom agents'
  ).helpGroup('AI Options:'),

  settingSources: new Option(
    '--setting-sources <sources>',
    'Comma-separated list of setting sources to load'
  ).helpGroup('Configuration:'),

  pluginDir: new Option(
    '--plugin-dir <dir>',
    'Load plugins from specified directories (repeatable)'
  ).argParser(collectArray).default([] as string[]).helpGroup('Plugin Options:'),
} as const;

export function applyGlobalOptions(cmd: Command): Command {
  for (const opt of Object.values(globalOptionDefinitions)) {
    cmd.addOption(opt as Option);
  }
  return cmd as Command;
}

export function applyGlobalOptionsToCommand(cmd: Command): Command {
  return applyGlobalOptions(cmd);
}

/**
 * @deprecated Yargs-compatible globalOptions kept for backward compatibility with headless/print commands.
 * TODO: Remove once headless/print commands are migrated to Commander.js.
 * These definitions MUST stay in sync with `globalOptionDefinitions` above.
 */
export const globalOptions: Record<string, import('yargs').Options> = {
  debug: {
    alias: 'd',
    type: 'string',
    describe: 'Enable debug mode with optional category filtering (e.g., "agent,ui" or "!chat,!loop")',
    group: 'Debug Options:',
  },
  print: {
    alias: 'p',
    type: 'boolean',
    describe: 'Print response and exit (useful for pipes)',
    group: 'Output Options:',
  },
  headless: {
    type: 'boolean',
    describe: 'Run full agent loop without Ink UI and print all events to the terminal',
    group: 'Output Options:',
  },
  'output-format': {
    alias: ['outputFormat'],
    type: 'string',
    choices: ['text', 'json', 'stream-json', 'jsonl'],
    default: 'text',
    describe: 'Output format (works with --print and --headless)',
    group: 'Output Options:',
  },
  'include-partial-messages': {
    alias: ['includePartialMessages'],
    type: 'boolean',
    describe: 'Include partial message chunks as they arrive',
    group: 'Output Options:',
  },
  'input-format': {
    alias: ['inputFormat'],
    type: 'string',
    choices: ['text', 'stream-json'],
    default: 'text',
    describe: 'Input format',
    group: 'Input Options:',
  },
  'replay-user-messages': {
    alias: ['replayUserMessages'],
    type: 'boolean',
    describe: 'Re-emit user messages from stdin',
    group: 'Input Options:',
  },
  'allowed-tools': {
    alias: ['allowedTools'],
    type: 'array',
    string: true,
    describe: 'Comma or space-separated list of tool names to allow',
    group: 'Security Options:',
  },
  'disallowed-tools': {
    alias: ['disallowedTools'],
    type: 'array',
    string: true,
    describe: 'Comma or space-separated list of tool names to deny',
    group: 'Security Options:',
  },
  'mcp-config': {
    alias: ['mcpConfig'],
    type: 'array',
    string: true,
    describe: 'Load MCP servers from JSON files or strings',
    group: 'MCP Options:',
  },
  'system-prompt': {
    alias: ['systemPrompt'],
    type: 'string',
    describe: 'System prompt to use for the session (replaces default)',
    group: 'AI Options:',
  },
  'append-system-prompt': {
    alias: ['appendSystemPrompt'],
    type: 'string',
    describe: 'Append a system prompt to the default system prompt',
    group: 'AI Options:',
  },
  'max-turns': {
    alias: ['maxTurns'],
    type: 'number',
    describe: 'Maximum conversation turns (-1: unlimited, 0: disable chat, N>0: limit to N turns)',
    group: 'AI Options:',
    default: undefined,
  },
  'permission-mode': {
    alias: ['permissionMode'],
    type: 'string',
    choices: ['default', 'autoEdit', 'yolo', 'plan'],
    describe: 'Permission mode (default: ask for non-read tools, autoEdit: auto-approve edits, yolo: auto-approve all, plan: reserved)',
    group: 'Security Options:',
  },
  yolo: {
    type: 'boolean',
    describe: 'Auto-approve all tools (shortcut for --permission-mode=yolo)',
    group: 'Security Options:',
  },
  continue: {
    alias: 'c',
    type: 'boolean',
    describe: 'Continue the most recent conversation',
    group: 'Session Options:',
  },
  resume: {
    alias: 'r',
    describe: 'Resume a conversation - provide a session ID or interactively select a conversation to resume',
    group: 'Session Options:',
    coerce: (value: string | boolean | undefined) => {
      if (value === undefined || value === true || value === '') {
        return 'true';
      }
      return String(value);
    },
  },
  'fork-session': {
    alias: ['forkSession'],
    type: 'boolean',
    describe: 'Create a new session ID when resuming',
    group: 'Session Options:',
  },
  settings: {
    type: 'string',
    describe: 'Path to a settings JSON file or JSON string',
    group: 'Configuration:',
  },
  'add-dir': {
    alias: ['addDir'],
    type: 'array',
    string: true,
    describe: 'Additional directories to allow tool access to',
    group: 'Security Options:',
  },
  ide: {
    type: 'boolean',
    describe: 'Automatically connect to IDE on startup',
    group: 'Integration:',
  },
  acp: {
    type: 'boolean',
    describe: 'Run in ACP (Agent Client Protocol) mode for IDE integration',
    group: 'Integration:',
  },
  'strict-mcp-config': {
    alias: ['strictMcpConfig'],
    type: 'boolean',
    describe: 'Only use MCP servers from --mcp-config',
    group: 'MCP Options:',
  },
  'session-id': {
    alias: ['sessionId'],
    type: 'string',
    describe: 'Use a specific session ID for the conversation',
    group: 'Session Options:',
  },
  agents: {
    type: 'string',
    describe: 'JSON object defining custom agents',
    group: 'AI Options:',
  },
  'setting-sources': {
    alias: ['settingSources'],
    type: 'string',
    describe: 'Comma-separated list of setting sources to load',
    group: 'Configuration:',
  },
  'plugin-dir': {
    alias: ['pluginDir'],
    type: 'array',
    string: true,
    describe: 'Load plugins from specified directories',
    group: 'Plugin Options:',
  },
};

export const cliConfig = {
  scriptName: 'blade',
  usage: 'blade [command] [options]',
  description: getDescription(),
  version: getVersion(),
};
