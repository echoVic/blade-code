/**
 * GitHub Copilot API 类型定义
 *
 * GitHub Copilot 使用 Device Flow OAuth 认证，然后通过 OpenAI 兼容的 API 格式调用。
 *
 * 认证流程：
 * 1. Device Flow OAuth 获取 GitHub access token (gho_xxx)
 * 2. 用 GitHub token 换取 Copilot completion token
 * 3. 用 Copilot token 调用 API
 *
 * 参考资料：
 * - https://github.com/ericc-ch/copilot-api
 * - https://github.com/VSCodium/vscodium/discussions/1487
 */

// ================================
// OAuth 配置
// ================================

/**
 * GitHub Copilot OAuth 配置常量
 * 使用 VSCode 的 OAuth Client ID
 */
export const COPILOT_OAUTH_CONFIG = {
  // GitHub Device Flow 端点
  deviceCodeUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',

  // VSCode 的 Copilot OAuth Client ID
  clientId: '01ab8ac9400c4e429b23',

  // OAuth scope
  scope: 'user:email',

  // Device Flow grant type
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

/**
 * Copilot API 端点
 */
export const COPILOT_API_ENDPOINTS = {
  // Token 交换端点
  tokenExchange: 'https://api.github.com/copilot_internal/v2/token',

  // Chat API 端点 (OpenAI 兼容格式)
  chatCompletions: 'https://api.githubcopilot.com/chat/completions',

  // Models 端点
  models: 'https://api.githubcopilot.com/models',
} as const;

// ================================
// Token 类型
// ================================

/**
 * Device Flow 响应
 */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * GitHub OAuth Token 响应
 */
export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

/**
 * Copilot Token 响应
 */
export interface CopilotTokenResponse {
  token: string;
  expires_at: number; // Unix timestamp (seconds)
  refresh_in?: number;
  // 其他字段可能存在但我们不需要
}

/**
 * 存储的 Copilot Token
 */
export interface CopilotToken {
  // GitHub access token (gho_xxx)
  githubToken: string;

  // Copilot completion token
  copilotToken: string;

  // Copilot token 过期时间 (Unix timestamp ms)
  copilotExpiresAt: number;
}

// ================================
// 可用模型
// ================================

/**
 * Copilot 支持的模型
 * 根据 GitHub Copilot Chat 实际可选模型列表
 * 更新于 2025-12
 */
export const COPILOT_MODELS = {
  // ================================
  // Fast and cost-efficient
  // ================================
  'gpt-5-mini': {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'openai',
    supportsStreaming: true,
    description: '快速高效，适合简单任务',
  },
  'grok-code-fast-1': {
    id: 'grok-code-fast-1',
    name: 'Grok Code Fast 1',
    provider: 'xai',
    supportsStreaming: true,
    description: 'xAI 快速代码模型',
  },

  // ================================
  // Versatile and highly intelligent
  // ================================
  'claude-haiku-4.5': {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    supportsStreaming: true,
    description: '快速智能的 Claude',
  },
  'gpt-4.1': {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    supportsStreaming: true,
    description: '默认模型，平衡速度与质量',
  },
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    supportsStreaming: true,
    description: '多模态模型，适合日常编码',
  },
  'gpt-5': {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    supportsStreaming: true,
    description: '最新 GPT-5 模型',
  },
  'claude-sonnet-4': {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    supportsStreaming: true,
    description: '平衡速度与智能的 Claude',
  },
  'claude-sonnet-4.5': {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    supportsStreaming: true,
    description: '最新 Claude Sonnet',
  },

  // ================================
  // Most powerful at complex tasks
  // ================================
  'claude-opus-4.1': {
    id: 'claude-opus-4.1',
    name: 'Claude Opus 4.1',
    provider: 'anthropic',
    supportsStreaming: true,
    description: '最强 Claude，适合复杂任务',
  },

  // ================================
  // Google Gemini 模型
  // ================================
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    supportsStreaming: true,
    description: '高级推理和长上下文',
  },
  'gemini-3-pro': {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    provider: 'google',
    supportsStreaming: true,
    description: '数据分析和多模态',
  },
  'gemini-3-flash': {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    provider: 'google',
    supportsStreaming: true,
    description: '快速响应模型',
  },
} as const;

// ================================
// API 请求/响应类型 (OpenAI 兼容)
// ================================

/**
 * Chat Completion 请求 (OpenAI 格式)
 */
export interface CopilotChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

/**
 * Chat Completion 响应 (OpenAI 格式)
 */
export interface CopilotChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 流式响应块 (SSE)
 */
export interface CopilotStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
}
