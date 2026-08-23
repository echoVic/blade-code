import { createHash } from 'node:crypto';
import type { Message, UsageInfo } from '../services/ChatServiceInterface.js';
import { TokenCounter } from './TokenCounter.js';

export type ContextTokenSource =
  | 'provider'
  | 'provider_plus_estimate'
  | 'local_estimate';

export interface ContextTokenRequestProfile {
  fingerprint: string;
  estimatedFixedTokens: number;
}

export interface ContextTokenProjection {
  contextTokens: number;
  source: ContextTokenSource;
  estimatedPendingTokens?: number;
}

interface ProviderTokenBaseline {
  contextTokens: number;
  contextRevision: number;
  estimatedFixedTokens: number;
  historyLength: number;
  modelName: string;
  requestFingerprint: string;
}

function safeTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function addTokens(left: number, right: number): number {
  if (left >= Number.MAX_SAFE_INTEGER - right) return Number.MAX_SAFE_INTEGER;
  return left + right;
}

function serializeRequestPart(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Context token request profile is not serializable');
  }
  return serialized;
}

export function resolveProviderContextTokens(usage: UsageInfo): number | undefined {
  const promptTokens = safeTokenCount(usage.promptTokens)
    ? usage.promptTokens
    : undefined;
  const completionTokens = safeTokenCount(usage.completionTokens)
    ? usage.completionTokens
    : undefined;
  const reportedTotal = safeTokenCount(usage.totalTokens)
    ? usage.totalTokens
    : undefined;
  const summed =
    promptTokens !== undefined && completionTokens !== undefined
      ? addTokens(promptTokens, completionTokens)
      : undefined;

  if (reportedTotal === undefined) return summed;
  if (summed === undefined) return reportedTotal;
  return Math.max(reportedTotal, summed);
}

export function createContextTokenRequestProfile(
  systemMessages: readonly Message[],
  tools: readonly unknown[],
  modelName: string
): ContextTokenRequestProfile {
  const serializedTools = serializeRequestPart(tools);
  const fingerprint = createHash('sha256')
    .update(modelName)
    .update('\0')
    .update(serializeRequestPart(systemMessages))
    .update('\0')
    .update(serializedTools)
    .digest('hex');
  const toolTokens =
    tools.length === 0
      ? 0
      : addTokens(
          TokenCounter.countTextTokens(serializedTools, modelName),
          tools.length * 8
        );

  return {
    fingerprint,
    estimatedFixedTokens: addTokens(
      TokenCounter.countTokens(systemMessages, modelName),
      toolTokens
    ),
  };
}

export class ContextTokenTracker {
  private baseline?: ProviderTokenBaseline;

  recordProviderUsage(input: {
    usage: UsageInfo | undefined;
    contextRevision: number;
    historyLength: number;
    modelName: string;
    requestProfile: ContextTokenRequestProfile;
  }): void {
    const contextTokens = input.usage
      ? resolveProviderContextTokens(input.usage)
      : undefined;
    if (
      contextTokens === undefined ||
      !safeTokenCount(input.contextRevision) ||
      !safeTokenCount(input.historyLength)
    ) {
      this.baseline = undefined;
      return;
    }

    this.baseline = {
      contextTokens,
      contextRevision: input.contextRevision,
      estimatedFixedTokens: input.requestProfile.estimatedFixedTokens,
      historyLength: input.historyLength,
      modelName: input.modelName,
      requestFingerprint: input.requestProfile.fingerprint,
    };
  }

  reset(): void {
    this.baseline = undefined;
  }

  project(input: {
    history: readonly Message[];
    pendingMessages?: readonly Message[];
    contextRevision: number;
    modelName: string;
    requestProfile: ContextTokenRequestProfile;
  }): ContextTokenProjection {
    const pendingMessages = input.pendingMessages ?? [];
    const baseline = this.baseline;
    if (
      !baseline ||
      baseline.contextRevision !== input.contextRevision ||
      input.history.length < baseline.historyLength
    ) {
      return this.projectLocally(input.history, pendingMessages, input);
    }

    const appended = input.history.slice(baseline.historyLength);
    if (appended.length > 0 && appended[0]?.role !== 'assistant') {
      return this.projectLocally(input.history, pendingMessages, input);
    }

    // The Provider total already includes its assistant response. Only messages
    // appended after that response need a local estimate for the next request.
    const pendingSinceProvider = [
      ...(appended.length > 0 ? appended.slice(1) : []),
      ...pendingMessages,
    ];
    const messageDeltaTokens = TokenCounter.countTokens(
      pendingSinceProvider,
      input.modelName
    );
    const fixedContextGrowth = Math.max(
      0,
      input.requestProfile.estimatedFixedTokens - baseline.estimatedFixedTokens
    );
    const estimatedPendingTokens = addTokens(messageDeltaTokens, fixedContextGrowth);
    const requestShapeChanged =
      baseline.modelName !== input.modelName ||
      baseline.requestFingerprint !== input.requestProfile.fingerprint;

    return {
      contextTokens: addTokens(baseline.contextTokens, estimatedPendingTokens),
      source:
        estimatedPendingTokens > 0 || requestShapeChanged
          ? 'provider_plus_estimate'
          : 'provider',
      estimatedPendingTokens,
    };
  }

  private projectLocally(
    history: readonly Message[],
    pendingMessages: readonly Message[],
    input: {
      modelName: string;
      requestProfile: ContextTokenRequestProfile;
    }
  ): ContextTokenProjection {
    const historyTokens = TokenCounter.countTokens(
      [...history, ...pendingMessages],
      input.modelName
    );
    return {
      contextTokens: addTokens(
        input.requestProfile.estimatedFixedTokens,
        historyTokens
      ),
      source: 'local_estimate',
    };
  }
}
