import type { McpServerConfig } from '../../config/types.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthConfig } from './types.js';

const MAX_SCOPES = 32;
const MAX_SCOPE_LENGTH = 128;
const MAX_CLIENT_ID_LENGTH = 4096;
const SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.toLowerCase() === 'localhost'
  );
}

export function assertSafeMcpOAuthUrl(
  rawUrl: string | URL,
  label = 'MCP OAuth URL'
): URL {
  const url = new URL(rawUrl);
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
  ) {
    throw new Error(
      `${label} requires HTTPS; HTTP is allowed only for loopback servers`
    );
  }
  return url;
}

export const safeMcpOAuthFetch: FetchLike = async (url, init) => {
  assertSafeMcpOAuthUrl(url, 'MCP OAuth request URL');
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('MCP OAuth network requests must not follow redirects');
  }
  return response;
};

export function normalizeMcpOAuthConfig(
  server: McpServerConfig
): OAuthConfig | undefined {
  const oauth = server.oauth;
  if (!oauth) return undefined;

  const raw = oauth as OAuthConfig & Record<string, unknown>;
  for (const legacySecret of [
    'clientSecret',
    'authorizationUrl',
    'tokenUrl',
    'redirectUri',
  ]) {
    if (raw[legacySecret] !== undefined) {
      throw new Error(
        `MCP OAuth "${legacySecret}" is not supported; use standards-based discovery`
      );
    }
  }

  if (oauth.enabled !== true) {
    return { enabled: false };
  }
  if (server.type !== 'http' && server.type !== 'sse') {
    throw new Error('MCP OAuth is supported only for HTTP and SSE transports');
  }
  if (!server.url) {
    throw new Error('MCP OAuth requires an MCP server URL');
  }
  assertSafeMcpOAuthUrl(server.url, 'MCP OAuth server URL');

  const authorizationHeader = Object.keys(server.headers ?? {}).find(
    (name) => name.toLowerCase() === 'authorization'
  );
  if (authorizationHeader) {
    throw new Error(
      'MCP OAuth cannot be combined with a configured Authorization header'
    );
  }

  const clientId = oauth.clientId?.trim();
  if (clientId && clientId.length > MAX_CLIENT_ID_LENGTH) {
    throw new Error(`MCP OAuth clientId exceeds ${MAX_CLIENT_ID_LENGTH} characters`);
  }

  const scopes = oauth.scopes?.map((scope) => scope.trim());
  if (scopes) {
    if (scopes.length > MAX_SCOPES) {
      throw new Error(`MCP OAuth supports at most ${MAX_SCOPES} scopes`);
    }
    if (
      scopes.some(
        (scope) =>
          !scope || scope.length > MAX_SCOPE_LENGTH || !SCOPE_PATTERN.test(scope)
      )
    ) {
      throw new Error('MCP OAuth scopes contain an invalid value');
    }
    if (new Set(scopes).size !== scopes.length) {
      throw new Error('MCP OAuth scopes must not contain duplicates');
    }
  }

  const callbackPort = oauth.callbackPort;
  if (
    callbackPort !== undefined &&
    (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535)
  ) {
    throw new Error('MCP OAuth callbackPort must be between 1024 and 65535');
  }

  return {
    enabled: true,
    ...(clientId ? { clientId } : {}),
    ...(scopes?.length ? { scopes } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
  };
}
