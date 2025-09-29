/**
 * 路径安全工具
 * 防止路径遍历攻击
 */

import { accessSync, constants } from 'fs';
import { homedir } from 'os';
import { dirname, join, normalize, relative, resolve } from 'path';

export class PathSecurity {
  private static readonly ALLOWED_SCHEMES = ['file:', ''];
  private static readonly MAX_PATH_LENGTH = 4096; // Linux MAX_PATH
  private static readonly SUSPICIOUS_PATTERNS = [
    /\.\.\//g, // 相对路径
    /\.\.\\/g, // Windows 相对路径
    /^[/\\]/, // 绝对路径
    /~\//, // Home 目录简写
    /\$[A-Z_]/, // 环境变量
  ];

  /**
   * 安全地解析和验证文件路径
   * @param userPath 用户提供的路径
   * @param baseDir 允许的基础目录（可选）
   * @param options 配置选项
   * @returns 解析后的安全路径
   * @throws Error 如果路径不安全
   */
  static async securePath(
    userPath: string,
    baseDir?: string,
    options: {
      allowAbsolute?: boolean;
      checkExistence?: boolean;
      allowedExtensions?: string[];
      maxDepth?: number;
    } = {}
  ): Promise<string> {
    const {
      allowAbsolute = false,
      checkExistence = false,
      allowedExtensions,
      maxDepth = 10,
    } = options;

    // 1. 基本验证
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('路径不能为空');
    }

    if (userPath.length > this.MAX_PATH_LENGTH) {
      throw new Error('路径过长');
    }

    // 2. 检查路径协议
    const hasScheme = /^[a-zA-Z]+:/.test(userPath);
    if (hasScheme) {
      const scheme = userPath.split(':')[0] + ':';
      if (!this.ALLOWED_SCHEMES.includes(scheme)) {
        throw new Error(`不支持的路径协议: ${scheme}`);
      }
      userPath = userPath.substring(scheme.length);
    }

    // 3. 展开 ~ 和环境变量（如果使用了）
    let expandedPath = userPath;
    if (userPath.startsWith('~/')) {
      expandedPath = join(homedir(), userPath.substring(2));
    }

    // 4. 规范化路径
    const normalizedPath = normalize(expandedPath);

    // 5. 检查可疑模式
    for (const pattern of this.SUSPICIOUS_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        throw new Error('检测到潜在的路径遍历攻击');
      }
    }

    // 6. 解析为绝对路径
    const resolvedPath = resolve(baseDir || process.cwd(), normalizedPath);

    // 7. 检查是否在允许的基础目录内
    if (baseDir) {
      const normalizedBase = normalize(baseDir);
      const relativePath = relative(normalizedBase, resolvedPath);

      if (
        relativePath.startsWith('..') ||
        relativePath === '' ||
        this.countPathSegments(relativePath) > maxDepth
      ) {
        throw new Error('路径超出允许的目录范围');
      }
    } else if (!allowAbsolute && !resolvedPath.startsWith(process.cwd())) {
      // 如果不允许绝对路径，确保在当前工作目录内
      const relativePath = relative(process.cwd(), resolvedPath);
      if (relativePath.startsWith('..')) {
        throw new Error('只能在当前工作目录内操作');
      }
    }

    // 8. 检查文件扩展名
    if (allowedExtensions) {
      const ext = resolvedPath.split('.').pop()?.toLowerCase();
      const extWithDot = ext ? `.${ext}` : '';

      if (
        !allowedExtensions.some((allowed) => allowed === extWithDot || allowed === ext)
      ) {
        throw new Error(`不支持的文件类型: ${extWithDot}`);
      }
    }

    // 9. 检查路径是否存在（可选）
    if (checkExistence) {
      try {
        accessSync(resolvedPath, constants.F_OK);
      } catch {
        throw new Error('路径不存在');
      }
    }

    return resolvedPath;
  }

  /**
   * 检查路径是否在安全范围内
   * @param path 要检查的路径
   * @param allowedDirs 允许的目录列表
   */
  static isInAllowedDirs(path: string, allowedDirs: string[]): boolean {
    const resolvedPath = resolve(path);

    return allowedDirs.some((dir) => {
      const resolvedDir = resolve(dir);
      const relativePath = relative(resolvedDir, resolvedPath);
      return !relativePath.startsWith('..');
    });
  }

  /**
   * 获取安全的临时文件路径
   * @param prefix 文件名前缀
   * @param extension 文件扩展名
   */
  static getSafeTempPath(prefix: string = 'blade', extension: string = 'tmp'): string {
    const tempDir = require('os').tmpdir();
    const randomSuffix = Math.random().toString(36).substring(2, 15);
    const filename = `${prefix}-${randomSuffix}.${extension}`;
    return join(tempDir, filename);
  }

  /**
   * 清理路径中的危险字符
   * @param path 要清理的路径
   */
  static sanitizePath(path: string): string {
    return path
      .replace(/[<>:"|?*]/g, '_') // 替换 Windows 非法字符
      .replace(/\s+/g, '_') // 替换空格
      .replace(/^\./, '_') // 避免以点开头
      .replace(/\.$/, '_') // 避免以点结尾
      .substring(0, 255); // 限制长度
  }

  /**
   * 计算路径段数
   */
  private static countPathSegments(path: string): number {
    return path.split(/[\\/]/).filter(Boolean).length;
  }

  /**
   * 获取默认的允许目录列表
   */
  static getDefaultAllowedDirs(): string[] {
    return [
      process.cwd(),
      join(homedir(), '.blade'),
      join(homedir(), '.config', 'blade'),
      require('os').tmpdir(),
    ];
  }
}
// 创建默认实例导出
export const pathSecurity = new PathSecurity();
