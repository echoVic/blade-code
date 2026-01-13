/**
 * ACP (Agent Communication Protocol) 类型定义
 */

export interface AgentManifest {
  name: string;
  description: string;
  input_content_types: string[];
  output_content_types: string[];
  metadata?: {
    capabilities?: Array<{ name: string; description: string }>;
    domains?: string[];
    tags?: string[];
    author?: { name: string };
  };
}

export interface MessagePart {
  content_type: string;
  content?: string;
  content_url?: string;
  content_encoding?: 'plain' | 'base64';
}

export interface ACPMessage {
  role: 'user' | 'agent';
  parts: MessagePart[];
  created_at?: string;
  completed_at?: string;
}

export type RunMode = 'sync' | 'async' | 'stream';
export type RunStatus =
  | 'created'
  | 'in-progress'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunInfo {
  id: string;
  agent_name: string;
  session_id?: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  output?: ACPMessage[];
  error?: {
    code: string;
    message: string;
  };
}

export interface CreateRunRequest {
  agent_name: string;
  session_id?: string;
  input: ACPMessage[];
  mode: RunMode;
}

export interface SessionInfo {
  id: string;
  title?: string;
  project_path?: string;
  git_branch?: string;
  message_count: number;
  first_message_time?: string;
  last_message_time?: string;
  has_errors?: boolean;
}

export interface ConfigInfo {
  project_path: string;
  current_model_id?: string;
  permission_mode?: string;
  models?: Array<{
    id: string;
    name: string;
    provider: string;
  }>;
}

export interface SSEEvent {
  event: string;
  data: string;
}
