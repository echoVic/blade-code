const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function stableSerialize(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return `{${entries
      .map(
        ([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(input: string): string {
  let hash = FNV_OFFSET_BASIS >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16);
}

export function normalizeToolArguments(argumentsValue: unknown): string {
  return typeof argumentsValue === 'string'
    ? argumentsValue
    : stableSerialize(argumentsValue ?? {});
}

export function normalizeSubagentStatus(
  status: unknown
): 'running' | 'completed' | 'failed' {
  return status === 'completed'
    ? 'completed'
    : status === 'failed' || status === 'cancelled'
      ? 'failed'
      : 'running';
}

export function makeToolCallId({
  explicitId,
  messageId,
  toolName,
  argumentsValue,
  toolKind,
  output,
}: {
  explicitId?: string;
  messageId?: string;
  toolName?: string;
  argumentsValue?: unknown;
  toolKind?: string;
  output?: string;
}): string {
  if (explicitId) return explicitId;

  const seed = [
    messageId || 'unknown-message',
    toolName || 'Unknown',
    normalizeToolArguments(argumentsValue),
    toolKind || '',
    output || '',
  ].join('|');

  return `tool-${stableHash(seed)}`;
}

export function makeSubagentId({
  explicitId,
  sessionId,
  messageId,
  agentType,
  description,
  summary,
}: {
  explicitId?: string;
  sessionId?: string;
  messageId?: string;
  agentType?: string;
  description?: string;
  summary?: string;
}): string {
  if (explicitId) return explicitId;
  if (sessionId) return sessionId;

  const seed = [
    messageId || 'unknown-message',
    agentType || 'subagent',
    description || '',
    summary || '',
  ].join('|');

  return `subagent-${stableHash(seed)}`;
}
