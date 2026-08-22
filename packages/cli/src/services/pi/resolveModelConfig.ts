import { createHash } from 'node:crypto';
import type { Model } from '@earendil-works/pi-ai';
import type {
  BladeConfig,
  ModelConfig,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import type { ChatConfig, ChatFallbackModel } from '../ChatServiceInterface.js';
import { getPiModelCatalog, type PiModelCatalog } from './PiModelCatalog.js';
import {
  type ReasoningEffortConfiguration,
  type ReasoningEffortSelection,
  resolveReasoningEffort,
} from './reasoningEffort.js';
import {
  type ResponseVerbosityConfiguration,
  resolveResponseVerbosity,
} from './responseVerbosity.js';
import { resolveServiceTier, type ServiceTierConfiguration } from './serviceTier.js';

export interface ResolvedModelConfig {
  config: ModelConfig;
  model: Model<string>;
  displayName: string;
  chat: ChatConfig;
  reasoning: ReasoningEffortConfiguration;
  serviceTier: ServiceTierConfiguration;
  responseVerbosity: ResponseVerbosityConfiguration;
}

const ANTHROPIC_FAST_MODE_BETA = 'fast-mode-2026-02-01';

function resolveCustomHeaders(
  headers: Record<string, string> | undefined,
  model: Model<string>,
  serviceTier: ServiceTierConfiguration
): Record<string, string> | undefined {
  if (model.api !== 'anthropic-messages' || serviceTier.providerValue !== 'fast') {
    return headers;
  }
  const projected = { ...headers };
  const key =
    Object.keys(projected).find((name) => name.toLowerCase() === 'anthropic-beta') ??
    'anthropic-beta';
  const values = new Set(
    (projected[key] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  values.add(ANTHROPIC_FAST_MODE_BETA);
  projected[key] = [...values].join(',');
  return projected;
}

export function getModelApiKeyEnvironmentVariable(modelConfigId: string): string {
  const digest = createHash('sha256')
    .update(modelConfigId)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
  return `BLADE_MODEL_API_KEY_${digest}`;
}

type ModelResolutionAppConfig = Pick<
  BladeConfig,
  | 'temperature'
  | 'timeout'
  | 'providerCircuitBreakerOpenMs'
  | 'providerRequestConcurrency'
  | 'providerGlobalConcurrency'
  | 'providerOwnerConcurrency'
  | 'providerRequestAdmissionMs'
  | 'providerRequestPendingBytes'
> &
  Partial<Pick<BladeConfig, 'models'>>;

function resolveFallbackModels(
  primary: ModelConfig,
  appConfig: ModelResolutionAppConfig
): ChatFallbackModel[] | undefined {
  if (!primary.fallbackModels?.length) return undefined;

  return primary.fallbackModels.map((fallback) => {
    const candidates = (appConfig.models ?? []).filter(
      (candidate) =>
        candidate.provider === fallback.provider && candidate.model === fallback.model
    );
    const configured = fallback.configId
      ? (appConfig.models ?? []).find((candidate) => candidate.id === fallback.configId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;

    if (fallback.configId && !configured) {
      throw new Error(`Unknown fallback model config ID: ${fallback.configId}`);
    }
    if (
      configured &&
      (configured.provider !== fallback.provider || configured.model !== fallback.model)
    ) {
      throw new Error(
        `Fallback model config ${configured.id} does not match ` +
          `${fallback.provider}/${fallback.model}`
      );
    }
    if (!fallback.configId && candidates.length > 1) {
      throw new Error(
        `Fallback model ${fallback.provider}/${fallback.model} is ambiguous; ` +
          'set configId'
      );
    }
    if (!configured) return fallback;

    const sameProvider = configured.provider === primary.provider;
    return {
      ...fallback,
      configId: configured.id,
      channel: {
        apiKey:
          process.env[getModelApiKeyEnvironmentVariable(configured.id)] ??
          (sameProvider ? process.env.BLADE_API_KEY : undefined),
        baseUrl:
          configured.overrides?.baseUrl ??
          (sameProvider ? process.env.BLADE_BASE_URL : undefined),
        temperature: configured.overrides?.temperature ?? appConfig.temperature,
        maxOutputTokens: configured.overrides?.maxOutputTokens,
        timeout: configured.overrides?.timeout ?? appConfig.timeout,
        streamIdleTimeout: configured.overrides?.streamIdleTimeout,
        apiVersion: configured.overrides?.apiVersion,
        customHeaders: configured.overrides?.customHeaders,
        enablePromptCaching: configured.overrides?.enablePromptCaching,
      },
    };
  });
}

export function resolveModelConfig(
  config: ModelConfig,
  appConfig: ModelResolutionAppConfig,
  reasoningSelection: ReasoningEffortSelection,
  catalog: PiModelCatalog = getPiModelCatalog(),
  serviceTierSelection: ServiceTierSelection = 'auto',
  responseVerbositySelection: ResponseVerbositySelection = 'auto'
): ResolvedModelConfig {
  const model = catalog.resolveConfig(config);
  const reasoning = resolveReasoningEffort(model, reasoningSelection);
  const serviceTier = resolveServiceTier(model, serviceTierSelection);
  const responseVerbosity = resolveResponseVerbosity(model, responseVerbositySelection);
  const overrides = config.overrides;
  return {
    config,
    model,
    displayName: config.displayName ?? model.name,
    chat: {
      provider: config.provider,
      model: config.model,
      apiKey:
        process.env[getModelApiKeyEnvironmentVariable(config.id)] ??
        process.env.BLADE_API_KEY,
      baseUrl: process.env.BLADE_BASE_URL ?? overrides?.baseUrl,
      temperature: overrides?.temperature ?? appConfig.temperature,
      maxContextTokens: model.contextWindow,
      maxOutputTokens: overrides?.maxOutputTokens,
      timeout: overrides?.timeout ?? appConfig.timeout,
      streamIdleTimeout: overrides?.streamIdleTimeout,
      reasoningEnabled: reasoning.effective !== 'off',
      ...(reasoning.effective === 'off'
        ? {}
        : { reasoningEffort: reasoning.effective }),
      ...(serviceTier.providerValue ? { serviceTier: serviceTier.providerValue } : {}),
      ...(responseVerbosity.providerValue
        ? { responseVerbosity: responseVerbosity.providerValue }
        : {}),
      fallbackModels: resolveFallbackModels(config, appConfig),
      enablePromptCaching: overrides?.enablePromptCaching,
      customHeaders: resolveCustomHeaders(overrides?.customHeaders, model, serviceTier),
      apiVersion: overrides?.apiVersion,
      maxRetries: overrides?.maxRetries,
      providerCircuitBreakerOpenMs: appConfig.providerCircuitBreakerOpenMs,
      providerRequestConcurrency: appConfig.providerRequestConcurrency,
      providerGlobalConcurrency: appConfig.providerGlobalConcurrency,
      providerOwnerConcurrency: appConfig.providerOwnerConcurrency,
      providerRequestAdmissionMs: appConfig.providerRequestAdmissionMs,
      providerRequestPendingBytes: appConfig.providerRequestPendingBytes,
      modelCatalog: catalog,
    },
    reasoning,
    serviceTier,
    responseVerbosity,
  };
}

export function getModelDisplayName(
  config: ModelConfig,
  catalog: PiModelCatalog = getPiModelCatalog()
): string {
  try {
    return config.displayName ?? catalog.getModel(config.provider, config.model).name;
  } catch {
    return config.displayName ?? config.model;
  }
}
