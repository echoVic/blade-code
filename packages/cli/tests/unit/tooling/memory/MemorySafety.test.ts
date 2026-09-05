import { describe, expect, it } from 'vitest';
import { classifyMemoryContent } from '../../../../src/memory/MemorySafety.js';

describe('MemorySafety', () => {
  it.each([
    'password = hunter2',
    'token: ghp_examplecredential',
    'secret=my-secret-value',
    'api_key: abc123',
    'private_key material',
    'Authorization: Bearer examplecredential',
    'Use sk-examplecredential for this request',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN PRIVATE KEY-----',
  ])(
    'rejects credential-shaped memory without returning the matched value: %s',
    (content) => {
      const result = classifyMemoryContent(content);

      expect(result).toEqual({ safe: false, reason: 'credential' });
      expect(JSON.stringify(result)).not.toContain(content);
    }
  );

  it.each([
    'Document the password reset flow',
    'The tokenizer uses one token budget per request',
    'Keep secret management documentation near the deployment guide',
    'Use the private key type exported by the schema module',
  ])('allows ordinary technical prose: %s', (content) => {
    expect(classifyMemoryContent(content)).toEqual({ safe: true });
  });
});
