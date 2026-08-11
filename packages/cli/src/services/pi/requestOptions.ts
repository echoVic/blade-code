import type { Api, Model, ThinkingLevel, Usage } from '@earendil-works/pi-ai';
import type {
  ChatConfig,
  ChatRequestOptions,
  UsageInfo,
} from '../ChatServiceInterface.js';
import {
  classifyProviderRetry,
  type ProviderResponseMetadata,
} from './providerRetry.js';
import { resolveResponseVerbosity } from './responseVerbosity.js';

type PayloadHook = (
  payload: unknown,
  model: Model<Api>
) => unknown | undefined | Promise<unknown | undefined>;

type ResponseHook = (
  response: { status: number; headers: Record<string, string> },
  model: Model<Api>
) => void | Promise<void>;

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

function projectProviderResponse(
  statusCode: number,
  headers: Pick<Headers, 'get'>
): ProviderResponseMetadata {
  const shouldRetry = headers.get('x-should-retry');
  return {
    statusCode,
    ...(headers.get('retry-after') !== null
      ? { retryAfter: headers.get('retry-after') ?? undefined }
      : {}),
    ...(headers.get('retry-after-ms') !== null
      ? { retryAfterMs: headers.get('retry-after-ms') ?? undefined }
      : {}),
    ...(shouldRetry === 'true' || shouldRetry === 'false' ? { shouldRetry } : {}),
  };
}

const FETCH_OBSERVABLE_APIS = new Set<Api>([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'pi-messages',
]);

export function observePiProviderResponses(
  options: Record<string, unknown>,
  model: Model<Api>,
  onResponse: (response: ProviderResponseMetadata) => void
): void {
  const previous = options.onResponse as ResponseHook | undefined;
  options.onResponse = async (
    response: { status: number; headers: Record<string, string> },
    responseModel: Model<Api>
  ) => {
    const headers = new Headers(response.headers);
    onResponse(projectProviderResponse(response.status, headers));
    await previous?.(response, responseModel);
  };

  if (!FETCH_OBSERVABLE_APIS.has(model.api) || typeof globalThis.fetch !== 'function') {
    return;
  }
  const providerFetch =
    typeof options.fetch === 'function'
      ? (options.fetch as typeof globalThis.fetch)
      : globalThis.fetch.bind(globalThis);
  options.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const response = await providerFetch(input, init);
    onResponse(projectProviderResponse(response.status, response.headers));
    return response;
  };
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
  return classifyProviderRetry(error).retryable;
}
