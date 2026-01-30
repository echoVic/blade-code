/**
 * Google Antigravity Chat Service
 *
 * 使用 Antigravity API 实现聊天服务。
 * Antigravity 是 Google 的统一网关 API，通过 Gemini 风格接口访问多种 AI 模型。
 *
 * API 特点：
 * 1. 使用 OAuth 2.0 Bearer token 认证
 * 2. 端点：cloudcode-pa.googleapis.com
 * 3. 请求格式：Gemini 风格（contents, systemInstruction, tools）
 * 4. 支持模型：Claude、Gemini、GPT-OSS
 *
 * 用户初始化流程（与官方 Gemini CLI 保持一致）：
 * 1. 调用 loadCodeAssist 获取用户 tier 和 projectId
 * 2. 如果没有 projectId，调用 onboardUser 进行用户注册
 * 3. onboardUser 返回的是 Long Running Operation，需要轮询等待完成
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { proxyFetch } from '../utils/proxyFetch.js';
import { AntigravityAuth } from './antigravity/AntigravityAuth.js';
import {
  ANTIGRAVITY_API_ENDPOINTS,
  ANTIGRAVITY_API_PATHS,
  type AntigravityContent,
  type AntigravityPart,
  type AntigravityRequest,
  type AntigravityResponse,
  type AntigravityStreamChunk,
  type AntigravityTool,
} from './antigravity/types.js';
import type {
  ChatConfig,
  ChatResponse,
  ContentPart,
  IChatService,
  Message,
  StreamChunk,
} from './ChatServiceInterface.js';

const logger = createLogger(LogCategory.CHAT);

/**
 * 用户 Tier ID（与官方 Gemini CLI 保持一致）
 */
enum UserTierId {
  FREE = 'free-tier',
  STANDARD = 'standard-tier',
  LEGACY = 'legacy-tier',
}

/**
 * loadCodeAssist 响应类型
 */
interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  currentTier?: { id: UserTierId };
  allowedTiers?: Array<{
    id: UserTierId;
    name?: string;
    description?: string;
    isDefault?: boolean;
    userDefinedCloudaicompanionProject?: boolean;
  }>;
  ineligibleTiers?: Array<{
    tierId: string;
    reasonCode?: string;
    reasonMessage?: string;
  }>;
}

/**
 * onboardUser 响应类型（Long Running Operation）
 */
interface OnboardUserResponse {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
  error?: {
    code?: number;
    message?: string;
  };
}

/**
 * Client Metadata - 根据 OAuth 配置类型动态生成
 * - Antigravity: ideType = 'ANTIGRAVITY'
 * - Gemini CLI: ideType = 'IDE_UNSPECIFIED', pluginType = 'GEMINI'
 */
function getClientMetadata(configType: 'antigravity' | 'gemini-cli') {
  if (configType === 'antigravity') {
    return {
      ideType: 'ANTIGRAVITY',
    };
  }
  // Gemini CLI 配置
  return {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  };
}

/**
 * 获取 User-Agent - 根据 OAuth 配置类型
 */
function getUserAgent(configType: 'antigravity' | 'gemini-cli'): string {
  if (configType === 'antigravity') {
    return 'antigravity/1.11.3 Darwin/arm64';
  }
  return 'gemini-cli/1.0.0';
}

/**
 * 过滤孤儿 tool 消息
 */
function filterOrphanToolMessages(messages: Message[]): Message[] {
  const availableToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableToolCallIds.add(tc.id);
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        return false;
      }
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

/**
 * 将内部 Message 内容转为纯文本
 */
function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * 清理 JSON Schema 以符合 Antigravity API 要求
 * 不支持的字段：const, $ref, $defs, $schema, $id, default, examples
 */
function cleanJsonSchemaForAntigravity(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const unsupportedFields = [
    'const',
    '$ref',
    '$defs',
    '$schema',
    '$id',
    'default',
    'examples',
  ];
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // 跳过不支持的字段
    if (unsupportedFields.includes(key)) {
      // const 转换为 enum
      if (key === 'const') {
        cleaned.enum = [value];
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = cleanJsonSchemaForAntigravity(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? cleanJsonSchemaForAntigravity(item as Record<string, unknown>)
          : item
      );
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

export class AntigravityChatService implements IChatService {
  private config: ChatConfig;
  private auth: AntigravityAuth;
  private projectId: string | undefined;
  private userTier: UserTierId | undefined;
  private sessionId: string;
  private configType: 'antigravity' | 'gemini-cli' = 'antigravity';
  private projectIdInitialized = false;

  constructor(config: ChatConfig) {
    this.config = config;
    this.auth = AntigravityAuth.getInstance();
    // projectId 将在 ensureProjectId 中通过 setupUser 流程获取
    this.projectId = undefined;
    // 生成会话 ID
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    logger.debug('🚀 [AntigravityChatService] Initializing');
    logger.debug('⚙️ [AntigravityChatService] Config:', {
      model: config.model,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      sessionId: this.sessionId,
    });
  }

  /**
   * 用户初始化流程
   *
   * 流程：
   * 1. 获取当前 OAuth 配置类型（antigravity 或 gemini-cli）
   * 2. 调用 loadCodeAssist 获取用户 tier 信息
   * 3. 如果已有 currentTier 和 projectId，直接使用
   * 4. 否则获取默认 tier，调用 onboardUser 进行注册
   * 5. onboardUser 是 LRO，需要轮询等待 done=true
   */
  private async ensureProjectId(): Promise<void> {
    if (this.projectIdInitialized) {
      return;
    }

    try {
      // 获取当前使用的 OAuth 配置类型
      const configType = await this.auth.getConfigType();
      this.configType = configType || 'antigravity';
      logger.debug(
        `🔄 [AntigravityChatService] Using OAuth config: ${this.configType}`
      );
      logger.debug('🔄 [AntigravityChatService] Setting up user via loadCodeAssist...');

      const accessToken = await this.auth.getAccessToken();

      // Step 1: 调用 loadCodeAssist
      const loadRes = await this.callLoadCodeAssist(accessToken);
      logger.debug(
        '[AntigravityChatService] loadCodeAssist response:',
        JSON.stringify(loadRes)
      );

      // Step 2: 检查是否已有有效的 tier 和 projectId
      if (loadRes.currentTier) {
        this.userTier = loadRes.currentTier.id;

        if (loadRes.cloudaicompanionProject) {
          this.projectId = loadRes.cloudaicompanionProject;
          logger.debug(
            `✅ [AntigravityChatService] User already setup: tier=${this.userTier}, project=${this.projectId}`
          );
          this.projectIdInitialized = true;
          return;
        }

        // 有 tier 但没有 projectId，检查环境变量
        const envProjectId =
          process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
        if (envProjectId) {
          this.projectId = envProjectId;
          logger.debug(
            `✅ [AntigravityChatService] Using env project: ${this.projectId}`
          );
          this.projectIdInitialized = true;
          return;
        }

        // 需要通过 onboardUser 获取 projectId
        logger.debug(
          '⚠️ [AntigravityChatService] Has tier but no project, need onboarding...'
        );
      }

      // Step 3: 获取默认 tier 并调用 onboardUser
      const defaultTier = this.getDefaultTier(loadRes);
      logger.debug(
        `🔄 [AntigravityChatService] Onboarding user with tier: ${defaultTier.id}`
      );

      const result = await this.callOnboardUser(accessToken, defaultTier.id);
      this.projectId = result.projectId;
      this.userTier = defaultTier.id;

      logger.debug(
        `✅ [AntigravityChatService] User setup complete: tier=${this.userTier}, project=${this.projectId || '(managed)'}`
      );
    } catch (error) {
      logger.warn('Failed to setup user:', error);
      // 即使失败也标记为已初始化，避免重复尝试
      // 后续请求会因为缺少 projectId 而失败，但会返回更明确的错误
    }

    this.projectIdInitialized = true;
  }

  /**
   * 调用 loadCodeAssist API
   */
  private async callLoadCodeAssist(
    accessToken: string
  ): Promise<LoadCodeAssistResponse> {
    const url = `${ANTIGRAVITY_API_ENDPOINTS.production}${ANTIGRAVITY_API_PATHS.loadCodeAssist}`;
    const metadata = getClientMetadata(this.configType);
    const userAgent = getUserAgent(this.configType);

    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify({
        metadata,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`loadCodeAssist failed: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as LoadCodeAssistResponse;
  }

  /**
   * 从 loadCodeAssist 响应获取默认 tier
   */
  private getDefaultTier(res: LoadCodeAssistResponse): { id: UserTierId } {
    // 查找 isDefault=true 的 tier
    for (const tier of res.allowedTiers || []) {
      if (tier.isDefault) {
        return { id: tier.id };
      }
    }
    // 默认使用 FREE tier
    return { id: UserTierId.FREE };
  }

  /**
   * 调用 onboardUser API（轮询等待 LRO 完成）
   *
   * - FREE tier 不需要设置 cloudaicompanionProject（使用 managed project）
   * - 其他 tier 可以设置 cloudaicompanionProject
   * - 轮询间隔 5 秒
   */
  private async callOnboardUser(
    accessToken: string,
    tierId: UserTierId
  ): Promise<{ projectId: string | undefined }> {
    const url = `${ANTIGRAVITY_API_ENDPOINTS.production}${ANTIGRAVITY_API_PATHS.onboardUser}`;
    const metadata = getClientMetadata(this.configType);
    const userAgent = getUserAgent(this.configType);

    // 构建请求（FREE tier 不设置 cloudaicompanionProject）
    const requestBody: Record<string, unknown> = {
      tierId,
      metadata,
    };

    // 非 FREE tier 可以使用环境变量中的 projectId
    if (tierId !== UserTierId.FREE) {
      const envProjectId =
        process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
      if (envProjectId) {
        requestBody.cloudaicompanionProject = envProjectId;
        requestBody.metadata = {
          ...metadata,
          duetProject: envProjectId,
        };
      }
    }

    // 轮询调用 onboardUser 直到 done=true
    let attempts = 0;
    const maxAttempts = 30; // 最多 150 秒

    while (attempts < maxAttempts) {
      const response = await proxyFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`onboardUser failed: ${response.status} - ${errorText}`);
      }

      const lroRes = (await response.json()) as OnboardUserResponse;
      logger.debug(
        `[AntigravityChatService] onboardUser attempt ${attempts + 1}:`,
        JSON.stringify(lroRes)
      );

      if (lroRes.error) {
        throw new Error(
          `onboardUser error: ${lroRes.error.message || lroRes.error.code}`
        );
      }

      if (lroRes.done) {
        // LRO 完成
        const projectId = lroRes.response?.cloudaicompanionProject?.id;
        return { projectId };
      }

      // 等待 5 秒后重试
      logger.debug('[AntigravityChatService] onboardUser not done, waiting 5s...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempts++;
    }

    throw new Error('onboardUser timeout: LRO did not complete in time');
  }

  /**
   * 将内部 Message[] 转换为 Antigravity API 格式
   */
  private convertToAntigravityMessages(messages: Message[]): {
    systemInstruction: { parts: Array<{ text: string }> } | undefined;
    contents: AntigravityContent[];
  } {
    // 1. 提取 system 消息
    const systemMsg = messages.find((m) => m.role === 'system');
    const systemInstruction = systemMsg
      ? { parts: [{ text: getTextContent(systemMsg.content) }] }
      : undefined;

    // 2. 转换其他消息
    const contents: AntigravityContent[] = [];
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    // 收集 tool_call id 到 name 的映射
    const toolCallIdToName = new Map<string, string>();
    for (const msg of nonSystemMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === 'function') {
            toolCallIdToName.set(tc.id, tc.function.name);
          }
        }
      }
    }

    for (const msg of nonSystemMessages) {
      if (msg.role === 'user') {
        // User 消息
        const parts: AntigravityPart[] = [];

        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              parts.push({ text: part.text });
            }
            // 图片暂不支持
          }
        } else {
          parts.push({ text: msg.content });
        }

        contents.push({ role: 'user', parts });
      } else if (msg.role === 'assistant') {
        // Assistant (model) 消息
        const parts: AntigravityPart[] = [];

        // 添加文本内容
        const text = getTextContent(msg.content);
        if (text) {
          parts.push({ text });
        }

        // 转换 tool_calls 为 functionCall
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.type !== 'function') continue;

            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {
              logger.warn(`Failed to parse tool arguments: ${tc.function.arguments}`);
            }

            parts.push({
              functionCall: {
                name: tc.function.name,
                args,
                id: tc.id,
              },
            });
          }
        }

        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool 消息转为 functionResponse
        const toolName = toolCallIdToName.get(msg.tool_call_id || '');
        if (toolName) {
          let result: Record<string, unknown>;
          try {
            result = JSON.parse(getTextContent(msg.content));
          } catch {
            result = { result: getTextContent(msg.content) };
          }

          contents.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: toolName,
                  id: msg.tool_call_id,
                  response: result,
                },
              },
            ],
          });
        }
      }
    }

    // Antigravity 要求消息必须交替（user/model），并且以 user 开始
    // 合并相邻的同角色消息
    const mergedContents: AntigravityContent[] = [];
    for (const content of contents) {
      const lastContent = mergedContents[mergedContents.length - 1];
      if (lastContent?.role === content.role) {
        lastContent.parts = [...lastContent.parts, ...content.parts];
      } else {
        mergedContents.push(content);
      }
    }

    // 确保第一条消息是 user
    if (mergedContents.length > 0 && mergedContents[0].role !== 'user') {
      mergedContents.unshift({
        role: 'user',
        parts: [{ text: '[Conversation start]' }],
      });
    }

    return { systemInstruction, contents: mergedContents };
  }

  /**
   * 将工具定义转换为 Antigravity API 格式
   */
  private convertToAntigravityTools(
    tools?: Array<{ name: string; description: string; parameters: unknown }>
  ): AntigravityTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: cleanJsonSchemaForAntigravity(
        (tool.parameters as Record<string, unknown>) || {
          type: 'object',
          properties: {},
        }
      ),
    }));

    return [{ functionDeclarations }];
  }

  /**
   * 发起 API 请求
   */
  private async makeRequest(
    path: string,
    body: AntigravityRequest,
    signal?: AbortSignal
  ): Promise<Response> {
    const accessToken = await this.auth.getAccessToken();
    const url = `${ANTIGRAVITY_API_ENDPOINTS.production}${path}`;
    const userAgent = getUserAgent(this.configType);

    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Antigravity API error: ${response.status} - ${errorText}`);

      if (response.status === 401) {
        throw new Error('Authentication expired. Please run /login again.');
      }
      if (response.status === 403) {
        throw new Error(
          'Permission denied. Please check your Google account permissions.'
        );
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment and try again.');
      }

      throw new Error(`Antigravity API error: ${response.status} - ${errorText}`);
    }

    return response;
  }

  async chat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    logger.debug('🚀 [AntigravityChatService] Starting chat request');
    logger.debug('📝 [AntigravityChatService] Messages count:', messages.length);

    // 确保有有效的项目 ID
    await this.ensureProjectId();

    // 过滤孤儿 tool 消息
    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      logger.debug(
        `Filtered ${messages.length - filteredMessages.length} orphan tool messages`
      );
    }

    const { systemInstruction, contents } =
      this.convertToAntigravityMessages(filteredMessages);
    const antigravityTools = this.convertToAntigravityTools(tools);

    // 生成 user_prompt_id（与官方 Gemini CLI 保持一致）
    const userPromptId = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const requestBody: AntigravityRequest = {
      model: this.config.model,
      project: this.projectId,
      user_prompt_id: userPromptId,
      request: {
        contents,
        systemInstruction,
        generationConfig: {
          // 只有显式配置了 maxOutputTokens 才传，否则让 API 使用默认值
          ...(this.config.maxOutputTokens && { maxOutputTokens: this.config.maxOutputTokens }),
          temperature: this.config.temperature ?? 0.7,
        },
        tools: antigravityTools,
        session_id: this.sessionId,
      },
    };

    logger.debug('📤 [AntigravityChatService] Request:', {
      model: this.config.model,
      contentsCount: contents.length,
      hasSystemInstruction: !!systemInstruction,
      toolsCount: antigravityTools?.[0]?.functionDeclarations?.length || 0,
    });

    try {
      const response = await this.makeRequest(
        ANTIGRAVITY_API_PATHS.generateContent,
        requestBody,
        signal
      );

      const data = (await response.json()) as AntigravityResponse;

      const requestDuration = Date.now() - startTime;
      logger.debug(
        '📥 [AntigravityChatService] Response received in',
        requestDuration,
        'ms'
      );

      // 解析响应
      let textContent = '';
      const toolCalls: ChatCompletionMessageToolCall[] = [];

      const candidate = data.response?.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      for (const part of parts) {
        if (part.text) {
          textContent += part.text;
        } else if (part.functionCall) {
          const fc = part.functionCall;
          toolCalls.push({
            id: fc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args || {}),
            },
          });
        }
      }

      const usageMetadata = data.response?.usageMetadata;

      const result: ChatResponse = {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          promptTokens: usageMetadata?.promptTokenCount || 0,
          completionTokens: usageMetadata?.candidatesTokenCount || 0,
          totalTokens: usageMetadata?.totalTokenCount || 0,
        },
      };

      logger.debug('✅ [AntigravityChatService] Chat completed:', {
        contentLength: result.content.length,
        toolCallsCount: result.toolCalls?.length || 0,
        usage: result.usage,
      });

      return result;
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      logger.error(
        '❌ [AntigravityChatService] Chat failed after',
        requestDuration,
        'ms'
      );
      logger.error('❌ [AntigravityChatService] Error:', error);
      throw error;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    logger.debug('🚀 [AntigravityChatService] Starting stream request');

    // 确保有有效的项目 ID
    await this.ensureProjectId();

    // 过滤孤儿 tool 消息
    const filteredMessages = filterOrphanToolMessages(messages);
    const { systemInstruction, contents } =
      this.convertToAntigravityMessages(filteredMessages);
    const antigravityTools = this.convertToAntigravityTools(tools);

    // 生成 user_prompt_id（与官方 Gemini CLI 保持一致）
    const userPromptId = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const requestBody: AntigravityRequest = {
      model: this.config.model,
      project: this.projectId,
      user_prompt_id: userPromptId,
      request: {
        contents,
        systemInstruction,
        generationConfig: {
          // 只有显式配置了 maxOutputTokens 才传，否则让 API 使用默认值
          ...(this.config.maxOutputTokens && { maxOutputTokens: this.config.maxOutputTokens }),
          temperature: this.config.temperature ?? 0.7,
        },
        tools: antigravityTools,
        session_id: this.sessionId,
      },
    };

    try {
      const accessToken = await this.auth.getAccessToken();
      const url = `${ANTIGRAVITY_API_ENDPOINTS.production}${ANTIGRAVITY_API_PATHS.streamGenerateContent}?alt=sse`;
      const userAgent = getUserAgent(this.configType);

      const response = await proxyFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': userAgent,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Antigravity API error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let eventCount = 0;

      const requestDuration = Date.now() - startTime;
      logger.debug(
        '📥 [AntigravityChatService] Stream started in',
        requestDuration,
        'ms'
      );

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              yield { finishReason: 'stop' };
              continue;
            }

            try {
              const chunk = JSON.parse(data) as AntigravityStreamChunk;
              eventCount++;

              if (chunk.usageMetadata) {
                yield {
                  usage: {
                    promptTokens: chunk.usageMetadata.promptTokenCount || 0,
                    completionTokens: chunk.usageMetadata.candidatesTokenCount || 0,
                    totalTokens: chunk.usageMetadata.totalTokenCount || 0,
                  },
                };
              }

              const candidate = chunk.candidates?.[0];
              const parts = candidate?.content?.parts || [];

              for (const part of parts) {
                if (part.text) {
                  yield { content: part.text };
                } else if (part.functionCall) {
                  const fc = part.functionCall;
                  yield {
                    toolCalls: [
                      {
                        id:
                          fc.id ||
                          `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                        type: 'function',
                        function: {
                          name: fc.name,
                          arguments: JSON.stringify(fc.args || {}),
                        },
                      },
                    ],
                  };
                }
              }

              const finishReason = candidate?.finishReason;
              if (finishReason) {
                const mappedReason =
                  finishReason === 'STOP'
                    ? 'stop'
                    : finishReason === 'MAX_TOKENS'
                      ? 'length'
                      : finishReason.toLowerCase();
                yield { finishReason: mappedReason };
              }
            } catch (_parseError) {
              logger.debug('Failed to parse SSE data:', data);
            }
          }
        }
      }

      logger.debug('✅ [AntigravityChatService] Stream completed:', {
        eventCount,
        duration: Date.now() - startTime + 'ms',
      });
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      logger.error(
        '❌ [AntigravityChatService] Stream failed after',
        requestDuration,
        'ms'
      );
      logger.error('❌ [AntigravityChatService] Error:', error);
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    logger.debug('🔄 [AntigravityChatService] Updating configuration');
    this.config = { ...this.config, ...newConfig };
    logger.debug('✅ [AntigravityChatService] Configuration updated');
  }
}
