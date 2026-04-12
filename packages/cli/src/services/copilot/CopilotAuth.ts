/**
 * GitHub Copilot OAuth 认证管理器
 *
 * 实现 GitHub Device Flow OAuth + Copilot Token 交换流程。
 *
 * 认证流程：
 * 1. Device Flow: 获取 device_code 和 user_code
 * 2. 用户在浏览器中输入 user_code 授权
 * 3. 轮询获取 GitHub access token (gho_xxx)
 * 4. 用 GitHub token 换取 Copilot completion token
 * 5. 用 Copilot token 调用 API
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { proxyFetch } from '../../utils/proxyFetch.js';
import {
  COPILOT_API_ENDPOINTS,
  COPILOT_OAUTH_CONFIG,
  type CopilotToken,
  type CopilotTokenResponse,
  type DeviceCodeResponse,
  type GitHubTokenResponse,
} from './types.js';

const logger = createLogger(LogCategory.SERVICE);

// Token 存储路径
const TOKEN_FILE_NAME = 'copilot-token.json';

/**
 * 获取 Blade 配置目录
 */
function getBladeConfigDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.blade');
}

/**
 * GitHub Copilot OAuth 认证管理器
 * 单例模式
 */
export class CopilotAuth {
  private static instance: CopilotAuth | null = null;
  private cachedToken: CopilotToken | null = null;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): CopilotAuth {
    if (!CopilotAuth.instance) {
      CopilotAuth.instance = new CopilotAuth();
    }
    return CopilotAuth.instance;
  }

  /**
   * 检查是否已登录
   */
  async isLoggedIn(): Promise<boolean> {
    const token = await this.loadToken();
    if (!token) return false;

    // 检查 Copilot token 是否过期（提前 5 分钟判断）
    const fiveMinutes = 5 * 60 * 1000;
    if (token.copilotExpiresAt && Date.now() > token.copilotExpiresAt - fiveMinutes) {
      // Token 即将过期，尝试刷新
      try {
        await this.refreshCopilotToken();
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * 执行登录流程 (Device Flow OAuth)
   */
  async login(): Promise<void> {
    logger.info('Starting GitHub Copilot OAuth login...');

    // Step 1: 请求 device code
    console.log('\nStarting GitHub Copilot authentication...');
    const deviceCode = await this.requestDeviceCode();

    // Step 2: 显示用户码，让用户在浏览器中授权
    console.log('\nPlease complete authorization in your browser:');
    console.log(`   1. 打开 ${deviceCode.verification_uri}`);
    console.log(`   2. 输入代码: ${deviceCode.user_code}`);
    console.log('');

    // 尝试打开浏览器
    try {
      await this.openBrowser(deviceCode.verification_uri);
      console.log('Browser opened automatically, please enter the code above to complete authorization');
    } catch {
      console.log('Unable to open browser automatically, please open the link above manually');
    }

    console.log('\nWaiting for authorization...');

    // Step 3: 轮询获取 access token
    const githubToken = await this.pollForAccessToken(
      deviceCode.device_code,
      deviceCode.interval,
      deviceCode.expires_in
    );

    console.log('GitHub authorization successful!');
    console.log('Obtaining Copilot token...');

    // Step 4: 用 GitHub token 换取 Copilot token
    const copilotTokenResponse = await this.exchangeForCopilotToken(githubToken);

    // Step 5: 保存 token
    const token: CopilotToken = {
      githubToken,
      copilotToken: copilotTokenResponse.token,
      copilotExpiresAt: copilotTokenResponse.expires_at * 1000, // 转换为 ms
    };

    await this.saveToken(token);
    this.cachedToken = token;

    console.log('GitHub Copilot login successful!');
    logger.info('GitHub Copilot OAuth login completed');
  }

  /**
   * 登出
   */
  async logout(): Promise<void> {
    const tokenPath = path.join(getBladeConfigDir(), TOKEN_FILE_NAME);
    try {
      await fs.unlink(tokenPath);
      this.cachedToken = null;
      console.log('Logged out from GitHub Copilot');
      logger.info('GitHub Copilot logout completed');
    } catch (error) {
      // 文件不存在也算登出成功
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.cachedToken = null;
    }
  }

  /**
   * 获取有效的 Copilot token（自动刷新过期的）
   */
  async getCopilotToken(): Promise<string> {
    // 检查缓存
    if (this.cachedToken) {
      const fiveMinutes = 5 * 60 * 1000;
      if (this.cachedToken.copilotExpiresAt > Date.now() + fiveMinutes) {
        return this.cachedToken.copilotToken;
      }
    }

    // 从文件加载
    const token = await this.loadToken();
    if (!token) {
      throw new Error(
        'Not logged in to GitHub Copilot. Please run /login copilot first.'
      );
    }

    // 检查是否需要刷新
    const fiveMinutes = 5 * 60 * 1000;
    if (token.copilotExpiresAt <= Date.now() + fiveMinutes) {
      await this.refreshCopilotToken();
      return this.cachedToken!.copilotToken;
    }

    this.cachedToken = token;
    return token.copilotToken;
  }

  /**
   * 刷新 Copilot token
   */
  private async refreshCopilotToken(): Promise<void> {
    const token = await this.loadToken();
    if (!token || !token.githubToken) {
      throw new Error('No GitHub token available');
    }

    logger.info('Refreshing Copilot token...');

    // 用 GitHub token 重新换取 Copilot token
    const copilotTokenResponse = await this.exchangeForCopilotToken(token.githubToken);

    const newToken: CopilotToken = {
      githubToken: token.githubToken,
      copilotToken: copilotTokenResponse.token,
      copilotExpiresAt: copilotTokenResponse.expires_at * 1000,
    };

    await this.saveToken(newToken);
    this.cachedToken = newToken;

    logger.info('Copilot token refreshed successfully');
  }

  /**
   * 请求 device code
   */
  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const params = new URLSearchParams({
      client_id: COPILOT_OAUTH_CONFIG.clientId,
      scope: COPILOT_OAUTH_CONFIG.scope,
    });

    const response = await proxyFetch(COPILOT_OAUTH_CONFIG.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to request device code: ${response.status} - ${errorText}`
      );
    }

    return (await response.json()) as DeviceCodeResponse;
  }

  /**
   * 轮询获取 access token
   */
  private async pollForAccessToken(
    deviceCode: string,
    interval: number,
    expiresIn: number
  ): Promise<string> {
    const startTime = Date.now();
    const timeoutMs = expiresIn * 1000;

    while (Date.now() - startTime < timeoutMs) {
      // 等待指定间隔
      await this.sleep(interval * 1000);

      const params = new URLSearchParams({
        client_id: COPILOT_OAUTH_CONFIG.clientId,
        device_code: deviceCode,
        grant_type: COPILOT_OAUTH_CONFIG.grantType,
      });

      const response = await proxyFetch(COPILOT_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params.toString(),
      });

      const data = (await response.json()) as GitHubTokenResponse;

      if (data.access_token) {
        return data.access_token;
      }

      if (data.error === 'authorization_pending') {
        // 用户还没授权，继续轮询
        continue;
      }

      if (data.error === 'slow_down') {
        // 需要减慢轮询速度
        interval += 5;
        continue;
      }

      if (data.error === 'expired_token') {
        throw new Error('Device code expired. Please try again.');
      }

      if (data.error === 'access_denied') {
        throw new Error('Authorization denied by user.');
      }

      if (data.error) {
        throw new Error(`OAuth error: ${data.error} - ${data.error_description || ''}`);
      }
    }

    throw new Error('Device code expired. Please try again.');
  }

  /**
   * 用 GitHub token 换取 Copilot token
   */
  private async exchangeForCopilotToken(
    githubToken: string
  ): Promise<CopilotTokenResponse> {
    const response = await proxyFetch(COPILOT_API_ENDPOINTS.tokenExchange, {
      method: 'GET',
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.22.2024',
        'Editor-Version': 'vscode/1.95.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.2024',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401) {
        throw new Error(
          'GitHub token is invalid or expired. Please run /login copilot again.'
        );
      }
      if (response.status === 403) {
        throw new Error(
          'No Copilot subscription found. Please ensure you have an active GitHub Copilot subscription.'
        );
      }
      throw new Error(
        `Failed to exchange for Copilot token: ${response.status} - ${errorText}`
      );
    }

    return (await response.json()) as CopilotTokenResponse;
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
  private async saveToken(token: CopilotToken): Promise<void> {
    const configDir = getBladeConfigDir();
    await fs.mkdir(configDir, { recursive: true, mode: 0o755 });

    const tokenPath = path.join(configDir, TOKEN_FILE_NAME);
    await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  }

  /**
   * 从文件加载 token
   */
  private async loadToken(): Promise<CopilotToken | null> {
    const tokenPath = path.join(getBladeConfigDir(), TOKEN_FILE_NAME);

    try {
      const content = await fs.readFile(tokenPath, 'utf-8');
      return JSON.parse(content) as CopilotToken;
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
  }> {
    const token = await this.loadToken();
    if (!token) {
      return { loggedIn: false };
    }

    return {
      loggedIn: true,
      expiresAt: token.copilotExpiresAt ? new Date(token.copilotExpiresAt) : undefined,
    };
  }

  /**
   * 辅助函数：sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
