/**
 * 权限模式抽象器
 * 将具体的工具调用签名转换为通配符模式，减少权限规则冗余
 *
 * 设计理念：
 * - Bash: 按命令类型分组（npm/git/安全命令等）
 * - 文件操作: 按扩展名分组
 * - 搜索操作: 按类型或路径模式分组
 * - Web请求: 按域名分组
 */

import * as path from 'path';
import type { ToolInvocationDescriptor } from './PermissionChecker.js';

export class PatternAbstractor {
  /**
   * 根据工具类型和参数，生成模式规则
   * @param descriptor 工具调用描述符
   * @returns 模式规则字符串
   */
  static abstract(descriptor: ToolInvocationDescriptor): string {
    const { toolName, params } = descriptor;

    switch (toolName) {
      case 'Bash':
        return this.abstractBash(params);
      case 'Read':
      case 'Edit':
      case 'Write':
        return this.abstractFileOperation(toolName, params);
      case 'Grep':
        return this.abstractGrep(params);
      case 'Glob':
        return this.abstractGlob(params);
      case 'WebFetch':
        return this.abstractWebFetch(params);
      default:
        return this.abstractGeneric(toolName, params);
    }
  }

  /**
   * Bash 命令抽象策略
   * 策略：
   * 1. 安全命令（cd/ls/pwd）→ Bash(command:*)
   * 2. 包管理器命令 → Bash(command:*npm*)
   * 3. Git 命令 → Bash(command:git <subcommand>*)
   * 4. 开发工具命令 → Bash(command:*)
   * 5. 默认 → Bash(command:<mainCommand>*)
   */
  private static abstractBash(params: Record<string, unknown>): string {
    const command = (params.command as string) || '';

    // 提取主命令（第一个单词）
    const mainCommand = command.trim().split(/\s+/)[0];

    // 安全命令：允许所有
    if (mainCommand === 'cd' || mainCommand === 'ls' || mainCommand === 'pwd') {
      return 'Bash(command:*)';
    }

    // Git 命令：保留子命令
    if (command.startsWith('git ')) {
      const gitSubCommand = command.split(/\s+/)[1];
      if (gitSubCommand) {
        return `Bash(command:git ${gitSubCommand}*)`;
      }
      return 'Bash(command:git*)';
    }

    // 包管理器相关命令
    if (command.includes('npm') || command.includes('pnpm') || command.includes('yarn')) {
      return 'Bash(command:*npm*)';
    }

    // 开发工具命令：宽松处理（独立命令，非 npm 子命令）
    if (
      (command.includes('test') ||
        command.includes('build') ||
        command.includes('lint') ||
        command.includes('typecheck')) &&
      !command.includes('npm')
    ) {
      return 'Bash(command:*)';
    }

    // 默认：保留主命令，参数用通配符
    return `Bash(command:${mainCommand}*)`;
  }

  /**
   * 文件操作抽象策略
   * 策略：
   * 1. 有扩展名 - Tool(file_path:**\/*.ext)
   * 2. 源码目录 - Tool(file_path:**)
   * 3. 默认 - Tool(file_path:dir/*)
   */
  private static abstractFileOperation(
    toolName: string,
    params: Record<string, unknown>
  ): string {
    const filePath = (params.file_path as string) || '';

    if (!filePath) {
      return `${toolName}(file_path:*)`; // 无路径信息，允许所有
    }

    // 提取扩展名
    const ext = path.extname(filePath);

    if (ext) {
      // 有扩展名：匹配所有相同扩展名的文件
      return `${toolName}(file_path:**/*${ext})`;
    }

    // 无扩展名：根据路径特征判断
    if (filePath.includes('/src/') || filePath.includes('/lib/')) {
      return `${toolName}(file_path:**)`; // 源码目录，允许所有
    }

    // 默认：匹配同目录
    const dir = path.dirname(filePath);
    const projectRoot = process.cwd();
    const relativeDir = path.relative(projectRoot, dir);
    return `${toolName}(file_path:${relativeDir}/*)`;
  }

  /**
   * Grep 搜索抽象策略
   * 策略：
   * 1. 有类型限制 - Grep(pattern:*, type:TYPE)
   * 2. 有 glob 限制 - Grep(pattern:*, glob:GLOB)
   * 3. 有路径限制 - Grep(pattern:*, path:**\/*.ext)
   * 4. 默认 - Grep(pattern:*)
   */
  private static abstractGrep(params: Record<string, unknown>): string {
    const pathParam = params.path as string | undefined;
    const globParam = params.glob as string | undefined;
    const typeParam = params.type as string | undefined;

    // 如果有类型限制（如 js, ts），保留类型
    if (typeParam) {
      return `Grep(pattern:*, type:${typeParam})`;
    }

    // 如果有 glob 限制，保留 glob
    if (globParam) {
      return `Grep(pattern:*, glob:${globParam})`;
    }

    // 如果有路径限制，保留路径模式
    if (pathParam) {
      const ext = path.extname(pathParam);
      if (ext) {
        return `Grep(pattern:*, path:**/*${ext})`;
      }
    }

    // 默认：允许所有 Grep
    return 'Grep(pattern:*)';
  }

  /**
   * Glob 搜索抽象策略
   * 策略：
   * 1. 有扩展名模式 - Glob(pattern:**\/*.ext)
   * 2. 保留原始模式
   */
  private static abstractGlob(params: Record<string, unknown>): string {
    const pattern = params.pattern as string | undefined;

    if (!pattern) {
      return 'Glob(pattern:*)';
    }

    // 提取扩展名模式
    const extMatch = pattern.match(/\*\.([a-z]+)$/i);
    if (extMatch) {
      return `Glob(pattern:**/*.${extMatch[1]})`;
    }

    // 保留模式的主要部分
    return `Glob(pattern:${pattern})`;
  }

  /**
   * WebFetch 抽象策略
   * 策略：按域名分组
   */
  private static abstractWebFetch(params: Record<string, unknown>): string {
    const url = (params.url as string) || '';

    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;

      // 按域名分组
      return `WebFetch(domain:${domain})`;
    } catch {
      // 无法解析 URL，使用通配符
      return 'WebFetch(url:*)';
    }
  }

  /**
   * 通用工具抽象
   * 策略：保留参数名，值用通配符
   */
  private static abstractGeneric(
    toolName: string,
    params: Record<string, unknown>
  ): string {
    // 对于其他工具，保留主要参数类型，值用通配符
    const hasParams = Object.keys(params).length > 0;
    if (!hasParams) {
      return toolName;
    }

    const paramPatterns = Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => {
        // 字符串参数替换为通配符
        if (typeof v === 'string') {
          return `${k}:*`;
        }
        // 其他类型保留
        return `${k}:${v}`;
      });

    return `${toolName}(${paramPatterns.join(', ')})`;
  }
}
