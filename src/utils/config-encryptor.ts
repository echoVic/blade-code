/**
 * 配置加密工具
 * 使用 AES-256-GCM 加密敏感配置信息
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export class ConfigEncryptor {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly SALT_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly KEY_LENGTH = 32;
  private static readonly SCRYPT_ITERATIONS = 100000;
  private static readonly SCRYPT_DIGEST = 'sha256';

  // 敏感字段列表
  private static readonly SENSITIVE_FIELDS = [
    'apiKey',
    'searchApiKey',
    'secret',
    'token',
    'password',
    'credential',
  ];

  /**
   * 加密数据
   * @param data 要加密的数据
   * @param password 加密密码
   * @returns 加密后的数据（base64 格式）
   */
  static encrypt(data: string, password?: string): string {
    const encryptionPassword = password || this.getEncryptionPassword();

    // 生成随机 salt
    const salt = randomBytes(this.SALT_LENGTH);

    // 派生密钥
    const key = scryptSync(encryptionPassword, salt, this.KEY_LENGTH, {
      N: this.SCRYPT_ITERATIONS,
    });

    // 生成随机 IV
    const iv = randomBytes(this.IV_LENGTH);

    // 创建加密器
    const cipher = createCipheriv(this.ALGORITHM, key, iv);

    // 加密数据
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // 获取认证标签
    const authTag = cipher.getAuthTag();

    // 组合所有组件：salt + iv + authTag + encrypted
    const combined = Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'hex')]);

    return combined.toString('base64');
  }

  /**
   * 解密数据
   * @param encryptedData 加密的数据
   * @param password 解密密码
   * @returns 解密后的数据
   */
  static decrypt(encryptedData: string, password?: string): string {
    const encryptionPassword = password || this.getEncryptionPassword();

    try {
      // 解析组合数据
      const combined = Buffer.from(encryptedData, 'base64');

      // 提取组件
      const salt = combined.subarray(0, this.SALT_LENGTH);
      const iv = combined.subarray(this.SALT_LENGTH, this.SALT_LENGTH + this.IV_LENGTH);
      const authTag = combined.subarray(
        this.SALT_LENGTH + this.IV_LENGTH,
        this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH
      );
      const encrypted = combined.subarray(
        this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH
      );

      // 派生密钥
      const key = scryptSync(encryptionPassword, salt, this.KEY_LENGTH, {
        N: this.SCRYPT_ITERATIONS,
      });

      // 创建解密器
      const decipher = createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      // 解密数据
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error('解密失败：密码错误或数据损坏');
    }
  }

  /**
   * 加密配置对象中的敏感字段
   * @param config 配置对象
   * @returns 加密后的配置对象
   */
  static encryptConfig<T extends Record<string, any>>(config: T): T {
    const encryptedConfig = { ...config };

    for (const key in encryptedConfig) {
      if (
        this.SENSITIVE_FIELDS.some((field) =>
          key.toLowerCase().includes(field.toLowerCase())
        ) &&
        typeof encryptedConfig[key] === 'string'
      ) {
        (encryptedConfig as any)[key] = `enc:${this.encrypt(encryptedConfig[key])}`;
      }
    }

    return encryptedConfig;
  }

  /**
   * 解密配置对象中的敏感字段
   * @param config 配置对象
   * @returns 解密后的配置对象
   */
  static decryptConfig<T extends Record<string, any>>(config: T): T {
    const decryptedConfig = { ...config };

    for (const key in decryptedConfig) {
      const value = decryptedConfig[key];
      if (typeof value === 'string' && value.startsWith('enc:')) {
        try {
          const encrypted = value.substring(4);
          (decryptedConfig as any)[key] = this.decrypt(encrypted);
        } catch {
          // 解密失败，保持原值
          console.warn(`解密字段 ${key} 失败，可能密码已更改`);
        }
      }
    }

    return decryptedConfig;
  }

  /**
   * 获取加密密码
   * 优先级：环境变量 > 系统密钥链 > 设备特定密钥
   */
  static getEncryptionPassword(): string {
    // 1. 尝试从环境变量获取
    if (process.env.BLADE_CONFIG_PASSWORD) {
      return process.env.BLADE_CONFIG_PASSWORD;
    }

    // 2. 尝试从系统密钥环获取（macOS Keychain / Linux Keyring）
    try {
      const keytar = require('keytar');
      const password = keytar.getPassword('blade-ai', 'config-encryption');
      if (password) {
        return password;
      }
    } catch {
      // keytar 不可用，继续下一步
    }

    // 3. 使用设备特定密钥（基于机器信息）
    const os = require('os');
    const machineId = os.hostname() + os.platform() + os.arch();
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(machineId).digest('hex');

    return `blade-${hash.substring(0, 32)}`;
  }

  /**
   * 设置加密密码
   * @param password 新密码
   */
  static async setEncryptionPassword(password: string): Promise<void> {
    try {
      const keytar = require('keytar');
      await keytar.setPassword('blade-ai', 'config-encryption', password);
    } catch (error) {
      console.warn('无法存储密码到系统密钥环:', error);
    }
  }

  /**
   * 安全地保存配置到文件
   * @param config 配置对象
   * @param filePath 文件路径
   */
  static saveSecureConfig(config: Record<string, any>, filePath: string): void {
    // 确保目录存在
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 }); // 仅用户可访问
    }

    // 加密敏感字段
    const encryptedConfig = this.encryptConfig(config);

    // 写入文件
    writeFileSync(filePath, JSON.stringify(encryptedConfig, null, 2), {
      mode: 0o600, // 仅用户可读写
    });
  }

  /**
   * 从文件安全地加载配置
   * @param filePath 文件路径
   * @returns 解密后的配置对象
   */
  static loadSecureConfig(filePath: string): Record<string, any> {
    if (!existsSync(filePath)) {
      return {};
    }

    try {
      // 读取文件
      const content = readFileSync(filePath, 'utf8');
      const config = JSON.parse(content);

      // 解密敏感字段
      return this.decryptConfig(config);
    } catch (error) {
      throw new Error(
        `加载配置失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 创建安全的配置备份
   * @param sourcePath 源文件路径
   * @param backupPath 备份文件路径
   */
  static backupConfig(sourcePath: string, backupPath?: string): string {
    if (!existsSync(sourcePath)) {
      throw new Error('源配置文件不存在');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultBackupPath = `${sourcePath}.backup.${timestamp}`;
    const actualBackupPath = backupPath || defaultBackupPath;

    // 读取并重新加密备份（避免密码泄露）
    const config = this.loadSecureConfig(sourcePath);
    this.saveSecureConfig(config, actualBackupPath);

    return actualBackupPath;
  }

  /**
   * 旋转加密密钥
   * @param oldPassword 旧密码
   * @param newPassword 新密码
   * @param configPath 配置文件路径
   */
  static rotateEncryptionKey(
    oldPassword: string,
    newPassword: string,
    configPath: string
  ): void {
    // 1. 使用旧密码解密
    const tempPassword = this.getEncryptionPassword();
    this.setEncryptionPassword(oldPassword);

    const config = this.loadSecureConfig(configPath);

    // 2. 使用新密码加密
    this.setEncryptionPassword(newPassword);
    this.saveSecureConfig(config, configPath);

    // 3. 恢复原始密码（如果需要）
    this.setEncryptionPassword(tempPassword);
  }
}
