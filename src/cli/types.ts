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
  permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan'; // --permission-mode 同义词
  yolo?: boolean; // --yolo 快捷方式,等同于 --permission-mode=yolo
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
  maxTurns?: number; // 最大对话轮次 (-1=无限制, 0=禁用对话, N>0=限制轮次)
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

