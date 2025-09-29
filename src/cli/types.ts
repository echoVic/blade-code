/**
 * Yargs CLI 类型定义
 */

export interface GlobalOptions {
  debug?: string;
  verbose?: boolean;
  print?: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json';
  includePartialMessages?: boolean;
  inputFormat?: 'text' | 'stream-json';
  dangerouslySkipPermissions?: boolean;
  replayUserMessages?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string[];
  appendSystemPrompt?: string;
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  model?: string;
  fallbackModel?: string;
  settings?: string;
  addDir?: string[];
  ide?: boolean;
  strictMcpConfig?: boolean;
  sessionId?: string;
  agents?: string;
  settingSources?: string;
}

export interface ConfigSetOptions extends GlobalOptions {
  global?: boolean;
  key: string;
  value: string;
}

export interface ConfigGetOptions extends GlobalOptions {
  key: string;
}

export interface ConfigListOptions extends GlobalOptions {}

export interface McpListOptions extends GlobalOptions {}

export interface McpAddOptions extends GlobalOptions {
  name: string;
  config: string;
}

export interface McpRemoveOptions extends GlobalOptions {
  name: string;
}

export interface McpStartOptions extends GlobalOptions {
  name: string;
}

export interface McpStopOptions extends GlobalOptions {
  name: string;
}

export interface DoctorOptions extends GlobalOptions {}

export interface UpdateOptions extends GlobalOptions {}

export interface InstallOptions extends GlobalOptions {
  agent?: string;
  command?: string;
  hook?: string;
  mcp?: string;
}

export interface SetupTokenOptions extends GlobalOptions {
  provider?: string;
  token?: string;
}