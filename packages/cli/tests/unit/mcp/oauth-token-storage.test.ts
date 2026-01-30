import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFiles = new Map<string, string>();
const mockWriteOptions = new Map<string, unknown>();

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      if (!mockFiles.has(filePath)) {
        const error = new Error('ENOENT: no such file or directory');
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
      return mockFiles.get(filePath);
    }),
    writeFile: vi
      .fn()
      .mockImplementation(
        async (filePath: string, content: string, options?: unknown) => {
          mockFiles.set(filePath, content);
          mockWriteOptions.set(filePath, options);
        }
      ),
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: vi.fn().mockReturnValue('/mock/home'),
  },
}));

import { OAuthTokenStorage } from '../../../src/mcp/auth/OAuthTokenStorage.js';

describe('OAuthTokenStorage', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockWriteOptions.clear();
    vi.clearAllMocks();
  });

  it('saveToken 应写入文件并设置权限', async () => {
    const storage = new OAuthTokenStorage();

    await storage.saveToken(
      'github',
      {
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 60_000,
        tokenType: 'Bearer',
      },
      'client-1',
      'https://example.com/token'
    );

    const tokenPath = '/mock/home/.blade/mcp-oauth-tokens.json';
    expect(mockFiles.has(tokenPath)).toBe(true);

    const options = mockWriteOptions.get(tokenPath) as { mode?: number } | undefined;
    expect(options?.mode).toBe(0o600);

    const stored = JSON.parse(mockFiles.get(tokenPath) || '[]') as any[];
    expect(stored).toHaveLength(1);
    expect(stored[0].serverName).toBe('github');
    expect(stored[0].token.accessToken).toBe('token-1');
    expect(stored[0].clientId).toBe('client-1');
    expect(stored[0].tokenUrl).toBe('https://example.com/token');
    expect(typeof stored[0].updatedAt).toBe('number');
  });

  it('getCredentials 应返回已保存的凭证', async () => {
    const storage = new OAuthTokenStorage();

    await storage.saveToken('server-a', { accessToken: 'a', tokenType: 'Bearer' });
    const cred = await storage.getCredentials('server-a');

    expect(cred).not.toBeNull();
    expect(cred?.serverName).toBe('server-a');
    expect(cred?.token.accessToken).toBe('a');
  });

  it('deleteCredentials 应删除指定服务器凭证', async () => {
    const storage = new OAuthTokenStorage();

    await storage.saveToken('a', { accessToken: 'a', tokenType: 'Bearer' });
    await storage.saveToken('b', { accessToken: 'b', tokenType: 'Bearer' });

    await storage.deleteCredentials('a');

    expect(await storage.getCredentials('a')).toBeNull();
    expect((await storage.getCredentials('b'))?.token.accessToken).toBe('b');
  });

  it('listServers 应返回所有服务器名', async () => {
    const storage = new OAuthTokenStorage();

    await storage.saveToken('a', { accessToken: 'a', tokenType: 'Bearer' });
    await storage.saveToken('b', { accessToken: 'b', tokenType: 'Bearer' });

    const servers = await storage.listServers();
    expect(servers.sort()).toEqual(['a', 'b']);
  });

  it('isTokenExpired 应考虑 5 分钟缓冲', () => {
    const storage = new OAuthTokenStorage();
    const now = Date.now();

    expect(
      storage.isTokenExpired({
        accessToken: 'x',
        tokenType: 'Bearer',
        expiresAt: now + 10 * 60 * 1000,
      })
    ).toBe(false);

    expect(
      storage.isTokenExpired({
        accessToken: 'x',
        tokenType: 'Bearer',
        expiresAt: now + 4 * 60 * 1000,
      })
    ).toBe(true);

    expect(storage.isTokenExpired({ accessToken: 'x', tokenType: 'Bearer' })).toBe(
      false
    );
  });
});
