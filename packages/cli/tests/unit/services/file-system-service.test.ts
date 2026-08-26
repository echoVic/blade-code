import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalFileSystemService } from '../../../src/services/FileSystemService.js';

describe('LocalFileSystemService error classification', () => {
  const service = new LocalFileSystemService();

  it('maps only ENOENT to an absent path', async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `blade-missing-${process.pid}-${Date.now()}`
    );

    await expect(service.exists(missingPath)).resolves.toBe(false);
    await expect(service.stat(missingPath)).resolves.toBeNull();
  });

  it('propagates non-ENOENT access and stat failures', async () => {
    const invalidPath = undefined as unknown as string;

    await expect(service.exists(invalidPath)).rejects.toThrow();
    await expect(service.stat(invalidPath)).rejects.toThrow();
  });
});
