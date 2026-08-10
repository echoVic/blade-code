import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthUnavailableError,
} from '../../src/mcp/auth/OAuthProvider.js';
import { McpClient } from '../../src/mcp/McpClient.js';
import {
  type SpawnedOwnedProcess,
  spawnOwnedProcess,
} from '../../src/utils/process/OwnedProcessTree.js';

vi.unmock('child_process');
vi.unmock('node:child_process');
vi.unmock('http');
vi.unmock('node:http');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-oauth-server.mjs'
);

interface FixtureReady {
  pid: number;
  origin: string;
  mcpUrl: string;
}

describe('MCP OAuth lifecycle over real Streamable HTTP', () => {
  let root: string;
  let readyFile: string;
  let traceFile: string;
  let fixture: SpawnedOwnedProcess | undefined;
  const clients: McpClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-oauth-'));
    readyFile = path.join(root, 'ready.json');
    traceFile = path.join(root, 'trace.jsonl');
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    await fixture?.processTree.terminate();
    await rm(root, { recursive: true, force: true });
  });

  async function findCallbackPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to allocate callback port');
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
  }

  async function startFixture(): Promise<FixtureReady> {
    fixture = spawnOwnedProcess(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        MCP_OAUTH_READY_FILE: readyFile,
        MCP_OAUTH_TRACE_FILE: traceFile,
      },
      stdio: 'ignore',
    });
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(readyFile, 'utf8')) as FixtureReady;
        } catch {
          return undefined;
        }
      })
      .toBeTruthy();
    return JSON.parse(await readFile(readyFile, 'utf8')) as FixtureReady;
  }

  function createClient(
    ready: FixtureReady,
    callbackPort: number,
    oauthCredentialAccess = true
  ): McpClient {
    const client = new McpClient(
      {
        type: 'http',
        url: ready.mcpUrl,
        oauth: {
          enabled: true,
          scopes: ['mcp:tools'],
          callbackPort,
        },
      },
      'oauth-fixture',
      undefined,
      {
        oauthCredentialAccess,
        oauthStorageRoot: path.join(root, 'storage'),
      }
    );
    clients.push(client);
    return client;
  }

  it('requires explicit login, persists credentials, refreshes, and isolates ACP', async () => {
    const ready = await startFixture();
    const callbackPort = await findCallbackPort();
    const client = createClient(ready, callbackPort);

    await expect(client.connectWithRetry(1, 1)).rejects.toBeInstanceOf(
      McpOAuthAuthorizationRequiredError
    );
    expect(await client.getOAuthStatus()).toBe('unauthenticated');
    expect(await (await fetch(`${ready.origin}/stats`)).json()).toMatchObject({
      authorizationCount: 0,
      tokenExchangeCount: 0,
    });

    const login = await client.beginOAuthLogin();
    expect(login.authorizationUrl).toContain('/authorize?');
    expect(await client.getOAuthStatus()).toBe('authorizing');
    const pendingStore = JSON.parse(
      await readFile(
        path.join(root, 'storage', 'mcp', 'oauth-credentials.json'),
        'utf8'
      )
    ) as {
      credentials: Record<string, { clientInformation?: { client_id?: string } }>;
    };
    expect(
      Object.values(pendingStore.credentials)[0]?.clientInformation?.client_id
    ).toMatch(/^client-/);
    const competingClient = createClient(ready, callbackPort);
    await expect(competingClient.beginOAuthLogin()).rejects.toThrow(
      'Another MCP OAuth authorization is already in progress'
    );
    const browserResponse = await fetch(login.authorizationUrl);
    await login.completion;
    expect(browserResponse.status).toBe(200);
    expect(await client.getOAuthStatus()).toBe('authenticated');

    await client.connectWithRetry(1, 1);
    const first = await client.callTool('oauth_marker', { marker: 'FIRST' });
    expect(first.content[0]?.text).toBe('MCP_OAUTH_OK:FIRST');

    await new Promise((resolve) => setTimeout(resolve, 900));
    const second = await client.callTool('oauth_marker', { marker: 'REFRESHED' });
    expect(second.content[0]?.text).toBe('MCP_OAUTH_OK:REFRESHED');
    await expect
      .poll(async () => {
        const stats = (await (await fetch(`${ready.origin}/stats`)).json()) as {
          refreshCount: number;
        };
        return stats.refreshCount;
      })
      .toBeGreaterThanOrEqual(1);

    const storePath = path.join(root, 'storage', 'mcp', 'oauth-credentials.json');
    await expect(access(storePath)).resolves.toBeUndefined();
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);

    await client.disconnect();
    const resumed = createClient(ready, callbackPort);
    await resumed.connectWithRetry(1, 1);
    const resumedResult = await resumed.callTool('oauth_marker', {
      marker: 'PERSISTED',
    });
    expect(resumedResult.content[0]?.text).toBe('MCP_OAUTH_OK:PERSISTED');

    const acp = createClient(ready, callbackPort, false);
    await expect(acp.connectWithRetry(1, 1)).rejects.toBeInstanceOf(
      McpOAuthUnavailableError
    );
    expect(await acp.getOAuthStatus()).toBe('unavailable');

    await resumed.logoutOAuth();
    const loggedOut = createClient(ready, callbackPort);
    await expect(loggedOut.connectWithRetry(1, 1)).rejects.toBeInstanceOf(
      McpOAuthAuthorizationRequiredError
    );

    const trace = await readFile(traceFile, 'utf8');
    expect(trace).toContain('"event":"client_registered"');
    expect(trace).toContain('"event":"authorization_code_exchanged"');
    expect(trace).toContain('"event":"token_refreshed"');
    expect(trace).not.toContain('access-');
    expect(trace).not.toContain('refresh-');

    await fixture?.processTree.terminate();
    await expect
      .poll(() => {
        try {
          process.kill(ready.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
});
