import type { BladeConfig, ModelConfig } from '../config/types.js';
import { toTaskFailure } from '../context/taskFailure.js';
import type { SessionTaskFailureCode } from '../context/types.js';
import { PiAIChatService } from './PiAIChatService.js';
import { resolveModelConfig } from './pi/resolveModelConfig.js';

export interface ProviderProbeResult {
  ok: boolean;
  providerId: string;
  modelConfigId: string;
  model: string;
  wireApi: string;
  latencyMs: number;
  code: 'ok' | SessionTaskFailureCode;
  message: string;
}

export interface ProviderProbeOptions {
  timeoutMs?: number;
}

export async function probeModelProvider(
  modelConfig: ModelConfig,
  config: Pick<BladeConfig, 'temperature' | 'timeout'>,
  options: ProviderProbeOptions = {}
): Promise<ProviderProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 20_000;
  let wireApi = 'unknown';

  try {
    const resolved = resolveModelConfig(modelConfig, config, 'off');
    wireApi = resolved.model.api;
    const service = new PiAIChatService({
      ...resolved.chat,
      temperature: 0,
      maxOutputTokens: 8,
      timeout: timeoutMs,
      streamIdleTimeout: timeoutMs,
      maxRetries: 0,
      fallbackModels: [],
    });
    const response = await service.chat(
      [{ role: 'user', content: 'Reply with OK.' }],
      undefined,
      AbortSignal.timeout(timeoutMs),
      {
        providerAdmission: {
          sessionId: `provider-health:${modelConfig.id}`,
          ownerId: `provider-health:${modelConfig.id}`,
          requestClass: 'internal',
        },
      }
    );
    const responded = Boolean(
      response.content ||
        response.reasoningContent ||
        response.finishReason ||
        response.usage
    );
    if (!responded) {
      throw new Error('Provider returned an empty response');
    }

    return {
      ok: true,
      providerId: modelConfig.provider,
      modelConfigId: modelConfig.id,
      model: modelConfig.model,
      wireApi,
      latencyMs: Date.now() - startedAt,
      code: 'ok',
      message: 'Provider responded successfully.',
    };
  } catch (error) {
    const failure = toTaskFailure(error);
    return {
      ok: false,
      providerId: modelConfig.provider,
      modelConfigId: modelConfig.id,
      model: modelConfig.model,
      wireApi,
      latencyMs: Date.now() - startedAt,
      code: failure.code,
      message: failure.message,
    };
  }
}
