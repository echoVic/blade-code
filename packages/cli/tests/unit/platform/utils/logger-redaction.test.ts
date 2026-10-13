import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Logger credential redaction', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('redacts file and console sinks before serialization', async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-log-redaction-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    vi.resetModules();
    const { Logger, setLoggerSessionId } = await import(
      '../../../../src/logging/Logger.js'
    );
    setLoggerSessionId('redaction');
    const consoleOutput = vi.spyOn(console, 'error').mockImplementation(() => {
      // Capture console arguments without printing test credentials.
    });
    const logger = new Logger({ enabled: true });
    const input = { apiKey: 'PRIVATE_STRUCTURED', ordinary: 'useful context' };
    try {
      logger.warn('password=PRIVATE_TEXT', input);
      const output = readFileSync(
        path.join(storageRoot, 'logs', 'blade-redaction.jsonl'),
        'utf8'
      );
      expect(output).not.toContain('PRIVATE');
      expect(JSON.stringify(consoleOutput.mock.calls)).not.toContain('PRIVATE');
      expect(output).toContain('useful context');
      expect(input.apiKey).toBe('PRIVATE_STRUCTURED');
      const cyclic: Record<string, unknown> = { count: 1n };
      cyclic.self = cyclic;
      expect(() => logger.info(cyclic)).not.toThrow();
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
