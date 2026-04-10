/**
 * Antigravity OAuth 认证管理器
 *
 * 实现 Google OAuth 2.0 + PKCE 流程，用于获取访问 Antigravity API 的令牌。
 * 基于 src/mcp/auth/OAuthProvider.ts 的实现，针对 Antigravity 进行了定制。
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { proxyFetch } from '../../utils/proxyFetch.js';
import {
  ANTIGRAVITY_OAUTH_CONFIG,
  type AntigravityToken,
  GEMINI_CLI_OAUTH_CONFIG,
  type OAuthConfig,
  type OAuthConfigType,
  type OAuthTokenResponse,
} from './types.js';

const logger = createLogger(LogCategory.SERVICE);

// Token 存储路径
const TOKEN_FILE_NAME = 'antigravity-token.json';

/**
 * 获取 OAuth 配置
 */
function getOAuthConfig(configType: OAuthConfigType): OAuthConfig {
  return configType === 'gemini-cli'
    ? GEMINI_CLI_OAUTH_CONFIG
    : ANTIGRAVITY_OAUTH_CONFIG;
}

/**
 * PKCE 参数
 */
interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

/**
 * 获取 Blade 配置目录
 */
function getBladeConfigDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.blade');
}

/**
 * Antigravity OAuth 认证管理器
 * 单例模式
 */
export class AntigravityAuth {
  private static instance: AntigravityAuth | null = null;
  private cachedToken: AntigravityToken | null = null;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): AntigravityAuth {
    if (!AntigravityAuth.instance) {
      AntigravityAuth.instance = new AntigravityAuth();
    }
    return AntigravityAuth.instance;
  }

  /**
   * 检查是否已登录
   */
  async isLoggedIn(): Promise<boolean> {
    const token = await this.loadToken();
    if (!token) return false;

    // 检查 token 是否过期（提前 5 分钟判断）
    const fiveMinutes = 5 * 60 * 1000;
    if (token.expiresAt && Date.now() > token.expiresAt - fiveMinutes) {
      // Token 即将过期，尝试刷新
      if (token.refreshToken) {
        try {
          await this.refreshToken();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    return true;
  }

  /**
   * 执行登录流程
   * @param configType OAuth 配置类型 (antigravity 或 gemini-cli)
   */
  async login(configType: OAuthConfigType = 'antigravity'): Promise<void> {
    const configName = configType === 'gemini-cli' ? 'Gemini CLI' : 'Antigravity';
    logger.info(`Starting ${configName} OAuth login...`);

    const oauthConfig = getOAuthConfig(configType);

    // 生成 PKCE 参数
    const pkceParams = this.generatePKCEParams();

    // 构建授权 URL
    const authUrl = this.buildAuthorizationUrl(pkceParams, oauthConfig);

    console.log('\nOpening browser for Google authentication...');
    console.log(
      '\nIf the browser does not open automatically, copy and paste this URL:'
    );
    console.log(authUrl);
    console.log('');

    // 启动回调服务器
    const callbackPromise = this.startCallbackServer(pkceParams.state, oauthConfig);

    // 尝试打开浏览器
    try {
      await this.openBrowser(authUrl);
    } catch (error) {
      logger.warn('Failed to open browser automatically:', error);
    }

    // 等待回调
    const code = await callbackPromise;

    console.log('Authorization code received, exchanging for tokens...');

    // 用授权码换取令牌
    const tokenResponse = await this.exchangeCodeForToken(
      code,
      pkceParams.codeVerifier,
      oauthConfig
    );

    // 转换并保存令牌
    const token: AntigravityToken = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || '',
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      tokenType: tokenResponse.token_type || 'Bearer',
      scope: tokenResponse.scope,
      configType, // 保存使用的配置类型
    };

    await this.saveToken(token);
    this.cachedToken = token;

    console.log(`${configName} login successful!`);
    logger.info(`${configName} OAuth login completed`);
  }

  /**
   * 登出
   */
  async logout(): Promise<void> {
    const tokenPath = path.join(getBladeConfigDir(), TOKEN_FILE_NAME);
    try {
      await fs.unlink(tokenPath);
      this.cachedToken = null;
      console.log('Logged out from Antigravity');
      logger.info('Antigravity logout completed');
    } catch (error) {
      // 文件不存在也算登出成功
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.cachedToken = null;
    }
  }

  /**
   * 获取有效的 access token（自动刷新过期的）
   */
  async getAccessToken(): Promise<string> {
    // 检查缓存
    if (this.cachedToken) {
      const fiveMinutes = 5 * 60 * 1000;
      if (this.cachedToken.expiresAt > Date.now() + fiveMinutes) {
        return this.cachedToken.accessToken;
      }
    }

    // 从文件加载
    const token = await this.loadToken();
    if (!token) {
      throw new Error('Not logged in. Please run /login first.');
    }

    // 检查是否需要刷新
    const fiveMinutes = 5 * 60 * 1000;
    if (token.expiresAt <= Date.now() + fiveMinutes) {
      if (!token.refreshToken) {
        throw new Error(
          'Token expired and no refresh token available. Please run /login again.'
        );
      }
      await this.refreshToken();
      return this.cachedToken!.accessToken;
    }

    this.cachedToken = token;
    return token.accessToken;
  }

  /**
   * 刷新 access token
   */
  private async refreshToken(): Promise<void> {
    const token = await this.loadToken();
    if (!token || !token.refreshToken) {
      throw new Error('No refresh token available');
    }

    // 使用存储的配置类型，默认为 antigravity
    const configType = token.configType || 'antigravity';
    const oauthConfig = getOAuthConfig(configType);
    const configName = configType === 'gemini-cli' ? 'Gemini CLI' : 'Antigravity';

    logger.info(`Refreshing ${configName} access token...`);

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
    });

    const response = await proxyFetch(oauthConfig.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Token refresh failed:', errorText);
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const tokenResponse = (await response.json()) as OAuthTokenResponse;

    const newToken: AntigravityToken = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || token.refreshToken,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      tokenType: tokenResponse.token_type || 'Bearer',
      scope: tokenResponse.scope || token.scope,
      configType, // 保留原来的配置类型
    };

    await this.saveToken(newToken);
    this.cachedToken = newToken;

    logger.info('Token refreshed successfully');
  }

  /**
   * 生成 PKCE 参数
   */
  private generatePKCEParams(): PKCEParams {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    return { codeVerifier, codeChallenge, state };
  }

  /**
   * 构建授权 URL
   */
  private buildAuthorizationUrl(
    pkceParams: PKCEParams,
    oauthConfig: OAuthConfig
  ): string {
    const redirectUri = `http://localhost:${oauthConfig.redirectPort}${oauthConfig.redirectPath}`;

    const params = new URLSearchParams({
      client_id: oauthConfig.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state: pkceParams.state,
      code_challenge: pkceParams.codeChallenge,
      code_challenge_method: 'S256',
      scope: oauthConfig.scopes.join(' '),
      access_type: 'offline', // 获取 refresh_token
      prompt: 'consent', // 强制同意页面以获取 refresh_token
    });

    return `${oauthConfig.authorizationUrl}?${params.toString()}`;
  }

  /**
   * 启动本地回调服务器
   */
  private async startCallbackServer(
    expectedState: string,
    oauthConfig: OAuthConfig
  ): Promise<string> {
    const { redirectPort, redirectPath } = oauthConfig;

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let isResolved = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url!, `http://localhost:${redirectPort}`);

          if (url.pathname !== redirectPath) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <html>
                <head><title>Authentication Failed</title></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                  <h1 style="color: #dc2626;">[FAIL] Authentication Failed</h1>
                  <p>Error: ${error}</p>
                  <p>You can close this window.</p>
                </body>
              </html>
            `);
            cleanup();
            server.close();
            if (!isResolved) {
              isResolved = true;
              reject(new Error(`OAuth error: ${error}`));
            }
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
            cleanup();
            server.close();
            if (!isResolved) {
              isResolved = true;
              reject(new Error('State mismatch - possible CSRF attack'));
            }
            return;
          }

          // 成功响应
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <head><title>Authentication Successful</title></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1 style="color: #16a34a;">[OK] Authentication Successful!</h1>
                <p>You can close this window and return to Blade.</p>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body>
            </html>
          `);

          cleanup();
          server.close();
          if (!isResolved) {
            isResolved = true;
            resolve(code);
          }
        } catch (error) {
          cleanup();
          server.close();
          if (!isResolved) {
            isResolved = true;
            reject(error);
          }
        }
      });

      server.on('error', (error) => {
        cleanup();
        if (!isResolved) {
          isResolved = true;
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            reject(
              new Error(
                `Port ${redirectPort} is already in use. Please close other applications using this port.`
              )
            );
          } else {
            reject(error);
          }
        }
      });

      server.listen(redirectPort, () => {
        logger.debug(`OAuth callback server listening on port ${redirectPort}`);
      });

      // 5 分钟超时
      timeoutId = setTimeout(
        () => {
          server.close();
          if (!isResolved) {
            isResolved = true;
            reject(new Error('OAuth callback timeout (5 minutes)'));
          }
        },
        5 * 60 * 1000
      );
    });
  }

  /**
   * 用授权码换取令牌
   */
  private async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    oauthConfig: OAuthConfig
  ): Promise<OAuthTokenResponse> {
    const redirectUri = `http://localhost:${oauthConfig.redirectPort}${oauthConfig.redirectPath}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
    });

    const response = await proxyFetch(oauthConfig.tokenUrl, {
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
   * 打开浏览器
   */
  private async openBrowser(url: string): Promise<void> {
    let command: string;
    let args: string[];

    if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }

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

  /**
   * 保存 token 到文件
   */
  private async saveToken(token: AntigravityToken): Promise<void> {
    const configDir = getBladeConfigDir();
    await fs.mkdir(configDir, { recursive: true, mode: 0o755 });

    const tokenPath = path.join(configDir, TOKEN_FILE_NAME);
    await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  }

  /**
   * 从文件加载 token
   */
  private async loadToken(): Promise<AntigravityToken | null> {
    const tokenPath = path.join(getBladeConfigDir(), TOKEN_FILE_NAME);

    try {
      const content = await fs.readFile(tokenPath, 'utf-8');
      return JSON.parse(content) as AntigravityToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 获取登录状态信息
   */
  async getStatus(): Promise<{
    loggedIn: boolean;
    expiresAt?: Date;
    configType?: OAuthConfigType;
  }> {
    const token = await this.loadToken();
    if (!token) {
      return { loggedIn: false };
    }

    return {
      loggedIn: true,
      expiresAt: token.expiresAt ? new Date(token.expiresAt) : undefined,
      configType: token.configType || 'antigravity',
    };
  }

  /**
   * 获取当前使用的配置类型
   */
  async getConfigType(): Promise<OAuthConfigType | null> {
    const token = await this.loadToken();
    if (!token) {
      return null;
    }
    return token.configType || 'antigravity';
  }
}
