import { randomUUID } from 'node:crypto';
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import open from 'open';
import { getPackageName, getVersion } from '../../utils/packageInfo.js';
import { assertSafeMcpOAuthUrl, safeMcpOAuthFetch } from './McpOAuthPolicy.js';
import {
  canonicalMcpOAuthServerUrl,
  mcpOAuthCredentialId,
  OAuthTokenStorage,
} from './OAuthTokenStorage.js';
import type {
  McpOAuthCredential,
  McpOAuthLoginHandle,
  McpOAuthProvider,
  McpOAuthStatus,
  OAuthConfig,
} from './types.js';

const CALLBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_PORT = 7777;
const CALLBACK_PATH = '/oauth/callback';
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

interface ActiveOAuthFlow {
  flowId: string;
  state: string;
  authorizationUrl?: string;
  callbackUrl: string;
  server: Server;
  timeout: NodeJS.Timeout;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export class McpOAuthAuthorizationRequiredError extends Error {
  constructor(serverName: string) {
    super(
      `MCP server "${serverName}" requires OAuth authorization; run "blade mcp login ${serverName}" or use the Web MCP panel`
    );
    this.name = 'McpOAuthAuthorizationRequiredError';
  }
}

export class McpOAuthUnavailableError extends Error {
  constructor(serverName: string) {
    super(
      `MCP OAuth credentials are unavailable in this runtime for server "${serverName}"`
    );
    this.name = 'McpOAuthUnavailableError';
  }
}

function callbackHtml(success: boolean): string {
  const title = success ? 'Authentication complete' : 'Authentication failed';
  const message = success
    ? 'You can close this window and return to Blade.'
    : 'Return to Blade and retry the OAuth login.';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}

function writeCallbackResponse(
  response: ServerResponse,
  status: number,
  success: boolean
): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(callbackHtml(success));
}

export interface OAuthProviderOptions {
  tokenStorage?: OAuthTokenStorage;
  openAuthorizationUrl?: (url: string) => Promise<void>;
}

export class OAuthProvider implements McpOAuthProvider, OAuthClientProvider {
  private static activeFlowIdentity?: string;

  private readonly tokenStorage: OAuthTokenStorage;
  private readonly serverUrl: string;
  private readonly identity: string;
  private readonly callbackUrl: string;
  private readonly openAuthorizationUrl: (url: string) => Promise<void>;
  private codeVerifierValue?: string;
  private activeFlow?: ActiveOAuthFlow;
  private lastError?: Error;

  constructor(
    private readonly serverName: string,
    serverUrl: string,
    private readonly config: OAuthConfig,
    options: OAuthProviderOptions = {}
  ) {
    this.serverUrl = canonicalMcpOAuthServerUrl(serverUrl);
    this.identity = mcpOAuthCredentialId(
      this.serverUrl,
      config.clientId,
      config.scopes
    );
    this.tokenStorage = options.tokenStorage ?? new OAuthTokenStorage();
    const callbackPort = config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.callbackUrl = `http://${CALLBACK_HOST}:${callbackPort}${CALLBACK_PATH}`;
    this.openAuthorizationUrl =
      options.openAuthorizationUrl ??
      (async (url) => {
        await open(url, { wait: false });
      });
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.callbackUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: `${getPackageName()} ${getVersion()}`,
      ...(this.config.scopes?.length ? { scope: this.config.scopes.join(' ') } : {}),
    };
  }

  async state(): Promise<string> {
    return this.activeFlow?.state ?? randomUUID();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) {
      return { client_id: this.config.clientId };
    }
    return (await this.readCredential())?.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed
  ): Promise<void> {
    await this.updateCredential((current) => ({
      ...this.baseCredential(current),
      clientInformation,
    }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const credential = await this.readCredential();
    if (!credential?.tokens) return undefined;
    if (
      credential.tokenExpiresAt !== undefined &&
      credential.tokenExpiresAt <= Date.now() &&
      !credential.tokens.refresh_token
    ) {
      return undefined;
    }
    return structuredClone(credential.tokens);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const tokenExpiresAt =
      tokens.expires_in === undefined
        ? undefined
        : Date.now() + tokens.expires_in * 1000;
    await this.updateCredential((current) => ({
      ...this.baseCredential(current),
      tokens: structuredClone(tokens),
      ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
    }));
    this.lastError = undefined;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const flow = this.activeFlow;
    if (!flow) {
      throw new McpOAuthAuthorizationRequiredError(this.serverName);
    }
    flow.authorizationUrl = assertSafeMcpOAuthUrl(
      authorizationUrl,
      'MCP OAuth authorization URL'
    ).toString();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this.codeVerifierValue) {
      throw new Error('MCP OAuth PKCE verifier is unavailable');
    }
    return this.codeVerifierValue;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.updateCredential((current) => ({
      ...this.baseCredential(current),
      discoveryState: structuredClone(state),
    }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = (await this.readCredential())?.discoveryState;
    return state ? structuredClone(state) : undefined;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'verifier') {
      this.codeVerifierValue = undefined;
      return;
    }
    if (scope === 'all') {
      await this.tokenStorage.deleteCredential(this.identity);
      this.codeVerifierValue = undefined;
      return;
    }
    await this.updateCredential((current) => {
      if (!current) return null;
      const next = { ...current };
      if (scope === 'client') {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokenExpiresAt;
      } else if (scope === 'tokens') {
        delete next.tokens;
        delete next.tokenExpiresAt;
      } else if (scope === 'discovery') {
        delete next.discoveryState;
      }
      return { ...next, updatedAt: new Date().toISOString() };
    });
  }

  async getStatus(): Promise<McpOAuthStatus> {
    if (this.activeFlow) return 'authorizing';
    if (this.lastError) return 'error';
    return (await this.hasUsableCredentials()) ? 'authenticated' : 'unauthenticated';
  }

  async hasUsableCredentials(): Promise<boolean> {
    const credential = await this.readCredential();
    if (!credential?.tokens?.access_token) return false;
    if (
      credential.tokenExpiresAt === undefined ||
      credential.tokenExpiresAt > Date.now()
    ) {
      return true;
    }
    return Boolean(credential.tokens.refresh_token);
  }

  async beginAuthorization(): Promise<McpOAuthLoginHandle> {
    if (this.activeFlow) return this.toHandle(this.activeFlow);
    if (await this.hasUsableCredentials()) {
      throw new Error(`MCP server "${this.serverName}" already has OAuth credentials`);
    }
    if (OAuthProvider.activeFlowIdentity) {
      throw new Error('Another MCP OAuth authorization is already in progress');
    }

    OAuthProvider.activeFlowIdentity = this.identity;
    this.lastError = undefined;
    this.codeVerifierValue = undefined;

    try {
      const flow = await this.createFlow();
      this.activeFlow = flow;
      const result = await auth(this, {
        serverUrl: this.serverUrl,
        fetchFn: safeMcpOAuthFetch,
      });
      if (result !== 'REDIRECT' || !flow.authorizationUrl) {
        throw new Error('MCP OAuth server did not start an authorization redirect');
      }
      return this.toHandle(flow);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await this.failActiveFlow(normalized);
      throw normalized;
    }
  }

  async openAuthorization(): Promise<McpOAuthLoginHandle> {
    const handle = await this.beginAuthorization();
    await this.openAuthorizationUrl(handle.authorizationUrl);
    return handle;
  }

  async logout(): Promise<void> {
    if (this.activeFlow) {
      await this.failActiveFlow(new Error('MCP OAuth authorization cancelled'));
    }
    await this.tokenStorage.deleteCredential(this.identity);
    this.codeVerifierValue = undefined;
    this.lastError = undefined;
  }

  async dispose(): Promise<void> {
    if (this.activeFlow) {
      await this.failActiveFlow(new Error('MCP OAuth authorization cancelled'));
    }
  }

  private async createFlow(): Promise<ActiveOAuthFlow> {
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    const state = randomUUID();
    const server = http.createServer((request, response) => {
      void this.handleCallback(request, response);
    });
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(
        this.config.callbackPort ?? DEFAULT_CALLBACK_PORT,
        CALLBACK_HOST,
        () => {
          server.off('error', onError);
          resolve();
        }
      );
    });

    const flow: ActiveOAuthFlow = {
      flowId: randomUUID(),
      state,
      callbackUrl: this.callbackUrl,
      server,
      timeout: setTimeout(() => {
        void this.failActiveFlow(new Error('MCP OAuth authorization timed out'));
      }, AUTHORIZATION_TIMEOUT_MS),
      completion,
      resolve: resolveCompletion!,
      reject: rejectCompletion!,
      settled: false,
    };
    flow.timeout.unref();
    return flow;
  }

  private async handleCallback(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const flow = this.activeFlow;
    if (!flow) {
      writeCallbackResponse(response, 410, false);
      return;
    }
    try {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        writeCallbackResponse(response, 405, false);
        return;
      }
      const callback = new URL(request.url ?? '/', flow.callbackUrl);
      if (callback.pathname !== CALLBACK_PATH) {
        writeCallbackResponse(response, 404, false);
        return;
      }
      const returnedState = callback.searchParams.get('state');
      const authorizationCode = callback.searchParams.get('code');
      const oauthError = callback.searchParams.get('error');
      if (oauthError) {
        throw new Error('MCP OAuth authorization was denied');
      }
      if (!returnedState || returnedState !== flow.state) {
        throw new Error('MCP OAuth state mismatch');
      }
      if (!authorizationCode) {
        throw new Error('MCP OAuth callback is missing the authorization code');
      }

      const result = await auth(this, {
        serverUrl: this.serverUrl,
        authorizationCode,
        fetchFn: safeMcpOAuthFetch,
      });
      if (result !== 'AUTHORIZED') {
        throw new Error('MCP OAuth token exchange did not complete');
      }
      writeCallbackResponse(response, 200, true);
      await this.completeActiveFlow();
    } catch (error) {
      writeCallbackResponse(response, 400, false);
      await this.failActiveFlow(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async completeActiveFlow(): Promise<void> {
    const flow = this.activeFlow;
    if (!flow || flow.settled) return;
    flow.settled = true;
    clearTimeout(flow.timeout);
    await new Promise<void>((resolve) => flow.server.close(() => resolve()));
    this.activeFlow = undefined;
    OAuthProvider.activeFlowIdentity = undefined;
    this.codeVerifierValue = undefined;
    this.lastError = undefined;
    flow.resolve();
  }

  private async failActiveFlow(error: Error): Promise<void> {
    const flow = this.activeFlow;
    this.lastError = error;
    this.codeVerifierValue = undefined;
    OAuthProvider.activeFlowIdentity = undefined;
    if (!flow || flow.settled) {
      this.activeFlow = undefined;
      return;
    }
    flow.settled = true;
    clearTimeout(flow.timeout);
    await new Promise<void>((resolve) => flow.server.close(() => resolve()));
    this.activeFlow = undefined;
    flow.reject(error);
  }

  private toHandle(flow: ActiveOAuthFlow): McpOAuthLoginHandle {
    if (!flow.authorizationUrl) {
      throw new Error('MCP OAuth authorization URL is unavailable');
    }
    return {
      flowId: flow.flowId,
      authorizationUrl: flow.authorizationUrl,
      callbackUrl: flow.callbackUrl,
      completion: flow.completion,
    };
  }

  private readCredential(): Promise<McpOAuthCredential | null> {
    return this.tokenStorage.getCredential(this.identity);
  }

  private updateCredential(
    update: (current: McpOAuthCredential | null) => McpOAuthCredential | null
  ): Promise<McpOAuthCredential | null> {
    return this.tokenStorage.updateCredential(this.identity, update);
  }

  private baseCredential(current: McpOAuthCredential | null): McpOAuthCredential {
    return {
      ...(current ?? {}),
      serverUrl: this.serverUrl,
      ...(this.config.clientId ? { clientId: this.config.clientId } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
}
