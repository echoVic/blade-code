/**
 * OAuth 认证提供者
 * 实现基础的 OAuth 2.0 授权码流程 + PKCE
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';
import { URL } from 'url';
import { OAuthTokenStorage } from './OAuthTokenStorage.js';
import type { OAuthConfig, OAuthToken, OAuthTokenResponse } from './types.js';

const REDIRECT_PORT = 7777;
const REDIRECT_PATH = '/oauth/callback';
const HTTP_OK = 200;

/**
 * PKCE 参数
 */
interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

/**
 * OAuth 认证提供者
 */
export class OAuthProvider {
  private readonly tokenStorage: OAuthTokenStorage;

  constructor(tokenStorage: OAuthTokenStorage = new OAuthTokenStorage()) {
    this.tokenStorage = tokenStorage;
  }

  /**
   * 生成 PKCE 参数
   */
  private generatePKCEParams(): PKCEParams {
    // 生成 code verifier (43-128 字符)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // 生成 code challenge (SHA256)
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // 生成 state (CSRF 保护)
    const state = crypto.randomBytes(16).toString('base64url');

    return { codeVerifier, codeChallenge, state };
  }

  /**
   * 构建授权 URL
   */
  private buildAuthorizationUrl(config: OAuthConfig, pkceParams: PKCEParams): string {
    const redirectUri =
      config.redirectUri || `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;

    const params = new URLSearchParams({
      client_id: config.clientId!,
      response_type: 'code',
      redirect_uri: redirectUri,
      state: pkceParams.state,
      code_challenge: pkceParams.codeChallenge,
      code_challenge_method: 'S256',
    });

    if (config.scopes && config.scopes.length > 0) {
      params.append('scope', config.scopes.join(' '));
    }

    const url = new URL(config.authorizationUrl!);
    params.forEach((value, key) => {
      url.searchParams.append(key, value);
    });

    return url.toString();
  }

  /**
   * 启动本地回调服务器
   */
  private async startCallbackServer(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

          if (url.pathname !== REDIRECT_PATH) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(HTTP_OK, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body>
                  <h1>Authentication Failed</h1>
                  <p>Error: ${error}</p>
                  <p>You can close this window.</p>
                </body>
              </html>
            `);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code || !state) {
            res.writeHead(400);
            res.end('Missing code or state parameter');
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400);
            res.end('Invalid state parameter');
            server.close();
            reject(new Error('State mismatch - possible CSRF attack'));
            return;
          }

          // 成功响应
          res.writeHead(HTTP_OK, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>Authentication Successful!</h1>
                <p>You can close this window and return to Blade.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);

          server.close();
          resolve(code);
        } catch (error) {
          server.close();
          reject(error);
        }
      });

      server.on('error', reject);
      server.listen(REDIRECT_PORT, () => {
        console.log(`[OAuth] Callback server listening on port ${REDIRECT_PORT}`);
      });

      // 5 分钟超时
      setTimeout(
        () => {
          server.close();
          reject(new Error('OAuth callback timeout'));
        },
        5 * 60 * 1000
      );
    });
  }

  /**
   * 用授权码换取令牌
   */
  private async exchangeCodeForToken(
    config: OAuthConfig,
    code: string,
    codeVerifier: string
  ): Promise<OAuthTokenResponse> {
    const redirectUri =
      config.redirectUri || `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: config.clientId!,
    });

    if (config.clientSecret) {
      params.append('client_secret', config.clientSecret);
    }

    const response = await fetch(config.tokenUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  /**
   * 刷新访问令牌
   */
  async refreshAccessToken(
    config: OAuthConfig,
    refreshToken: string
  ): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId!,
    });

    if (config.clientSecret) {
      params.append('client_secret', config.clientSecret);
    }

    if (config.scopes && config.scopes.length > 0) {
      params.append('scope', config.scopes.join(' '));
    }

    const response = await fetch(config.tokenUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  /**
   * 执行完整的 OAuth 授权流程
   */
  async authenticate(serverName: string, config: OAuthConfig): Promise<OAuthToken> {
    // 验证配置
    if (!config.clientId || !config.authorizationUrl || !config.tokenUrl) {
      throw new Error('Missing required OAuth configuration');
    }

    // 生成 PKCE 参数
    const pkceParams = this.generatePKCEParams();

    // 构建授权 URL
    const authUrl = this.buildAuthorizationUrl(config, pkceParams);

    console.log('\n[OAuth] Opening browser for authentication...');
    console.log(
      '\nIf the browser does not open automatically, copy and paste this URL:'
    );
    console.log(authUrl);
    console.log('');

    // 启动回调服务器
    const callbackPromise = this.startCallbackServer(pkceParams.state);

    // 尝试打开浏览器
    try {
      await this.openAuthorizationUrl(authUrl);
    } catch (error) {
      console.warn('[OAuth] Failed to open browser automatically:', error);
    }

    // 等待回调
    const code = await callbackPromise;

    console.log('[OAuth] Authorization code received, exchanging for tokens...');

    // 用授权码换取令牌
    const tokenResponse = await this.exchangeCodeForToken(
      config,
      code,
      pkceParams.codeVerifier
    );

    // 转换为内部令牌格式
    const token: OAuthToken = {
      accessToken: tokenResponse.access_token,
      tokenType: tokenResponse.token_type || 'Bearer',
      refreshToken: tokenResponse.refresh_token,
      scope: tokenResponse.scope,
    };

    if (tokenResponse.expires_in) {
      token.expiresAt = Date.now() + tokenResponse.expires_in * 1000;
    }

    // 保存令牌
    await this.tokenStorage.saveToken(
      serverName,
      token,
      config.clientId,
      config.tokenUrl
    );

    console.log('[OAuth] Authentication successful! Token saved.');

    return token;
  }

  /**
   * 打开系统浏览器
   */
  private async openAuthorizationUrl(authUrl: string): Promise<void> {
    const { command, args } = this.getBrowserCommand(authUrl);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Failed to open browser (exit code ${code})`));
        }
      });
    });
  }

  private getBrowserCommand(url: string): { command: string; args: string[] } {
    if (process.platform === 'darwin') {
      return { command: 'open', args: [url] };
    }

    if (process.platform === 'win32') {
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    }

    return { command: 'xdg-open', args: [url] };
  }

  /**
   * 获取有效令牌（自动刷新）
   */
  async getValidToken(serverName: string, config: OAuthConfig): Promise<string | null> {
    const credentials = await this.tokenStorage.getCredentials(serverName);

    if (!credentials) {
      return null;
    }

    const { token } = credentials;

    // 检查令牌是否过期
    if (!this.tokenStorage.isTokenExpired(token)) {
      return token.accessToken;
    }

    // 尝试刷新令牌
    if (token.refreshToken && config.clientId && credentials.tokenUrl) {
      try {
        console.log(`[OAuth] Refreshing expired token for server: ${serverName}`);

        const newTokenResponse = await this.refreshAccessToken(
          config,
          token.refreshToken
        );

        // 更新存储的令牌
        const newToken: OAuthToken = {
          accessToken: newTokenResponse.access_token,
          tokenType: newTokenResponse.token_type,
          refreshToken: newTokenResponse.refresh_token || token.refreshToken,
          scope: newTokenResponse.scope || token.scope,
        };

        if (newTokenResponse.expires_in) {
          newToken.expiresAt = Date.now() + newTokenResponse.expires_in * 1000;
        }

        await this.tokenStorage.saveToken(
          serverName,
          newToken,
          config.clientId,
          credentials.tokenUrl
        );

        return newToken.accessToken;
      } catch (error) {
        console.error('[OAuth] Failed to refresh token:', error);
        // 删除无效令牌
        await this.tokenStorage.deleteCredentials(serverName);
      }
    }

    return null;
  }
}
