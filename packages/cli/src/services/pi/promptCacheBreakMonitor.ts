import { createHash } from 'node:crypto';
import type { Context, Tool as PiTool } from '@earendil-works/pi-ai';
import type { PromptCacheBreakInfo, UsageInfo } from '../ChatServiceInterface.js';

interface PromptCacheToolFingerprint {
  identityHash: string;
  contractHash: string;
}

interface PromptCacheRequestState {
  modelIdentity: string;
  systemHash: string;
  systemChars: number;
  toolsHash: string;
  toolFingerprints: PromptCacheToolFingerprint[];
  policyHash: string;
  contextEpoch: string;
  retention: 'none' | 'short' | 'long';
  promptTokens: number;
  cacheReadTokens: number;
  recordedAt: number;
  callCount: number;
}

export interface PromptCacheObservation {
  sessionId: string;
  modelIdentity: string;
  context: Context;
  tools?: PiTool[];
  retention: 'none' | 'short' | 'long';
  policy: Readonly<Record<string, unknown>>;
  contextEpoch?: string;
  usage: UsageInfo;
  now?: number;
}

const MAX_TRACKED_SESSIONS = 32;
const MIN_CACHE_READ_BASELINE = 1_000;
const MIN_CACHE_MISS_TOKENS = 512;
const MAX_CACHE_MISS_TOKENS = 2_000;
const CACHE_MISS_BASELINE_RATIO = 0.1;
const CACHE_READ_DROP_RATIO = 0.05;
const CONTEXT_REDUCTION_RATIO = 0.9;
const SHORT_CACHE_TTL_MS = 5 * 60_000;
const LONG_CACHE_TTL_MS = 60 * 60_000;

export class PromptCacheBreakMonitor {
  private readonly sessions = new Map<string, PromptCacheRequestState>();

  observe(input: PromptCacheObservation): PromptCacheBreakInfo | undefined {
    if (input.retention === 'none') {
      this.sessions.delete(input.sessionId);
      return undefined;
    }

    const now = input.now ?? Date.now();
    const current = buildState(input, now);
    const previous = this.sessions.get(input.sessionId);
    current.callCount = (previous?.callCount ?? 0) + 1;
    this.touch(input.sessionId, current);
    if (previous && current.contextEpoch !== previous.contextEpoch) {
      return undefined;
    }
    if (!previous || previous.cacheReadTokens < MIN_CACHE_READ_BASELINE) {
      return undefined;
    }

    const tokenDrop = previous.cacheReadTokens - current.cacheReadTokens;
    const requiredTokenDrop = Math.min(
      MAX_CACHE_MISS_TOKENS,
      Math.max(
        MIN_CACHE_MISS_TOKENS,
        previous.cacheReadTokens * CACHE_MISS_BASELINE_RATIO
      )
    );
    if (
      tokenDrop < requiredTokenDrop ||
      current.cacheReadTokens >= previous.cacheReadTokens * (1 - CACHE_READ_DROP_RATIO)
    ) {
      return undefined;
    }

    const modelChanged = current.modelIdentity !== previous.modelIdentity;
    const systemPromptChanged = current.systemHash !== previous.systemHash;
    const toolsChanged = current.toolsHash !== previous.toolsHash;
    const requestPolicyChanged = current.policyHash !== previous.policyHash;
    const stablePrefixChanged =
      modelChanged || systemPromptChanged || toolsChanged || requestPolicyChanged;

    if (
      !stablePrefixChanged &&
      current.promptTokens < previous.promptTokens * CONTEXT_REDUCTION_RATIO
    ) {
      return undefined;
    }

    const elapsedMs = Math.max(0, now - previous.recordedAt);
    const ttlMs =
      previous.retention === 'long' ? LONG_CACHE_TTL_MS : SHORT_CACHE_TTL_MS;
    const reason = modelChanged
      ? 'model_changed'
      : systemPromptChanged
        ? 'system_prompt_changed'
        : toolsChanged
          ? 'tools_changed'
          : requestPolicyChanged
            ? 'request_policy_changed'
            : elapsedMs >= ttlMs
              ? 'ttl_expired'
              : 'server_side';
    const toolChanges = diffTools(previous, current);

    return {
      reason,
      previousCacheReadTokens: previous.cacheReadTokens,
      cacheReadTokens: current.cacheReadTokens,
      cacheWriteTokens: Math.max(0, input.usage.cacheCreationInputTokens ?? 0),
      tokenDrop,
      elapsedMs,
      callNumber: current.callCount,
      systemPromptChanged,
      systemCharDelta: current.systemChars - previous.systemChars,
      toolsChanged,
      addedToolCount: toolChanges.added,
      removedToolCount: toolChanges.removed,
      changedToolCount: toolChanges.changed,
      modelChanged,
      requestPolicyChanged,
    };
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    } else {
      this.sessions.clear();
    }
  }

  statsForTests(): { sessions: number } {
    return { sessions: this.sessions.size };
  }

  private touch(sessionId: string, state: PromptCacheRequestState): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, state);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

function buildState(
  input: PromptCacheObservation,
  recordedAt: number
): PromptCacheRequestState {
  const toolFingerprints = [...(input.tools ?? input.context.tools ?? [])]
    .map((tool) => ({
      identityHash: hash(tool.name),
      contractHash: hash(stableSerialize(tool)),
    }))
    .sort((left, right) =>
      left.identityHash < right.identityHash
        ? -1
        : left.identityHash > right.identityHash
          ? 1
          : 0
    );
  return {
    modelIdentity: input.modelIdentity,
    systemHash: hash(input.context.systemPrompt ?? ''),
    systemChars: input.context.systemPrompt?.length ?? 0,
    toolsHash: hash(stableSerialize(toolFingerprints)),
    toolFingerprints,
    policyHash: hash(stableSerialize(input.policy)),
    contextEpoch: input.contextEpoch ?? '',
    retention: input.retention,
    promptTokens: Number.isFinite(input.usage.promptTokens)
      ? Math.max(0, input.usage.promptTokens)
      : 0,
    cacheReadTokens: Math.max(0, input.usage.cacheReadInputTokens ?? 0),
    recordedAt,
    callCount: 1,
  };
}

function diffTools(
  previous: PromptCacheRequestState,
  current: PromptCacheRequestState
): { added: number; removed: number; changed: number } {
  const previousTools = new Map(
    previous.toolFingerprints.map((tool) => [tool.identityHash, tool.contractHash])
  );
  const currentTools = new Map(
    current.toolFingerprints.map((tool) => [tool.identityHash, tool.contractHash])
  );
  return {
    added: [...currentTools.keys()].filter((identity) => !previousTools.has(identity))
      .length,
    removed: [...previousTools.keys()].filter((identity) => !currentTools.has(identity))
      .length,
    changed: [...currentTools].filter(
      ([identity, contractHash]) =>
        previousTools.has(identity) && previousTools.get(identity) !== contractHash
    ).length,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
