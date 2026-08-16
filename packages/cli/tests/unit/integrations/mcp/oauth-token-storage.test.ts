import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalMcpOAuthServerUrl,
  mcpOAuthCredentialId,
  OAuthTokenStorage,
} from '../../../../src/mcp/auth/OAuthTokenStorage.js';
import type { McpOAuthCredential } from '../../../../src/mcp/auth/types.js';

describe('OAuthTokenStorage', () => {
  let root: string;
  let storage: OAuthTokenStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-oauth-store-'));
    storage = new OAuthTokenStorage(root);
  });

  afterEach(async () => {
    expect(OAuthTokenStorage.coordinationStatsForTests()).toEqual({
      keys: 0,
      operations: 0,
    });
    await rm(root, { recursive: true, force: true });
  });

  function credential(serverUrl: string, accessToken: string): McpOAuthCredential {
    return {
      serverUrl,
      clientId: 'blade-test-client',
      clientInformation: { client_id: 'blade-test-client' },
      tokens: {
        access_token: accessToken,
        refresh_token: `refresh-${accessToken}`,
        token_type: 'Bearer',
        expires_in: 3600,
      },
      tokenExpiresAt: Date.now() + 3_600_000,
      updatedAt: new Date().toISOString(),
    };
  }

  it('atomically writes a strict 0600 credential ledger', async () => {
    const serverUrl = 'https://mcp.example.test/rpc';
    const identity = mcpOAuthCredentialId(serverUrl, 'blade-test-client');
    await storage.updateCredential(identity, () => credential(serverUrl, 'access-one'));

    const filePath = path.join(root, 'mcp', 'oauth-credentials.json');
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      credentials: Record<string, McpOAuthCredential>;
    };
    expect(stored.version).toBe(1);
    expect(stored.credentials[identity]?.tokens?.access_token).toBe('access-one');
    expect((await readdir(path.dirname(filePath))).sort()).toEqual([
      'oauth-credentials.json',
    ]);
  });

  it('serializes updates from independent storage instances without lost writes', async () => {
    const other = new OAuthTokenStorage(root);
    const firstUrl = 'https://one.example.test/mcp';
    const secondUrl = 'https://two.example.test/mcp';
    const firstId = mcpOAuthCredentialId(firstUrl, 'client');
    const secondId = mcpOAuthCredentialId(secondUrl, 'client');

    await Promise.all([
      storage.updateCredential(firstId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return credential(firstUrl, 'first');
      }),
      other.updateCredential(secondId, () => credential(secondUrl, 'second')),
    ]);

    expect((await storage.listCredentialIds()).sort()).toEqual(
      [firstId, secondId].sort()
    );
    expect((await storage.getCredential(firstId))?.tokens?.access_token).toBe('first');
    expect((await storage.getCredential(secondId))?.tokens?.access_token).toBe(
      'second'
    );
  });

  it('fails closed for malformed, over-permissive, and symlink stores', async () => {
    const identity = mcpOAuthCredentialId('https://mcp.example.test', 'client');
    await storage.updateCredential(identity, () =>
      credential('https://mcp.example.test', 'access')
    );
    const filePath = path.join(root, 'mcp', 'oauth-credentials.json');

    await chmod(filePath, 0o644);
    await expect(storage.getCredential(identity)).rejects.toThrow(
      'permissions must be 0600'
    );

    await rm(filePath);
    await symlink(path.join(root, 'outside.json'), filePath);
    await expect(storage.getCredential(identity)).rejects.toThrow(
      'must be a regular file'
    );
  });

  it('deletes only the exact endpoint and client identity', async () => {
    const firstUrl = 'https://mcp.example.test/a';
    const secondUrl = 'https://mcp.example.test/b';
    const firstId = mcpOAuthCredentialId(firstUrl, 'client');
    const secondId = mcpOAuthCredentialId(secondUrl, 'client');
    await storage.updateCredential(firstId, () => credential(firstUrl, 'first'));
    await storage.updateCredential(secondId, () => credential(secondUrl, 'second'));

    await storage.deleteCredential(firstId);

    expect(await storage.getCredential(firstId)).toBeNull();
    expect((await storage.getCredential(secondId))?.tokens?.access_token).toBe(
      'second'
    );
  });

  it('canonicalizes fragments and isolates client identities', () => {
    expect(canonicalMcpOAuthServerUrl('https://example.test/mcp#fragment')).toBe(
      'https://example.test/mcp'
    );
    expect(mcpOAuthCredentialId('https://example.test/mcp', 'client-a')).not.toBe(
      mcpOAuthCredentialId('https://example.test/mcp', 'client-b')
    );
    expect(
      mcpOAuthCredentialId('https://example.test/mcp', 'client-a', ['read'])
    ).not.toBe(mcpOAuthCredentialId('https://example.test/mcp', 'client-a', ['write']));
  });

  it('does not retain historical credential-store keys after reads', async () => {
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        new OAuthTokenStorage(
          path.join(root, `historical-${index}`)
        ).listCredentialIds()
      )
    );

    expect(OAuthTokenStorage.coordinationStatsForTests()).toEqual({
      keys: 0,
      operations: 0,
    });
  });
});
