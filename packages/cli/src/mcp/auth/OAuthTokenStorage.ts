/**
 * OAuth 令牌存储
 * 使用文件系统存储令牌
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { OAuthCredentials, OAuthToken } from './types.js';

/**
 * OAuth 令牌存储类
 */
export class OAuthTokenStorage {
  private readonly tokenFilePath: string;

  constructor() {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.blade');
    this.tokenFilePath = path.join(configDir, 'mcp-oauth-tokens.json');
  }

  /**
   * 确保配置目录存在
   */
  private async ensureConfigDir(): Promise<void> {
    const configDir = path.dirname(this.tokenFilePath);
    try {
      await fs.mkdir(configDir, { recursive: true, mode: 0o755 });
    } catch {
      // 忽略目录已存在错误
    }
  }

  /**
   * 加载所有凭证
   */
  private async loadAllCredentials(): Promise<Map<string, OAuthCredentials>> {
    const credentialsMap = new Map<string, OAuthCredentials>();

    try {
      const data = await fs.readFile(this.tokenFilePath, 'utf-8');
      const credentials = JSON.parse(data) as OAuthCredentials[];

      for (const cred of credentials) {
        credentialsMap.set(cred.serverName, cred);
      }
    } catch (error) {
      // 文件不存在时返回空 Map
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[OAuthTokenStorage] 加载令牌失败:', error);
      }
    }

    return credentialsMap;
  }

  /**
   * 保存所有凭证
   */
  private async saveAllCredentials(
    credentialsMap: Map<string, OAuthCredentials>
  ): Promise<void> {
    await this.ensureConfigDir();

    const credentials = Array.from(credentialsMap.values());
    await fs.writeFile(
      this.tokenFilePath,
      JSON.stringify(credentials, null, 2),
      { mode: 0o600 } // 限制文件权限
    );
  }

  /**
   * 保存令牌
   */
  async saveToken(
    serverName: string,
    token: OAuthToken,
    clientId?: string,
    tokenUrl?: string
  ): Promise<void> {
    const credentials = await this.loadAllCredentials();

    const credential: OAuthCredentials = {
      serverName,
      token,
      clientId,
      tokenUrl,
      updatedAt: Date.now(),
    };

    credentials.set(serverName, credential);
    await this.saveAllCredentials(credentials);
  }

  /**
   * 获取凭证
   */
  async getCredentials(serverName: string): Promise<OAuthCredentials | null> {
    const credentials = await this.loadAllCredentials();
    return credentials.get(serverName) || null;
  }

  /**
   * 删除凭证
   */
  async deleteCredentials(serverName: string): Promise<void> {
    const credentials = await this.loadAllCredentials();
    credentials.delete(serverName);
    await this.saveAllCredentials(credentials);
  }

  /**
   * 列出所有服务器
   */
  async listServers(): Promise<string[]> {
    const credentials = await this.loadAllCredentials();
    return Array.from(credentials.keys());
  }

  /**
   * 检查令牌是否过期
   */
  isTokenExpired(token: OAuthToken): boolean {
    if (!token.expiresAt) {
      return false; // 没有过期时间，认为不过期
    }

    // 提前 5 分钟视为过期，留出刷新时间
    const buffer = 5 * 60 * 1000;
    return Date.now() >= token.expiresAt - buffer;
  }
}
