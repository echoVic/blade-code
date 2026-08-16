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

describe('Provider request admission source gate', () => {
  it('keeps active and pending state hard-bounded without a sweep timer', () => {
    const admission = source('../../src/services/pi/providerRequestAdmission.ts');
    const config = source('../../src/config/providerRequestAdmission.ts');
    const combined = `${config}\n${admission}`;

    expect(combined).toContain('PROVIDER_ADMISSION_GLOBAL_MAX_IN_FLIGHT = 16');
    expect(combined).toContain('PROVIDER_ADMISSION_GLOBAL_MAX_PENDING = 128');
    expect(combined).toContain('PROVIDER_ADMISSION_DOMAIN_MAX_PENDING = 32');
    expect(combined).toContain('PROVIDER_ADMISSION_OWNER_MAX_PENDING = 16');
    expect(admission).toContain('this.#queue.length >= this.#limits.globalMaxPending');
    expect(admission).toContain('existingOwner?.queued');
    expect(admission).toContain('existingDomain?.queued');
    expect(admission).toContain('this.#domains.delete(domainKey)');
    expect(admission).toContain('this.#owners.delete(ownerId)');
    expect(admission).not.toContain('setInterval(');
    expect(admission).not.toMatch(/\bInfinity\b/);
    expect(combined).not.toMatch(/NODE_ENV\s*===\s*['"]test['"]/);
    expect(combined).not.toMatch(/BLADE_TEST/);
  });

  it('uses opaque process-scoped identity and never keys capacity by raw secrets', () => {
    const identity = source('../../src/services/pi/providerFailureDomain.ts');
    const admission = source('../../src/services/pi/providerRequestAdmission.ts');

    expect(identity).toContain("createHmac('sha256'");
    expect(admission).toContain('randomBytes(32)');
    expect(admission).toContain('createProviderFailureDomainKey');
    expect(admission).not.toContain('Map<ProviderRequestScope');
  });

  it('does not serialize runtime admission controls into Provider options', () => {
    const options = source('../../src/services/pi/requestOptions.ts');

    expect(options).not.toContain('providerAdmission');
    expect(options).not.toContain('providerRequestConcurrency');
    expect(options).not.toContain('providerRequestAdmissionMs');
    expect(options).not.toContain('providerRequestAdmissionScheduler');
  });

  it('keeps every surface projection on the sanitized numeric allowlist', () => {
    const headless = between(
      source('../../src/commands/headlessEvents.ts'),
      'const ProviderAdmissionEventSchema',
      'const ProviderCircuitEventSchema'
    );
    const acp = between(
      source('../../src/acp/Session.ts'),
      "case 'provider_admission':",
      "case 'provider_circuit':"
    );
    const server = source('../../src/server/routes/session.ts')
      .split("case 'provider_admission':")
      .slice(1)
      .map((part) => part.split("case 'provider_circuit':")[0])
      .join('\n');
    const combined = `${headless}\n${acp}\n${server}`;

    for (const forbidden of [
      'apiKey',
      'baseUrl',
      'customHeaders',
      'processSecret',
      'failureDomain',
      'ownerId',
      'sessionId',
      'credential',
      'digest',
      'responseBody',
      'rawError',
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it('keeps admission lifecycle and private owner identity outside JSONL transcript', () => {
    const transcriptStorage = [
      source('../../src/context/storage/JSONLStore.ts'),
      source('../../src/context/storage/PersistentStore.ts'),
      source('../../src/context/events/SessionEventLog.ts'),
    ].join('\n');

    expect(transcriptStorage).not.toContain('providerAdmission');
    expect(transcriptStorage).not.toContain('provider_admission');
    expect(transcriptStorage).not.toContain('providerAdmissionOwnerId');
  });
});
