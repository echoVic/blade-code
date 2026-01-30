/**
 * 敏感文件检测器
 * 识别和保护敏感文件（密钥、凭证、配置等）
 */

import os from 'node:os';
import path from 'node:path';

/**
 * 敏感度级别
 */
export enum SensitivityLevel {
  /** 高度敏感：私钥、密码、凭证 */
  HIGH = 'high',
  /** 中度敏感：环境变量、配置 */
  MEDIUM = 'medium',
  /** 低度敏感：日志、缓存 */
  LOW = 'low',
}

/**
 * 敏感文件检测结果
 */
export interface SensitiveFileCheckResult {
  /** 是否是敏感文件 */
  isSensitive: boolean;
  /** 敏感度级别 */
  level?: SensitivityLevel;
  /** 匹配的模式 */
  matchedPattern?: string;
  /** 原因描述 */
  reason?: string;
}

/**
 * 敏感文件模式配置
 */
interface SensitivePattern {
  /** 文件名模式（支持通配符） */
  pattern: string | RegExp;
  /** 敏感度级别 */
  level: SensitivityLevel;
  /** 描述 */
  description: string;
}

/**
 * 敏感文件检测器
 */
export class SensitiveFileDetector {
  /** 敏感文件模式列表 */
  private static readonly SENSITIVE_PATTERNS: SensitivePattern[] = [
    // ===== HIGH: 私钥和密码 =====
    {
      pattern: /^\.?id_rsa$/i,
      level: SensitivityLevel.HIGH,
      description: 'SSH 私钥',
    },
    {
      pattern: /^\.?id_ed25519$/i,
      level: SensitivityLevel.HIGH,
      description: 'SSH Ed25519 私钥',
    },
    {
      pattern: /^\.?id_ecdsa$/i,
      level: SensitivityLevel.HIGH,
      description: 'SSH ECDSA 私钥',
    },
    {
      pattern: /\.pem$/i,
      level: SensitivityLevel.HIGH,
      description: 'PEM 格式私钥',
    },
    {
      pattern: /\.key$/i,
      level: SensitivityLevel.HIGH,
      description: '密钥文件',
    },
    {
      pattern: /\.p12$/i,
      level: SensitivityLevel.HIGH,
      description: 'PKCS#12 证书',
    },
    {
      pattern: /\.pfx$/i,
      level: SensitivityLevel.HIGH,
      description: 'PFX 证书',
    },
    {
      pattern: /^\.?keystore$/i,
      level: SensitivityLevel.HIGH,
      description: 'Java Keystore',
    },
    {
      pattern: /^\.?pgpass$/i,
      level: SensitivityLevel.HIGH,
      description: 'PostgreSQL 密码文件',
    },
    {
      pattern: /^\.?my\.cnf$/i,
      level: SensitivityLevel.HIGH,
      description: 'MySQL 配置文件（可能含密码）',
    },

    // ===== HIGH: 云服务凭证 =====
    {
      pattern: /credentials\.json$/i,
      level: SensitivityLevel.HIGH,
      description: 'Google Cloud 凭证',
    },
    {
      pattern: /^\.?aws[\\/]credentials$/i,
      level: SensitivityLevel.HIGH,
      description: 'AWS 凭证',
    },
    {
      pattern: /^\.?gcp[\\/]credentials$/i,
      level: SensitivityLevel.HIGH,
      description: 'GCP 凭证',
    },
    {
      pattern: /^\.?azure[\\/]credentials$/i,
      level: SensitivityLevel.HIGH,
      description: 'Azure 凭证',
    },
    {
      pattern: /^service-account.*\.json$/i,
      level: SensitivityLevel.HIGH,
      description: '服务账号密钥',
    },

    // ===== MEDIUM: 环境变量和配置 =====
    {
      pattern: /^\.env$/i,
      level: SensitivityLevel.MEDIUM,
      description: '环境变量文件',
    },
    {
      pattern: /^\.env\./i,
      level: SensitivityLevel.MEDIUM,
      description: '环境变量文件（带环境后缀）',
    },
    {
      pattern: /^\.?npmrc$/i,
      level: SensitivityLevel.MEDIUM,
      description: 'npm 配置文件（可能含 token）',
    },
    {
      pattern: /^\.?pypirc$/i,
      level: SensitivityLevel.MEDIUM,
      description: 'PyPI 配置文件（可能含密码）',
    },
    {
      pattern: /^\.?dockercfg$/i,
      level: SensitivityLevel.MEDIUM,
      description: 'Docker 配置文件',
    },
    {
      pattern: /^\.?docker[\\/]config\.json$/i,
      level: SensitivityLevel.MEDIUM,
      description: 'Docker 配置文件',
    },
    {
      pattern: /^\.?netrc$/i,
      level: SensitivityLevel.MEDIUM,
      description: 'FTP/HTTP 认证文件',
    },
    {
      pattern: /^\.?git-credentials$/i,
      level: SensitivityLevel.MEDIUM,
      description: 'Git 凭证文件',
    },
    {
      pattern: /^config\.toml$/i,
      level: SensitivityLevel.MEDIUM,
      description: '配置文件（可能含敏感信息）',
    },
    {
      pattern: /^secrets\./i,
      level: SensitivityLevel.MEDIUM,
      description: '密钥配置文件',
    },

    // ===== LOW: 数据库和敏感数据 =====
    {
      pattern: /\.sqlite$/i,
      level: SensitivityLevel.LOW,
      description: 'SQLite 数据库',
    },
    {
      pattern: /\.db$/i,
      level: SensitivityLevel.LOW,
      description: '数据库文件',
    },
    {
      pattern: /\.sql$/i,
      level: SensitivityLevel.LOW,
      description: 'SQL 文件（可能含敏感数据）',
    },
  ];

  /** 敏感路径列表 */
  private static readonly SENSITIVE_PATHS: Array<{
    path: string | RegExp;
    level: SensitivityLevel;
    description: string;
  }> = [
    // SSH 目录
    {
      path: /\.ssh[\\/]/i,
      level: SensitivityLevel.HIGH,
      description: 'SSH 配置目录',
    },
    // AWS 配置
    {
      path: /\.aws[\\/]/i,
      level: SensitivityLevel.HIGH,
      description: 'AWS 配置目录',
    },
    // GCP 配置
    {
      path: /\.config[\\/]gcloud[\\/]/i,
      level: SensitivityLevel.HIGH,
      description: 'Google Cloud 配置目录',
    },
    // Kubernetes 配置
    {
      path: /\.kube[\\/]/i,
      level: SensitivityLevel.HIGH,
      description: 'Kubernetes 配置目录',
    },
  ];

  /**
   * 检查文件是否敏感
   */
  static check(filePath: string): SensitiveFileCheckResult {
    const normalizedPath = this.normalizePath(filePath);
    const fileName = path.basename(normalizedPath);

    // 1. 检查文件名模式
    for (const pattern of this.SENSITIVE_PATTERNS) {
      if (this.matchPattern(fileName, pattern.pattern)) {
        return {
          isSensitive: true,
          level: pattern.level,
          matchedPattern:
            pattern.pattern instanceof RegExp
              ? pattern.pattern.source
              : pattern.pattern,
          reason: pattern.description,
        };
      }
    }

    // 2. 检查路径模式
    for (const pathPattern of this.SENSITIVE_PATHS) {
      if (this.matchPattern(normalizedPath, pathPattern.path)) {
        return {
          isSensitive: true,
          level: pathPattern.level,
          matchedPattern:
            pathPattern.path instanceof RegExp
              ? pathPattern.path.source
              : pathPattern.path,
          reason: pathPattern.description,
        };
      }
    }

    // 3. 不敏感
    return {
      isSensitive: false,
    };
  }

  /**
   * 批量检查文件列表
   */
  static checkMultiple(filePaths: string[]): Map<string, SensitiveFileCheckResult> {
    const results = new Map<string, SensitiveFileCheckResult>();

    for (const filePath of filePaths) {
      results.set(filePath, this.check(filePath));
    }

    return results;
  }

  /**
   * 获取敏感文件列表
   */
  static filterSensitive(
    filePaths: string[],
    minLevel: SensitivityLevel = SensitivityLevel.LOW
  ): Array<{ path: string; result: SensitiveFileCheckResult }> {
    const levelOrder = {
      [SensitivityLevel.HIGH]: 3,
      [SensitivityLevel.MEDIUM]: 2,
      [SensitivityLevel.LOW]: 1,
    };

    const minLevelValue = levelOrder[minLevel];

    return filePaths
      .map((filePath) => ({
        path: filePath,
        result: this.check(filePath),
      }))
      .filter(
        ({ result }) =>
          result.isSensitive &&
          result.level &&
          levelOrder[result.level] >= minLevelValue
      );
  }

  /**
   * 规范化路径（处理 ~ 和相对路径）
   */
  private static normalizePath(filePath: string): string {
    // 展开 ~ 为用户主目录
    if (filePath.startsWith('~/') || filePath === '~') {
      return path.join(os.homedir(), filePath.slice(1));
    }

    // 转换为绝对路径
    return path.resolve(filePath);
  }

  /**
   * 匹配模式（支持字符串和正则）
   */
  private static matchPattern(text: string, pattern: string | RegExp): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }

    // 简单通配符匹配（* 匹配任意字符）
    const regexPattern = pattern.replace(/\*/g, '.*');
    return new RegExp(`^${regexPattern}$`, 'i').test(text);
  }

  /**
   * 获取所有敏感文件模式（用于文档/调试）
   */
  static getSensitivePatterns(): SensitivePattern[] {
    return [...this.SENSITIVE_PATTERNS];
  }

  /**
   * 获取所有敏感路径模式（用于文档/调试）
   */
  static getSensitivePaths(): typeof SensitiveFileDetector.SENSITIVE_PATHS {
    return [...this.SENSITIVE_PATHS];
  }
}
