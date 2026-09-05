export type MemorySafetyResult = { safe: true } | { safe: false; reason: 'credential' };

const CREDENTIAL_PATTERNS = [
  /\b(?:password|token|secret|api[_-]?key|private[_-]?key)\s*[:=]/i,
  /\bprivate[_-]?key\b/i,
  /\bBearer\s+[^\s"'`]+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
];

export function classifyMemoryContent(content: string): MemorySafetyResult {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content))) {
    return { safe: false, reason: 'credential' };
  }
  return { safe: true };
}
