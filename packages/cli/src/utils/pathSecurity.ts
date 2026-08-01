/**
 * 路径安全检查工具
 *
 * 提供路径归一化、边界检查、受限路径检测等安全功能
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 受限路径列表（禁止访问的目录）
 */
const RESTRICTED_PATHS = [
  '.git',
  '.claude',
  'node_modules',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
];

/**
 * 路径安全检查错误
 */
export class PathSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * 路径安全检查工具
 */
export class PathSecurity {
  /**
   * 归一化路径（转为绝对路径）
   *
   * @param inputPath - 输入路径（相对或绝对）
   * @param workspaceRoot - 工作区根目录
   * @returns 归一化后的绝对路径
   * @throws {PathSecurityError} 如果路径在工作区外
   *
   * @example
   * ```typescript
   * PathSecurity.normalize('src/agent.ts', '/workspace')
   * // => '/workspace/src/agent.ts'
   *
   * PathSecurity.normalize('/etc/passwd', '/workspace')
   * // => throws PathSecurityError
   * ```
   */
  static normalize(inputPath: string, workspaceRoot: string): string {
    // 转换为绝对路径
    const absolutePath = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(workspaceRoot, inputPath);

    // 归一化（移除 .., . 等）
    const normalized = path.normalize(absolutePath);

    // 确保工作区根目录也是归一化的
    const normalizedRoot = path.normalize(workspaceRoot);

    // 检查是否在工作区内
    if (!this.isWithinWorkspace(normalized, normalizedRoot)) {
      throw new PathSecurityError(
        `Path outside workspace: ${inputPath} (resolved to ${normalized}, workspace: ${normalizedRoot})`,
        'PATH_OUTSIDE_WORKSPACE'
      );
    }

    return normalized;
  }

  /**
   * 检查受限路径
   *
   * @param absolutePath - 绝对路径
   * @throws {PathSecurityError} 如果路径包含受限目录
   *
   * @example
   * ```typescript
   * PathSecurity.checkRestricted('/workspace/.git/config')
   * // => throws PathSecurityError
   * ```
   */
  static checkRestricted(absolutePath: string): void {
    const segments = absolutePath.split(path.sep);

    for (const restricted of RESTRICTED_PATHS) {
      if (segments.includes(restricted)) {
        throw new PathSecurityError(
          `Access denied: "${restricted}" is a protected directory`,
          'RESTRICTED_PATH'
        );
      }
    }
  }

  /**
   * 检查路径遍历攻击
   *
   * @param inputPath - 输入路径
   * @throws {PathSecurityError} 如果路径包含 ..
   *
   * @example
   * ```typescript
   * PathSecurity.checkTraversal('../../etc/passwd')
   * // => throws PathSecurityError
   * ```
   */
  static checkTraversal(inputPath: string): void {
    if (inputPath.includes('..')) {
      throw new PathSecurityError(
        `Path traversal not allowed: ${inputPath}`,
        'PATH_TRAVERSAL'
      );
    }
  }

  /**
   * 完整的路径安全验证
   *
   * @param inputPath - 输入路径（相对或绝对）
   * @param workspaceRoot - 工作区根目录
   * @returns 验证通过的绝对路径
   * @throws {PathSecurityError} 如果任何安全检查失败
   *
   * @example
   * ```typescript
   * const safePath = await PathSecurity.validatePath('src/agent.ts', '/workspace');
   * // => '/workspace/src/agent.ts'
   * ```
   */
  static async validatePath(inputPath: string, workspaceRoot: string): Promise<string> {
    // 1. 路径遍历检查
    this.checkTraversal(inputPath);

    // 2. 归一化并检查边界
    const absolutePath = this.normalize(inputPath, workspaceRoot);

    // 3. 受限路径检查
    this.checkRestricted(absolutePath);

    // 4. 检查文件/目录是否存在
    try {
      await fs.access(absolutePath);
    } catch (_error) {
      throw new PathSecurityError(`Path not found: ${inputPath}`, 'PATH_NOT_FOUND');
    }

    return absolutePath;
  }

  /**
   * 检查是否为符号链接，并解析真实路径
   *
   * @param absolutePath - 绝对路径
   * @param workspaceRoot - 工作区根目录
   * @returns 真实路径
   * @throws {PathSecurityError} 如果符号链接指向工作区外
   */
  static async resolveSymlink(
    absolutePath: string,
    workspaceRoot: string
  ): Promise<string> {
    try {
      const realPath = await fs.realpath(absolutePath);
      const realWorkspaceRoot = await fs.realpath(workspaceRoot);

      // 检查真实路径是否在工作区内
      if (!this.isWithinWorkspace(realPath, realWorkspaceRoot)) {
        throw new PathSecurityError(
          `Symlink points outside workspace: ${absolutePath} -> ${realPath}`,
          'SYMLINK_OUTSIDE_WORKSPACE'
        );
      }

      return realPath;
    } catch (error) {
      if (error instanceof PathSecurityError) {
        throw error;
      }
      // 如果不是符号链接，返回原路径
      return absolutePath;
    }
  }

  /**
   * 获取相对路径（用于显示）
   *
   * @param absolutePath - 绝对路径
   * @param workspaceRoot - 工作区根目录
   * @returns 相对路径
   */
  static getRelativePath(absolutePath: string, workspaceRoot: string): string {
    return path.relative(workspaceRoot, absolutePath);
  }

  /**
   * 检查路径是否在工作区内
   *
   * @param absolutePath - 绝对路径
   * @param workspaceRoot - 工作区根目录
   * @returns 是否在工作区内
   */
  static isWithinWorkspace(absolutePath: string, workspaceRoot: string): boolean {
    const normalized = path.resolve(absolutePath);
    const normalizedRoot = path.resolve(workspaceRoot);
    const relativePath = path.relative(normalizedRoot, normalized);
    return (
      relativePath === '' ||
      (relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath))
    );
  }

  /**
   * 检查目标路径及其最近存在祖先的真实路径是否仍在工作区内。
   *
   * 目标文件可以尚未创建，因此逐级向上解析，避免通过工作区内的
   * 符号链接把新文件写到工作区外。
   */
  static async isWithinWorkspaceResolved(
    inputPath: string,
    workspaceRoot: string
  ): Promise<boolean> {
    const normalizedRoot = path.resolve(workspaceRoot);
    const normalizedPath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(normalizedRoot, inputPath);

    if (!this.isWithinWorkspace(normalizedPath, normalizedRoot)) {
      return false;
    }

    let realWorkspaceRoot: string;
    try {
      realWorkspaceRoot = await fs.realpath(normalizedRoot);
    } catch {
      return false;
    }

    let currentPath = normalizedPath;
    while (true) {
      try {
        const realPath = await fs.realpath(currentPath);
        return this.isWithinWorkspace(realPath, realWorkspaceRoot);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          return false;
        }
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return false;
      }
      currentPath = parentPath;
    }
  }

  /**
   * 检查路径是否为受限路径
   *
   * @param absolutePath - 绝对路径
   * @returns 是否为受限路径
   */
  static isRestricted(absolutePath: string): boolean {
    const segments = absolutePath.split(path.sep);
    return RESTRICTED_PATHS.some((restricted) => segments.includes(restricted));
  }
}
