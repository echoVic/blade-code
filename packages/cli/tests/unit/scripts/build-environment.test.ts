import { describe, expect, it } from 'vitest';
import { createWebBuildEnvironment } from '../../../scripts/buildEnvironment.js';

describe('production web build environment', () => {
  it('overrides a test caller without dropping unrelated environment variables', () => {
    const callerEnvironment = {
      CI: 'true',
      NODE_ENV: 'test',
      VITE_API_TARGET: 'http://127.0.0.1:4097',
    };

    expect(createWebBuildEnvironment(callerEnvironment)).toEqual({
      CI: 'true',
      NODE_ENV: 'production',
      VITE_API_TARGET: 'http://127.0.0.1:4097',
    });
    expect(callerEnvironment.NODE_ENV).toBe('test');
  });
});
