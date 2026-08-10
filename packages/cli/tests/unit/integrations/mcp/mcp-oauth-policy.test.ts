import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../../../src/config/types.js';
import {
  assertSafeMcpOAuthUrl,
  normalizeMcpOAuthConfig,
} from '../../../../src/mcp/auth/McpOAuthPolicy.js';
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthUnavailableError,
} from '../../../../src/mcp/auth/OAuthProvider.js';
import { McpClient } from '../../../../src/mcp/McpClient.js';

function remoteConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    type: 'http',
    url: 'https://mcp.example.test/rpc',
    oauth: {
      enabled: true,
      clientId: 'blade-client',
      scopes: ['mcp:tools'],
    },
    ...overrides,
  };
}

describe('MCP OAuth policy', () => {
  it('normalizes a public-client discovery configuration', () => {
    expect(normalizeMcpOAuthConfig(remoteConfig())).toEqual({
      enabled: true,
      clientId: 'blade-client',
      scopes: ['mcp:tools'],
    });
  });

  it('allows HTTP only for an exact loopback host', () => {
    expect(
      normalizeMcpOAuthConfig(remoteConfig({ url: 'http://127.0.0.1:43123/mcp' }))
    ).toMatchObject({ enabled: true });
    expect(() =>
      normalizeMcpOAuthConfig(remoteConfig({ url: 'http://mcp.example.test/rpc' }))
    ).toThrow('requires HTTPS');
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({ url: 'http://127.0.0.1.example.test/rpc' })
      )
    ).toThrow('requires HTTPS');
    expect(() =>
      assertSafeMcpOAuthUrl(
        'http://auth.example.test/token',
        'discovered token endpoint'
      )
    ).toThrow('discovered token endpoint requires HTTPS');
  });

  it('rejects inline secrets, legacy endpoints, URL credentials, and auth headers', () => {
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({
          oauth: {
            enabled: true,
            clientId: 'client',
            clientSecret: 'secret',
          } as McpServerConfig['oauth'],
        })
      )
    ).toThrow('clientSecret');
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({
          oauth: {
            enabled: true,
            authorizationUrl: 'https://auth.example.test',
          } as McpServerConfig['oauth'],
        })
      )
    ).toThrow('authorizationUrl');
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({ url: 'https://user:pass@mcp.example.test/rpc' })
      )
    ).toThrow('must not contain credentials');
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({ headers: { authorization: 'Bearer inline-secret' } })
      )
    ).toThrow('Authorization header');
  });

  it('rejects OAuth on stdio and invalid scope or callback limits', () => {
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({
          type: 'stdio',
          url: undefined,
          command: 'node',
        })
      )
    ).toThrow('only for HTTP and SSE');
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({
          oauth: { enabled: true, scopes: ['contains space'] },
        })
      )
    ).toThrow('invalid value');
    expect(() =>
      normalizeMcpOAuthConfig(
        remoteConfig({
          oauth: { enabled: true, callbackPort: 80 },
        })
      )
    ).toThrow('between 1024 and 65535');
  });

  it('never opens an implicit flow during connect and denies host credentials to ACP', async () => {
    const local = new McpClient(remoteConfig(), 'oauth-required', undefined, {
      oauthStorageRoot: '/tmp/blade-oauth-policy-local',
    });
    await expect(local.connectWithRetry(1, 1)).rejects.toBeInstanceOf(
      McpOAuthAuthorizationRequiredError
    );
    await local.disconnect();

    const acp = new McpClient(remoteConfig(), 'oauth-acp', undefined, {
      oauthCredentialAccess: false,
      oauthStorageRoot: '/tmp/blade-oauth-policy-acp',
    });
    await expect(acp.connectWithRetry(1, 1)).rejects.toBeInstanceOf(
      McpOAuthUnavailableError
    );
    expect(await acp.getOAuthStatus()).toBe('unavailable');
    await acp.disconnect();
  });
});
