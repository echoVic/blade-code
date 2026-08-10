import { describe, expect, it, vi } from 'vitest';
import { AcpFileSystemService } from '../../../../src/acp/AcpFileSystemService.js';
import type { FileSystemService } from '../../../../src/services/FileSystemService.js';

function fallback(): FileSystemService {
  return {
    readTextFile: vi.fn(async () => 'local fallback'),
    writeTextFile: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
    readBinaryFile: vi.fn(async () => Buffer.alloc(0)),
    stat: vi.fn(async () => null),
    mkdir: vi.fn(async () => undefined),
  };
}

describe('AcpFileSystemService remote ownership', () => {
  it('fails closed instead of writing locally after an advertised remote failure', async () => {
    const local = fallback();
    const connection = {
      writeTextFile: vi.fn(async () => {
        throw new Error('remote write rejected');
      }),
    };
    const service = new AcpFileSystemService(
      connection as never,
      'session-a',
      { writeTextFile: true } as never,
      local
    );

    await expect(service.writeTextFile('/remote/file.ts', 'new')).rejects.toThrow(
      'remote write rejected'
    );
    expect(local.writeTextFile).not.toHaveBeenCalled();
    expect(service.usesRemoteFiles()).toBe(true);
  });

  it('fails closed instead of reading a same-named local file after a remote failure', async () => {
    const local = fallback();
    const connection = {
      readTextFile: vi.fn(async () => {
        throw new Error('remote read rejected');
      }),
    };
    const service = new AcpFileSystemService(
      connection as never,
      'session-a',
      { readTextFile: true } as never,
      local
    );

    await expect(service.readTextFile('/remote/file.ts')).rejects.toThrow(
      'remote read rejected'
    );
    expect(local.readTextFile).not.toHaveBeenCalled();
  });

  it('uses the local filesystem only when the client did not advertise remote fs', async () => {
    const local = fallback();
    const service = new AcpFileSystemService(
      {} as never,
      'session-a',
      {} as never,
      local
    );

    await expect(service.readTextFile('/shared/file.ts')).resolves.toBe(
      'local fallback'
    );
    await service.writeTextFile('/shared/file.ts', 'new');
    expect(local.writeTextFile).toHaveBeenCalledWith('/shared/file.ts', 'new');
    expect(service.usesRemoteFiles()).toBe(false);
  });
});
