/**
 * Yargs CLI 类型定义
 */

export interface GlobalOptions {
  debug?: string;
  model?: string;
  print?: boolean;
  headless?: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json' | 'jsonl';
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
  maxConcurrentTasks?: number;
  maxQueuedTasks?: number;
  maxQueuedTaskBytes?: number;
  pluginDir?: string[];
  trustWorkspace?: boolean;
}

export interface DoctorOptions extends GlobalOptions {
  /** 删除并从 JSONL 全量重建 SQLite 读侧投影索引。 */
  rebuildIndex?: boolean;
}

export interface UpdateOptions extends GlobalOptions {}

export interface InstallOptions extends GlobalOptions {
  agent?: string;
  command?: string;
  hook?: string;
  mcp?: string;
}
