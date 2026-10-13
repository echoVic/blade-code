import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamDebug } from '../../../../src/logging/StreamDebugLogger.js';

describe('streamDebug', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes inside the isolated Blade storage root', () => {
    const storageRoot = path.join(
      os.tmpdir(),
      `blade-stream-debug-${process.pid}-${Date.now()}`
    );
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);

    streamDebug('test', 'isolated');

    const logFile = path.join(storageRoot, 'logs', 'stream-debug.log');
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('[test] isolated');
  });

  it('does not fail the caller when debug logging is unavailable', () => {
    vi.stubEnv('BLADE_STORAGE_ROOT', '/dev/null');

    expect(() => streamDebug('test', 'unavailable')).not.toThrow();
  });

  it('redacts stream messages and structured parameters', () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-stream-secret-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    try {
      streamDebug('test', 'password=PRIVATE_MESSAGE', {
        accessToken: 'PRIVATE_TOKEN',
        count: 2,
      });
      const output = readFileSync(
        path.join(storageRoot, 'logs', 'stream-debug.log'),
        'utf8'
      );
      expect(output).not.toContain('PRIVATE');
      expect(output).toContain('"count":2');
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
