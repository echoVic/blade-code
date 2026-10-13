import { describe, expect, it } from 'vitest';
import {
  isSecretKey,
  redactSecrets,
  redactSecretValue,
} from '../../../src/security/secrets.js';

describe('shared credential redaction', () => {
  it.each([
    'apiKey',
    'API_KEY',
    'accessToken',
    'Authorization',
    'password',
    'refresh-token',
    'privateKey',
    'clientSecret',
    'authorizationHeader',
  ])('recognizes %s', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(['tokenCount', 'maxTokens', 'keyboard', 'model', 'path'])(
    'keeps ordinary field %s',
    (key) => expect(isSecretKey(key)).toBe(false)
  );

  it('removes credentials and signed URL values, keeping a useful endpoint', () => {
    const result = redactSecrets(
      'Bearer PRIVATE_BEARER apiKey="PRIVATE KEY WITH SPACES" ' +
        'https://user:password@example.com/a?signature=PRIVATE_SIGNATURE#PRIVATE_FRAGMENT ' +
        'sk-PRIVATE_KEY_123456789 ghp_PRIVATEGITHUBKEY12345678901234'
    );
    expect(result).toContain('https://example.com/a');
    for (const secret of ['PRIVATE', 'user:', 'password@']) {
      expect(result).not.toContain(secret);
    }
    expect(redactSecrets('https://example.com/a', { urls: 'omit' })).toBe(
      '[redacted-url]'
    );
    expect(redactSecrets('https://example.com/public')).toBe(
      'https://example.com/public'
    );
  });

  it('redacts structured values before serialization, without mutating input', () => {
    const input = {
      message: 'normal message',
      nested: { apiKey: 'PRIVATE_VALUE' },
      maxTokens: 12,
    };
    expect(redactSecretValue(input)).toEqual({
      message: 'normal message',
      nested: { apiKey: '[redacted]' },
      maxTokens: 12,
    });
    expect(input.nested.apiKey).toBe('PRIVATE_VALUE');
  });

  it('recognizes environment keys and authorization schemes in text', () => {
    const result = redactSecrets(
      'OPENAI_API_KEY=PRIVATE_ENV clientSecret="PRIVATE CLIENT" ' +
        'Authorization: Basic PRIVATE_BASIC'
    );
    expect(result).not.toContain('PRIVATE');
    expect(redactSecrets('tokenCount=12 maxTokens=24')).toBe(
      'tokenCount=12 maxTokens=24'
    );
  });

  it('handles errors, private keys, cycles and bigint without throwing', () => {
    const input: Record<string, unknown> = {
      error: new Error('password=PRIVATE_PASSWORD'),
      key: '-----BEGIN PRIVATE KEY-----\nPRIVATE_BODY\n-----END PRIVATE KEY-----',
      number: 1n,
    };
    input.self = input;
    const serialized = JSON.stringify(redactSecretValue(input));
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).toContain('[circular]');
  });

  it('never invokes getters or custom serialization hooks', () => {
    const input = {
      get message() {
        throw new Error('PRIVATE_GETTER');
      },
      toJSON() {
        return { exposed: 'PRIVATE_SERIALIZER' };
      },
    };
    expect(() => JSON.stringify(redactSecretValue(input))).not.toThrow();
    expect(JSON.stringify(redactSecretValue(input))).not.toContain('PRIVATE');
  });
});
