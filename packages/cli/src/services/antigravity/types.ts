/**
 * Google Antigravity API 类型定义
 *
 * Antigravity 是 Google 的统一网关 API，通过 Gemini 风格接口访问多种 AI 模型：
 * - Claude (Anthropic)
 * - Gemini (Google)
 * - GPT-OSS (OpenAI 开源变体)
 *
 * API 规范参考：
 * https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/docs/ANTIGRAVITY_API_SPEC.md
 */

// ================================
// OAuth 配置
// ================================

/**
 * Antigravity OAuth 配置常量
 */
/**
 * Antigravity IDE OAuth 配置
 */
export const ANTIGRAVITY_OAUTH_CONFIG = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
  // Antigravity IDE OAuth credentials
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: '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',
  redirectPort: 51121,
  redirectPath: '/oauth-callback',
} as const;

/**
 * Gemini CLI OAuth 配置 (备选)
 * 使用同一个 API，但不同的 OAuth Client
 * Scopes 与官方 Gemini CLI 保持一致
 */
export const GEMINI_CLI_OAUTH_CONFIG = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  // 官方 Gemini CLI scopes (不含 openid)
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  // Gemini CLI OAuth credentials
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  redirectPort: 45289,
  redirectPath: '/',
} as const;

/**
 * OAuth 配置类型
 */
export type OAuthConfigType = 'antigravity' | 'gemini-cli';

/**
 * OAuth 配置接口
 */
export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  clientId: string;
  clientSecret: string;
  redirectPort: number;
  redirectPath: string;
}

/**
 * Antigravity API 端点
 */
export const ANTIGRAVITY_API_ENDPOINTS = {
  production: 'https://cloudcode-pa.googleapis.com',
  sandbox: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
} as const;

/**
 * Antigravity API 路径
 */
export const ANTIGRAVITY_API_PATHS = {
  generateContent: '/v1internal:generateContent',
  streamGenerateContent: '/v1internal:streamGenerateContent',
  loadCodeAssist: '/v1internal:loadCodeAssist',
  onboardUser: '/v1internal:onboardUser',
} as const;

// ================================
// Token 类型
// ================================

/**
 * OAuth Token 存储格式
 */
export interface AntigravityToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  tokenType: string; // 通常为 "Bearer"
  scope?: string;
  configType?: OAuthConfigType; // 使用的 OAuth 配置类型
}

/**
 * OAuth Token 响应（来自 Google）
 */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // 秒
  token_type: string;
  scope?: string;
}

// ================================
// 可用模型
// ================================

/**
 * Antigravity IDE OAuth 支持的模型
 * 需要 Gemini Code Assist 订阅（Pro 用户）
 * 支持 Claude、Gemini 3、GPT-OSS 等高级模型
 */
export const ANTIGRAVITY_MODELS = {
  // Anthropic 模型
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    supportsThinking: false,
    description: '平衡速度与质量的 Claude 模型',
  },
  'claude-sonnet-4-5-thinking': {
    id: 'claude-sonnet-4-5-thinking',
    name: 'Claude Sonnet 4.5 (Thinking)',
    provider: 'anthropic',
    supportsThinking: true,
    description: '支持思维链的 Claude Sonnet',
  },
  'claude-opus-4-5-thinking': {
    id: 'claude-opus-4-5-thinking',
    name: 'Claude Opus 4.5 (Thinking)',
    provider: 'anthropic',
    supportsThinking: true,
    description: '最强 Claude 模型，支持思维链',
  },
  // Google 模型 (Pro 用户专属)
  'gemini-3-pro-high': {
    id: 'gemini-3-pro-high',
    name: 'Gemini 3 Pro (High)',
    provider: 'google',
    supportsThinking: false,
    description: '高质量 Gemini 模型 (Pro)',
  },
  'gemini-3-pro-low': {
    id: 'gemini-3-pro-low',
    name: 'Gemini 3 Pro (Low)',
    provider: 'google',
    supportsThinking: false,
    description: '快速 Gemini 模型 (Pro)',
  },
  'gemini-3-flash': {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    provider: 'google',
    supportsThinking: false,
    description: '超快速 Gemini 模型 (Pro)',
  },
  // OpenAI OSS 模型
  'gpt-oss-120b-medium': {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B Medium',
    provider: 'openai-oss',
    supportsThinking: false,
    description: 'OpenAI 开源模型',
  },
} as const;

/**
 * Gemini CLI OAuth 支持的模型
 * 免费用户可用，使用 Gemini 2.5 系列
 * 免费层动态混合 Pro 和 Flash 模型
 */
export const GEMINI_CLI_MODELS = {
  // Gemini 2.5 系列 (免费用户可用)
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    supportsThinking: false,
    description: '最强 Gemini 2.5 模型，1M 上下文',
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    supportsThinking: false,
    description: '快速 Gemini 2.5 模型',
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    provider: 'google',
    supportsThinking: false,
    description: '轻量级 Gemini 2.5 模型',
  },
} as const;

// ================================
// API 请求/响应类型
// ================================

/**
 * 内容部分（Gemini 风格）
 */
export interface AntigravityPart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    id?: string;
    response: Record<string, unknown>;
  };
}

/**
 * 消息内容（Gemini 风格）
 */
export interface AntigravityContent {
  role: 'user' | 'model';
  parts: AntigravityPart[];
}

/**
 * 生成配置
 */
export interface AntigravityGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
}

/**
 * 工具定义（Gemini 风格）
 */
export interface AntigravityTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

/**
 * 系统指令（Gemini 风格）
 */
export interface AntigravitySystemInstruction {
  parts: Array<{ text: string }>;
}

/**
 * API 请求体（与官方 Gemini CLI 保持一致）
 * 参考：gemini-cli/packages/core/src/code_assist/converter.ts
 */
export interface AntigravityRequest {
  model: string;
  project?: string; // FREE tier 可能没有 projectId（使用 managed project）
  user_prompt_id?: string;
  request: {
    contents: AntigravityContent[];
    systemInstruction?: AntigravitySystemInstruction;
    generationConfig?: AntigravityGenerationConfig;
    tools?: AntigravityTool[];
    session_id?: string; // 会话 ID，与官方保持一致
  };
}

/**
 * 候选响应
 */
export interface AntigravityCandidate {
  content: AntigravityContent;
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
}

/**
 * 使用统计
 */
export interface AntigravityUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

/**
 * API 响应体
 */
export interface AntigravityResponse {
  response: {
    candidates: AntigravityCandidate[];
    usageMetadata?: AntigravityUsageMetadata;
    modelVersion?: string;
    responseId?: string;
  };
  traceId?: string;
}

/**
 * SSE 流式响应块
 */
export interface AntigravityStreamChunk {
  candidates?: Array<{
    content?: AntigravityContent;
    finishReason?: string;
  }>;
  usageMetadata?: AntigravityUsageMetadata;
}


