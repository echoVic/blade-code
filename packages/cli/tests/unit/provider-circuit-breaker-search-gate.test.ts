import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('Provider circuit breaker source gate', () => {
  it('keeps registry and windows finite without a timer sweep or test bypass', () => {
    const circuit = source('../../src/services/pi/providerCircuitBreaker.ts');
    const config = source('../../src/config/providerCircuitBreaker.ts');
    const combined = `${config}\n${circuit}`;

    expect(combined).toContain('MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES = 128');
    expect(combined).toContain('MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES = 256');
    expect(circuit).toMatch(
      /maxEntries:\s*Math\.min\(\s*positiveInteger\(\s*options\.maxEntries/
    );
    expect(circuit).toMatch(
      /maxWindowEntries:\s*Math\.min\(\s*positiveInteger\(\s*options\.maxWindowEntries/
    );
    expect(circuit).not.toContain('setInterval(');
    expect(circuit).not.toContain('setTimeout(');
    expect(circuit).toContain('options.now ?? (() => performance.now())');
    expect(combined).not.toContain('Number.POSITIVE_INFINITY');
    expect(combined).not.toMatch(/\bInfinity\b/);
    expect(combined).not.toMatch(/NODE_ENV\s*===\s*['"]test['"]/);
    expect(combined).not.toMatch(/BLADE_TEST/);
  });

  it('uses opaque process-scoped identity and stale-token validation', () => {
    const circuit = source('../../src/services/pi/providerCircuitBreaker.ts');
    const identity = source('../../src/services/pi/providerFailureDomain.ts');

    expect(identity).toContain("createHmac('sha256'");
    expect(circuit).toContain('randomBytes(32)');
    expect(circuit).toContain('createProviderFailureDomainKey');
    expect(circuit).toContain('new WeakMap<object, AttemptState>()');
    expect(circuit).toContain('attempt.generation !== entry.generation');
    expect(circuit).toContain('attempt.probeLeaseId !== entry.probeLeaseId');
  });

  it('never serializes circuit control into Provider request options', () => {
    const options = source('../../src/services/pi/requestOptions.ts');

    expect(options).not.toContain('providerCircuit');
    expect(options).not.toContain('providerCircuitBreakerOpenMs');
    expect(options).not.toContain('providerCircuitRegistry');
  });

  it('keeps every surface projection on the sanitized field allowlist', () => {
    const headless = between(
      source('../../src/commands/headlessEvents.ts'),
      'const ProviderCircuitEventSchema',
      'const ProviderStallEventSchema'
    );
    const acp = between(
      source('../../src/acp/Session.ts'),
      "case 'provider_circuit':",
      "case 'provider_retry':"
    );
    const server = source('../../src/server/routes/session.ts')
      .split("case 'provider_circuit':")
      .slice(1)
      .map((part) => part.split("case 'provider_retry':")[0])
      .join('\n');
    const combined = `${headless}\n${acp}\n${server}`;

    for (const forbidden of [
      'apiKey',
      'baseUrl',
      'customHeaders',
      'processSecret',
      'failureDomain',
      'credential',
      'digest',
      'responseBody',
      'rawError',
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it('keeps circuit state ephemeral and outside transcript storage', () => {
    const storage = [
      source('../../src/context/ContextManager.ts'),
      source('../../src/services/SessionService.ts'),
      source('../../src/context/storage/JSONLStore.ts'),
      source('../../src/context/storage/PersistentStore.ts'),
    ].join('\n');

    expect(storage).not.toContain('providerCircuit');
    expect(storage).not.toContain('provider_circuit');
  });
});
