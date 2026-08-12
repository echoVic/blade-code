import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mocks.readFile,
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));

vi.mock('../../../src/utils/packageInfo.js', () => ({
  getVersion: () => '0.10.24',
}));

vi.mock('../../../src/utils/proxyFetch.js', () => ({
  proxyFetch: mocks.proxyFetch,
}));

import { checkVersion } from '../../../src/services/VersionChecker.js';

describe('VersionChecker cache freshness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it('never reports a cached latest version older than the installed package', async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.10.8',
        checkedAt: Date.now(),
      })
    );

    await expect(checkVersion()).resolves.toMatchObject({
      currentVersion: '0.10.24',
      latestVersion: '0.10.24',
      hasUpdate: false,
      shouldPrompt: false,
    });
    const persisted = JSON.parse(String(mocks.writeFile.mock.calls[0]?.[1]));
    expect(persisted).toMatchObject({
      latestVersion: '0.10.24',
      checkedAt: expect.any(Number),
    });
  });

  it('clears a stale latestVersion when the registry refresh fails', async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.10.8',
        checkedAt: 1,
        skipUntilVersion: '0.10.8',
      })
    );
    mocks.proxyFetch.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(checkVersion()).resolves.toMatchObject({
      latestVersion: null,
      hasUpdate: false,
      shouldPrompt: false,
      error: 'Unable to check for updates',
    });
    const persisted = JSON.parse(String(mocks.writeFile.mock.calls[0]?.[1]));
    expect(persisted).toEqual({
      checkedAt: 0,
      skipUntilVersion: '0.10.8',
    });
  });
});
