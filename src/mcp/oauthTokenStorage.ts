import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export class OAuthTokenStorage {
  private storagePath: string;
  private encryptionKey: string;

  constructor(options: TokenStorageOptions = {}) {
    this.storagePath = options.storagePath || this.getDefaultStoragePath();
    this.encryptionKey = options.encryptionKey || this.generateDefaultKey();
  }

  private getDefaultStoragePath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.blade', 'oauth-tokens.json');
  }

  private generateDefaultKey(): string {
    // 在生产环境中，应该从安全的地方获取密钥
    return (
      process.env.BLADE_OAUTH_ENCRYPTION_KEY || 'default-encryption-key-32-characters'
    );
  }

  public async saveToken(provider: string, token: OAuthToken): Promise<void> {
    try {
      // 确保存储目录存在
      const dir = path.dirname(this.storagePath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error: any) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }

      // 加载现有令牌
      const tokens = await this.loadAllTokens();

      // 加密令牌
      const encryptedToken = this.encryptToken(token);

      // 保存令牌
      tokens[provider] = {
        ...encryptedToken,
        timestamp: Date.now(),
      };

      const content = JSON.stringify(tokens, null, 2);
      await fs.writeFile(this.storagePath, content, 'utf-8');

      console.log(`令牌已保存: ${provider}`);
    } catch (error) {
      console.error('保存令牌失败:', error);
      throw error;
    }
  }

  public async getToken(provider: string): Promise<OAuthToken | null> {
    try {
      const tokens = await this.loadAllTokens();
      const storedToken = tokens[provider];

      if (!storedToken) {
        return null;
      }

      // 检查令牌是否过期
      if (this.isTokenExpired(storedToken)) {
        console.log(`令牌已过期: ${provider}`);
        return null;
      }

      // 解密令牌
      return this.decryptToken(storedToken);
    } catch (error) {
      console.error('获取令牌失败:', error);
      return null;
    }
  }

  public async removeToken(provider: string): Promise<void> {
    try {
      const tokens = await this.loadAllTokens();

      if (tokens[provider]) {
        delete tokens[provider];
        const content = JSON.stringify(tokens, null, 2);
        await fs.writeFile(this.storagePath, content, 'utf-8');
        console.log(`令牌已删除: ${provider}`);
      }
    } catch (error) {
      console.error('删除令牌失败:', error);
      throw error;
    }
  }

  public async clearAllTokens(): Promise<void> {
    try {
      await fs.unlink(this.storagePath);
      console.log('所有令牌已清除');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('清除令牌失败:', error);
        throw error;
      }
    }
  }

  public async listProviders(): Promise<string[]> {
    try {
      const tokens = await this.loadAllTokens();
      return Object.keys(tokens);
    } catch (error) {
      console.error('列出提供者失败:', error);
      return [];
    }
  }

  public async getTokenInfo(provider: string): Promise<TokenInfo | null> {
    try {
      const tokens = await this.loadAllTokens();
      const storedToken = tokens[provider];

      if (!storedToken) {
        return null;
      }

      return {
        provider,
        issuedAt: storedToken.issuedAt,
        expiresAt:
          storedToken.issuedAt && storedToken.expiresIn
            ? storedToken.issuedAt + storedToken.expiresIn
            : undefined,
        isExpired: this.isTokenExpired(storedToken),
        scope: storedToken.scope,
        tokenType: storedToken.tokenType,
      };
    } catch (error) {
      console.error('获取令牌信息失败:', error);
      return null;
    }
  }

  private async loadAllTokens(): Promise<Record<string, StoredToken>> {
    try {
      await fs.access(this.storagePath);
      const content = await fs.readFile(this.storagePath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private encryptToken(token: OAuthToken): StoredToken {
    try {
      const algorithm = 'aes-256-cbc';
      const key = crypto.createHash('sha256').update(this.encryptionKey).digest();
      const iv = crypto.randomBytes(16);

      const cipher = crypto.createCipheriv(algorithm, key, iv);

      let encrypted = cipher.update(JSON.stringify(token), 'utf8', 'hex');
      encrypted += cipher.final('hex');

      return {
        accessToken: encrypted,
        refreshToken: token.refreshToken
          ? this.encryptString(token.refreshToken)
          : undefined,
        tokenType: token.tokenType,
        expiresIn: token.expiresIn,
        scope: token.scope,
        issuedAt: token.issuedAt,
        iv: iv.toString('hex'),
        encrypted: true,
      };
    } catch (error) {
      console.error('加密令牌失败，使用明文存储:', error);
      return {
        ...token,
        encrypted: false,
      };
    }
  }

  private decryptToken(storedToken: StoredToken): OAuthToken {
    if (!storedToken.encrypted) {
      return storedToken as unknown as OAuthToken;
    }

    try {
      const algorithm = 'aes-256-cbc';
      const key = crypto.createHash('sha256').update(this.encryptionKey).digest();
      const iv = Buffer.from(storedToken.iv!, 'hex');

      const decipher = crypto.createDecipheriv(algorithm, key, iv);

      let decrypted = decipher.update(storedToken.accessToken!, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const token: OAuthToken = JSON.parse(decrypted);

      if (storedToken.refreshToken) {
        token.refreshToken = this.decryptString(storedToken.refreshToken);
      }

      return token;
    } catch (error) {
      console.error('解密令牌失败:', error);
      throw new Error('令牌解密失败');
    }
  }

  private encryptString(text: string): string {
    try {
      const algorithm = 'aes-256-cbc';
      const key = crypto.createHash('sha256').update(this.encryptionKey).digest();
      const iv = crypto.randomBytes(16);

      const cipher = crypto.createCipheriv(algorithm, key, iv);

      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      return `${encrypted}:${iv.toString('hex')}`;
    } catch (error) {
      console.error('字符串加密失败:', error);
      return text;
    }
  }

  private decryptString(encryptedText: string): string {
    try {
      const [encrypted, ivHex] = encryptedText.split(':');
      const algorithm = 'aes-256-cbc';
      const key = crypto.createHash('sha256').update(this.encryptionKey).digest();
      const iv = Buffer.from(ivHex, 'hex');

      const decipher = crypto.createDecipheriv(algorithm, key, iv);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      console.error('字符串解密失败:', error);
      return encryptedText;
    }
  }

  private isTokenExpired(storedToken: StoredToken): boolean {
    if (!storedToken.expiresIn || !storedToken.issuedAt) {
      return false;
    }

    const expirationTime = storedToken.issuedAt + storedToken.expiresIn;
    const currentTime = Math.floor(Date.now() / 1000);

    // 提前5分钟刷新令牌
    return currentTime >= expirationTime - 300;
  }

  public async cleanupExpiredTokens(): Promise<void> {
    try {
      const tokens = await this.loadAllTokens();
      let modified = false;

      for (const [provider, storedToken] of Object.entries(tokens)) {
        if (this.isTokenExpired(storedToken)) {
          delete tokens[provider];
          modified = true;
          console.log(`已清理过期令牌: ${provider}`);
        }
      }

      if (modified) {
        const content = JSON.stringify(tokens, null, 2);
        await fs.writeFile(this.storagePath, content, 'utf-8');
      }
    } catch (error) {
      console.error('清理过期令牌失败:', error);
    }
  }

  public async backupTokens(backupPath: string): Promise<void> {
    try {
      await fs.copyFile(this.storagePath, backupPath);
      console.log(`令牌备份已创建: ${backupPath}`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('没有令牌需要备份');
      } else {
        console.error('令牌备份失败:', error);
        throw error;
      }
    }
  }

  public async restoreTokens(backupPath: string): Promise<void> {
    try {
      await fs.copyFile(backupPath, this.storagePath);
      console.log(`令牌已从备份恢复: ${backupPath}`);
    } catch (error) {
      console.error('令牌恢复失败:', error);
      throw error;
    }
  }
}

// 类型定义
interface TokenStorageOptions {
  storagePath?: string;
  encryptionKey?: string;
}

interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  scope?: string;
  issuedAt?: number;
}

interface StoredToken extends Partial<OAuthToken> {
  timestamp?: number;
  encrypted?: boolean;
  iv?: string;
}

interface TokenInfo {
  provider: string;
  issuedAt?: number;
  expiresAt?: number;
  isExpired: boolean;
  scope?: string;
  tokenType?: string;
}
