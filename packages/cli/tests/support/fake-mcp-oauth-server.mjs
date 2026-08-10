import { createHash, randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const readyFile = process.env.MCP_OAUTH_READY_FILE;
const traceFile = process.env.MCP_OAUTH_TRACE_FILE;
if (!readyFile) throw new Error('MCP_OAUTH_READY_FILE is required');

let origin = '';
let accessToken = '';
let refreshToken = '';
let accessTokenExpiresAt = 0;
let authorizationCount = 0;
let tokenExchangeCount = 0;
let refreshCount = 0;
let toolCallCount = 0;
const clients = new Map();
const authorizationCodes = new Map();

async function trace(event) {
  if (!traceFile) return;
  await appendFile(
    traceFile,
    `${JSON.stringify({ event, at: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
}

async function readBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function unauthorized(response) {
  json(
    response,
    401,
    {
      error: 'invalid_token',
      error_description: 'OAuth authorization is required',
    },
    {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
    }
  );
}

function isAuthorized(request) {
  return (
    request.headers.authorization === `Bearer ${accessToken}` &&
    Date.now() < accessTokenExpiresAt
  );
}

function issueTokens() {
  accessToken = `access-${randomUUID()}`;
  refreshToken = `refresh-${randomUUID()}`;
  accessTokenExpiresAt = Date.now() + 800;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 0.8,
    scope: 'mcp:tools',
  };
}

async function handleMcp(request, response) {
  const mcp = new Server(
    {
      name: 'blade-mcp-oauth-fixture',
      version: '1.0.0',
    },
    {
      capabilities: { tools: {} },
    }
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'oauth_marker',
        description: 'Return an authenticated marker',
        inputSchema: {
          type: 'object',
          properties: {
            marker: { type: 'string' },
          },
          required: ['marker'],
          additionalProperties: false,
        },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (toolRequest) => {
    toolCallCount++;
    await trace('tool_call');
    const marker = String(toolRequest.params.arguments?.marker ?? '');
    return {
      content: [{ type: 'text', text: `MCP_OAUTH_OK:${marker}` }],
    };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', origin);

    if (
      request.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
        url.pathname === '/.well-known/oauth-protected-resource')
    ) {
      json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['mcp:tools'],
        bearer_methods_supported: ['header'],
      });
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/oauth-authorization-server'
    ) {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ['mcp:tools'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      const metadata = JSON.parse(await readBody(request));
      const clientId = `client-${randomUUID()}`;
      clients.set(clientId, metadata);
      await trace('client_registered');
      json(response, 201, {
        ...metadata,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const codeChallenge = url.searchParams.get('code_challenge');
      const client = clientId ? clients.get(clientId) : undefined;
      if (
        !clientId ||
        !redirectUri ||
        !state ||
        !codeChallenge ||
        !client?.redirect_uris?.includes(redirectUri)
      ) {
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      const code = `code-${randomUUID()}`;
      authorizationCodes.set(code, { clientId, redirectUri, codeChallenge });
      authorizationCount++;
      await trace('authorization_redirect');
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      response.writeHead(302, {
        Location: callback.toString(),
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }

    if (request.method === 'POST' && url.pathname === '/token') {
      const params = new URLSearchParams(await readBody(request));
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const code = params.get('code');
        const verifier = params.get('code_verifier');
        const redirectUri = params.get('redirect_uri');
        const clientId = params.get('client_id');
        const pending = code ? authorizationCodes.get(code) : undefined;
        const challenge = verifier
          ? createHash('sha256').update(verifier).digest('base64url')
          : '';
        if (
          !code ||
          !pending ||
          pending.clientId !== clientId ||
          pending.redirectUri !== redirectUri ||
          pending.codeChallenge !== challenge
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        authorizationCodes.delete(code);
        tokenExchangeCount++;
        await trace('authorization_code_exchanged');
        json(response, 200, issueTokens());
        return;
      }
      if (grantType === 'refresh_token') {
        if (params.get('refresh_token') !== refreshToken) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        refreshCount++;
        await trace('token_refreshed');
        json(response, 200, issueTokens());
        return;
      }
      json(response, 400, { error: 'unsupported_grant_type' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      json(response, 200, {
        authorizationCount,
        tokenExchangeCount,
        refreshCount,
        toolCallCount,
      });
      return;
    }

    if (url.pathname === '/mcp') {
      if (!isAuthorized(request)) {
        unauthorized(response);
        return;
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        json(response, 405, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        });
        return;
      }
      if (request.method === 'POST') {
        await handleMcp(request, response);
        return;
      }
    }

    json(response, 404, { error: 'not_found' });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('OAuth fixture failed to bind');
  }
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    readyFile,
    `${JSON.stringify({
      pid: process.pid,
      origin,
      mcpUrl: `${origin}/mcp`,
    })}\n`,
    { mode: 0o600 }
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
