import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import type {
  ChatConfig,
  ChatRequestOptions,
  UsageInfo,
} from '../ChatServiceInterface.js';

function reasoningLevel(config: ChatConfig): 'low' | 'medium' | 'high' | undefined {
  if (!config.reasoningEnabled) return undefined;
  return config.reasoningLevel ?? 'high';
}

function addThinkingOptions(
  options: Record<string, unknown>,
  model: Model<Api>,
  config: ChatConfig,
  disabled: boolean
): void {
  const reasoning = disabled ? undefined : reasoningLevel(config);
  if (!reasoning) {
    if (model.api === 'anthropic-messages') options.thinkingEnabled = false;
    return;
  }

  switch (model.api) {
    case 'anthropic-messages':
      options.thinkingEnabled = true;
      options.effort = reasoning;
      break;
    case 'google-generative-ai':
    case 'google-vertex':
      options.thinking = {
        enabled: true,
      };
      break;
    case 'bedrock-converse-stream':
    case 'pi-messages':
      options.reasoning = reasoning;
      break;
    default:
      options.reasoningEffort = reasoning;
  }
}

function addToolChoice(
  options: Record<string, unknown>,
  api: Api,
  toolName?: string
): void {
  if (!toolName) return;
  switch (api) {
    case 'anthropic-messages':
    case 'bedrock-converse-stream':
      options.toolChoice = { type: 'tool', name: toolName };
      break;
    case 'openai-completions':
    case 'mistral-conversations':
    case 'pi-messages':
      options.toolChoice = {
        type: 'function',
        function: { name: toolName },
      };
      break;
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses':
      options.toolChoice = { type: 'function', name: toolName };
      break;
    case 'google-generative-ai':
    case 'google-vertex':
      options.toolChoice = 'any';
      break;
  }
}

export function buildPiOptions(
  config: ChatConfig,
  model: Model<Api>,
  signal?: AbortSignal,
  requestOptions?: ChatRequestOptions,
  disableThinking = false
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    apiKey: config.apiKey,
    headers: config.customHeaders,
    signal,
    temperature: config.temperature ?? 0,
    maxTokens: config.maxOutputTokens,
    timeoutMs: config.timeout,
    maxRetries: 0,
    cacheRetention: config.enablePromptCaching ? 'short' : 'none',
  };
  addThinkingOptions(options, model, config, disableThinking);
  addToolChoice(options, model.api, requestOptions?.toolChoice?.toolName);

  if (model.api === 'azure-openai-responses') {
    options.azureBaseUrl = config.baseUrl;
    options.azureApiVersion = config.apiVersion;
    options.azureDeploymentName = model.id;
  }
  return options;
}

export function convertPiUsage(usage: Usage): UsageInfo {
  return {
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
    ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
    ...(usage.cacheWrite > 0 ? { cacheCreationInputTokens: usage.cacheWrite } : {}),
    ...(usage.cacheRead > 0 ? { cacheReadInputTokens: usage.cacheRead } : {}),
  };
}

export function isFallbackablePiError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const contextErrors = [
    'prompt_too_long',
    'prompt is too long',
    'maximum context length',
    'context length exceeded',
    'context_length_exceeded',
    'request too large',
  ];
  if (contextErrors.some((marker) => message.includes(marker))) return false;
  const statusMatch = message.match(
    /\b(?:status(?:\s+code)?|http)[:\s]+(408|409|429|5\d\d)\b/
  );
  if (statusMatch) return true;

  return [
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'etimedout',
    'fetch failed',
    'network error',
    'socket hang up',
  ].some((marker) => message.includes(marker));
}
