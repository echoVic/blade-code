/**
 * ACP Web API 类型定义
 *
 * 基于 ACP 协议规范定义 HTTP API 的请求和响应类型
 */

// ==================== ACP 协议类型 ====================

/**
 * Agent Manifest - Agent 能力声明
 */
export interface AgentManifest {
  name: string;
  description: string;
  input_content_types: string[];
  output_content_types: string[];
  metadata?: {
    capabilities?: Array<{
      name: string;
      description: string;
    }>;
    domains?: string[];
    tags?: string[];
    author?: {
      name: string;
    };
  };
}

/**
 * ACP 消息部分
 */
export interface MessagePart {
  content_type: string;
  content?: string;
  content_url?: string;
  content_encoding?: 'plain' | 'base64';
  metadata?: TrajectoryMetadata | CitationMetadata;
}

/**
 * ACP 消息
 */
export interface ACPMessage {
  role: 'user' | 'agent';
  parts: MessagePart[];
  created_at?: string;
  completed_at?: string;
}

/**
 * 工具调用追踪元数据
 */
export interface TrajectoryMetadata {
  type: 'trajectory';
  reasoning_step?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
}

/**
 * 引用元数据
 */
export interface CitationMetadata {
  type: 'citation';
  source_url?: string;
  title?: string;
  description?: string;
}

/**
 * 运行模式
 */
export type RunMode = 'sync' | 'async' | 'stream';

/**
 * 运行状态
 */
export type RunStatus = 'created' | 'in-progress' | 'awaiting' | 'completed' | 'failed' | 'cancelled';

/**
 * 创建运行请求
 */
export interface CreateRunRequest {
  agent_name: string;
  session_id?: string;
  input: ACPMessage[];
  mode: RunMode;
}

/**
 * 运行信息
 */
export interface RunInfo {
  id: string;
  agent_name: string;
  session_id?: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  output?: ACPMessage[];
  error?: ErrorInfo;
}

/**
 * 错误信息
 */
export interface ErrorInfo {
  code: 'server_error' | 'invalid_input' | 'not_found' | 'cancelled';
  message: string;
  data?: Record<string, unknown>;
}

// ==================== SSE 事件类型 ====================

/**
 * SSE 事件类型
 */
export type SSEEventType =
  | 'run.created'
  | 'run.in-progress'
  | 'run.awaiting'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'
  | 'message.created'
  | 'message.part'
  | 'message.completed'
  | 'error';

/**
 * SSE 事件基础接口
 */
export interface SSEEvent {
  type: SSEEventType;
  data: Record<string, unknown>;
}

// ==================== 普通 HTTP API 类型 ====================

/**
 * 会话信息（用于列表显示）
 */
export interface SessionInfo {
  id: string;
  project_path: string;
  git_branch?: string;
  message_count: number;
  first_message_time: string;
  last_message_time: string;
  has_errors: boolean;
  title?: string;
}

/**
 * 会话详情
 */
export interface SessionDetail extends SessionInfo {
  messages: ACPMessage[];
}

/**
 * 创建会话请求
 */
export interface CreateSessionRequest {
  project_path?: string;
}

/**
 * 创建会话响应
 */
export interface CreateSessionResponse {
  session_id: string;
}

/**
 * 配置信息
 */
export interface ConfigInfo {
  project_path: string;
  current_model_id?: string;
  permission_mode: 'default' | 'auto-edit' | 'yolo' | 'plan';
  models: Array<{
    id: string;
    name: string;
    provider?: string;
  }>;
}

/**
 * 更新配置请求
 */
export interface UpdateConfigRequest {
  current_model_id?: string;
  permission_mode?: 'default' | 'auto-edit' | 'yolo' | 'plan';
}
