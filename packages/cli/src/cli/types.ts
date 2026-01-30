/**
 * Yargs CLI 类型定义
 */

export interface GlobalOptions {
  debug?: string;
  print?: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json';
  includePartialMessages?: boolean;
  inputFormat?: 'text' | 'stream-json';
  replayUserMessages?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  yolo?: boolean;
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;

  settings?: string;
  addDir?: string[];
  ide?: boolean;
  strictMcpConfig?: boolean;
  sessionId?: string;
  agents?: string;
  settingSources?: string;
  maxTurns?: number;
  pluginDir?: string[];
}

export interface DoctorOptions extends GlobalOptions {}

export interface UpdateOptions extends GlobalOptions {}

export interface InstallOptions extends GlobalOptions {
  agent?: string;
  command?: string;
  hook?: string;
  mcp?: string;
}
