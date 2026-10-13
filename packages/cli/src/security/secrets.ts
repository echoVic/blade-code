export interface SecretRedactionOptions {
  urls?: 'omit' | 'credentials';
  onRedaction?: () => void;
}

const SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|authorization|bearer|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_-])/i;
const TOKEN_METRIC = /(?:^|[_-])tokens?[_-](?:count|budget|limit|length|usage|rate)$/i;

export function isSecretKey(value: string): boolean {
  const normalized = value
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return !TOKEN_METRIC.test(normalized) && SENSITIVE_KEY.test(normalized);
}

/** Redact recognized credentials; public URLs keep their host and path by default. */
export function redactSecrets(
  value: string,
  options: SecretRedactionOptions = {}
): string {
  const replacement = (text: string) => {
    options.onRedaction?.();
    return text;
  };
  const withoutPrivateKeys = value.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    () => replacement('[redacted-private-key]')
  );
  const withoutUrlCredentials = withoutPrivateKeys.replace(
    /\bhttps?:\/\/[^\s"'`<>]+/gi,
    (candidate) => {
      if (options.urls === 'omit') return replacement('[redacted-url]');
      try {
        const url = new URL(candidate);
        if (!url.username && !url.password && !url.search && !url.hash) {
          return candidate;
        }
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return replacement(url.toString());
      } catch {
        return replacement('[redacted-url]');
      }
    }
  );
  return withoutUrlCredentials
    .replace(
      /\b(Bearer|Basic)\s+[^\s"'`]+/gi,
      (_match, scheme: string) => `${scheme} ${replacement('[redacted]')}`
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, () => replacement('[redacted-key]'))
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, () => replacement('[redacted-aws-key]'))
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, () =>
      replacement('[redacted-key]')
    )
    .replace(
      /(\b([A-Za-z0-9_-]*(?:api[_-]?key|authorization(?:[_-]?header)?|bearer|cookie|credential|password|passwd|private[_-]?key|secret|token))\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      (match, prefix: string, key: string) =>
        isSecretKey(key) ? `${prefix}${replacement('[redacted]')}` : match
    );
}

/** Produce a bounded, serializable copy without invoking getters or toJSON. */
export function redactSecretValue(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(entry: unknown, depth: number): unknown {
    if (++nodes > 2_000 || depth > 12) return '[depth limit]';
    if (typeof entry === 'string') return redactSecrets(entry);
    if (typeof entry === 'bigint') return entry.toString();
    if (typeof entry === 'function' || typeof entry === 'symbol') {
      return `[${typeof entry}]`;
    }
    if (entry === null || typeof entry !== 'object') return entry;
    if (ancestors.has(entry)) return '[circular]';
    ancestors.add(entry);
    try {
      if (entry instanceof Error) {
        return redactSecrets(`${entry.name}: ${entry.message}`);
      }
      if (entry instanceof Date) {
        return Number.isFinite(entry.getTime())
          ? entry.toISOString()
          : '[invalid date]';
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      const readProperty = (key: string) => {
        const descriptor = descriptors[key];
        return descriptor && 'value' in descriptor
          ? visit(descriptor.value, depth + 1)
          : '[accessor omitted]';
      };
      if (Array.isArray(entry)) {
        return Array.from({ length: Math.min(entry.length, 200) }, (_, index) =>
          readProperty(String(index))
        );
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(descriptors).slice(0, 200)) {
        if (!descriptors[key]?.enumerable) continue;
        output[redactSecrets(key)] = isSecretKey(key)
          ? '[redacted]'
          : readProperty(key);
      }
      return output;
    } catch {
      return '[uninspectable]';
    } finally {
      ancestors.delete(entry);
    }
  }
  return visit(value, 0);
}
