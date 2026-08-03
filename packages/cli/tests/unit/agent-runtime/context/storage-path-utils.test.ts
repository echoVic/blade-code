import { afterEach, describe, expect, it } from 'vitest';
import {
  assertValidSessionId,
  getBladeStorageRoot,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../../src/context/storage/pathUtils.js';

const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

afterEach(() => {
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe('context storage paths', () => {
  it('supports an isolated storage root for sandboxed runtimes', () => {
    process.env.BLADE_STORAGE_ROOT = '/tmp/blade-isolated';

    expect(getBladeStorageRoot()).toBe('/tmp/blade-isolated');
    expect(getProjectStoragePath('/workspace/demo')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo'
    );
    expect(getSessionFilePath('/workspace/demo', 'session-1')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo/session-1.jsonl'
    );
    expect(getSessionInboxFilePath('/workspace/demo', 'session-1')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo/session-1.inbox.json'
    );
  });

  it('rejects session IDs that can escape project storage', () => {
    expect(() => assertValidSessionId('../outside')).toThrow('Invalid session ID');
    expect(() => getSessionFilePath('/workspace/demo', 'nested/session')).toThrow(
      'Invalid session ID'
    );
    expect(() => getSessionInboxFilePath('/workspace/demo', '..')).toThrow(
      'Invalid session ID'
    );
  });
});
