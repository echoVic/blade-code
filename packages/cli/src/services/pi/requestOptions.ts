import type { Api, Model, ThinkingLevel, Usage } from '@earendil-works/pi-ai';
import type {
  ChatConfig,
  ChatRequestOptions,
  UsageInfo,
} from '../ChatServiceInterface.js';
import { resolveResponseVerbosity } from './responseVerbosity.js';

type PayloadHook = (
  payload: unknown,
  model: Model<Api>
) => unknown | undefined | Promise<unknown | undefined>;

function addPayloadTransform(
  options: Record<string, unknown>,
  transform: (payload: unknown, model: Model<Api>) => unknown
): void {
  const previous = options.onPayload as PayloadHook | undefined;
  options.onPayload = async (payload: unknown, model: Model<Api>) => {
    const previousResult = previous ? await previous(payload, model) : payload;
    return transform(previousResult === undefined ? payload : previousResult, model);
  };
}

function reasoningLevel(config: ChatConfig): ThinkingLevel | undefined {
  if (!config.reasoningEnabled) return undefined;
  return config.reasoningEffort ?? config.reasoningLevel ?? 'high';
}

function googleThinkingLevel(
  reasoning: ThinkingLevel
): 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' {
  switch (reasoning) {
    case 'minimal':
      return 'MINIMAL';
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    default:
      return 'HIGH';
  }
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
    if (model.api === 'google-generative-ai' || model.api === 'google-vertex') {
      options.thinking = { enabled: false };
    }
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
        level: googleThinkingLevel(reasoning),
      };
      break;
    case 'mistral-conversations':
      options.reasoningEffort = 'high';
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

function addServiceTierOptions(
  options: Record<string, unknown>,
  model: Model<Api>,
  config: ChatConfig
): void {
  const serviceTier = config.serviceTier;
  if (!serviceTier) return;
  if (
    model.api === 'openai-responses' ||
    model.api === 'openai-codex-responses' ||
    model.api === 'azure-openai-responses'
  ) {
    options.serviceTier = serviceTier;
    return;
  }
  if (
    model.api !== 'openai-completions' &&
    !(model.api === 'anthropic-messages' && serviceTier === 'fast')
  ) {
    return;
  }
  addPayloadTransform(options, (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }
    return model.api === 'anthropic-messages'
      ? { ...payload, speed: 'fast' }
      : { ...payload, service_tier: serviceTier };
  });
}

function addResponseVerbosityOptions(
  options: Record<string, unknown>,
  model: Model<Api>,
  config: ChatConfig
): void {
  const verbosity = config.responseVerbosity;
  if (!verbosity) return;
  resolveResponseVerbosity(model, verbosity);
  if (model.api === 'openai-codex-responses') {
    options.textVerbosity = verbosity;
    return;
  }
  addPayloadTransform(options, (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }
    if (model.api === 'openai-completions') {
      return { ...payload, verbosity };
    }
    const currentText =
      'text' in payload &&
      payload.text &&
      typeof payload.text === 'object' &&
      !Array.isArray(payload.text)
        ? payload.text
        : {};
    return {
      ...payload,
      text: { ...currentText, verbosity },
    };
  });
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
    temperature: requestOptions?.temperature ?? config.temperature ?? 0,
    maxTokens: requestOptions?.maxOutputTokens ?? config.maxOutputTokens,
    timeoutMs: config.timeout,
    maxRetries: 0,
    cacheRetention: config.enablePromptCaching ? 'short' : 'none',
  };
  addThinkingOptions(options, model, config, disableThinking);
  addToolChoice(options, model.api, requestOptions?.toolChoice?.toolName);
  addServiceTierOptions(options, model, config);
  addResponseVerbosityOptions(options, model, config);

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
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'STREAM_IDLE_TIMEOUT'
  ) {
    return false;
  }
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
    'stream closed before completion',
    'temporarily unavailable',
    'upstream_error',
  ].some((marker) => message.includes(marker));
}
