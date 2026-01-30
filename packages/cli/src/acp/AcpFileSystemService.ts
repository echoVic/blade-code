/**
 * ACP 文件系统服务适配器
 *
 * 将文件操作转发给 IDE（ACP Client）执行。
 * 当 IDE 声明支持 fs 能力时，可以使用此服务替代本地文件操作。
 */

import type {
  AgentSideConnection,
  FileSystemCapability,
} from '@agentclientprotocol/sdk';
import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type FileStat,
  type FileSystemService,
  LocalFileSystemService,
} from '../services/FileSystemService.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * ACP 文件系统服务
 *
 * 将文件操作转发给 IDE 执行。
 * 如果 IDE 不支持某个操作，则回退到本地文件系统。
 */
export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: FileSystemCapability,
    private readonly fallback: FileSystemService = new LocalFileSystemService()
  ) {}

  /**
   * 读取文本文件
   *
   * 如果 IDE 支持 readTextFile，则通过 ACP 协议读取；
   * 否则回退到本地文件系统。
   */
  async readTextFile(filePath: string): Promise<string> {
    if (!this.capabilities.readTextFile) {
      logger.debug(`[AcpFileSystem] readTextFile fallback: ${filePath}`);
      return this.fallback.readTextFile(filePath);
    }

    try {
      logger.debug(`[AcpFileSystem] readTextFile via ACP: ${filePath}`);
      const response = await this.connection.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
      });
      return response.content;
    } catch (error) {
      logger.warn(`[AcpFileSystem] readTextFile ACP failed, fallback: ${error}`);
      return this.fallback.readTextFile(filePath);
    }
  }

  /**
   * 写入文本文件
   *
   * 如果 IDE 支持 writeTextFile，则通过 ACP 协议写入；
   * 否则回退到本地文件系统。
   */
  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.capabilities.writeTextFile) {
      logger.debug(`[AcpFileSystem] writeTextFile fallback: ${filePath}`);
      return this.fallback.writeTextFile(filePath, content);
    }

    try {
      logger.debug(`[AcpFileSystem] writeTextFile via ACP: ${filePath}`);
      await this.connection.writeTextFile({
        path: filePath,
        content,
        sessionId: this.sessionId,
      });
    } catch (error) {
      logger.warn(`[AcpFileSystem] writeTextFile ACP failed, fallback: ${error}`);
      return this.fallback.writeTextFile(filePath, content);
    }
  }

  /**
   * 检查文件是否存在
   *
   * 策略：优先信任 ACP，宁可误判"存在"也不要误判"不存在"
   *
   * 1. 如果 IDE 支持 readTextFile，通过 ACP 判断：
   *    - 读取成功 → 存在
   *    - 错误明确是"not found/enoent" → 不存在
   *    - 其他错误（权限、二进制、超时等）→ 假设存在
   *      （让后续操作揭示真正问题，而非提前终止）
   *
   * 2. 如果 IDE 不支持 readTextFile，fallback 到本地
   */
  async exists(filePath: string): Promise<boolean> {
    // 如果 IDE 不支持文件读取，fallback 到本地
    if (!this.capabilities.readTextFile) {
      logger.debug(`[AcpFileSystem] exists fallback to local: ${filePath}`);
      return this.fallback.exists(filePath);
    }

    // 通过 ACP 检查
    try {
      await this.connection.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
      });
      logger.debug(`[AcpFileSystem] exists(${filePath}): true (ACP read success)`);
      return true;
    } catch (error) {
      const errorMsg = String(error).toLowerCase();

      // 只有明确的"不存在"错误才返回 false
      const notFoundPatterns = [
        'not found',
        'no such file',
        'enoent',
        'does not exist',
        'file not found',
        'path not found',
      ];

      const isNotFound = notFoundPatterns.some((pattern) => errorMsg.includes(pattern));

      if (isNotFound) {
        logger.debug(`[AcpFileSystem] exists(${filePath}): false (ACP: not found)`);
        return false;
      }

      // 其他错误（权限、二进制、超时等）假设文件存在
      // 让后续操作揭示真正问题，而非在这里提前终止
      // 使用 warn 级别记录，便于诊断
      const errorType = categorizeError(errorMsg);
      logger.warn(
        `[AcpFileSystem] exists(${filePath}): assuming exists due to ${errorType} error`,
        { error: String(error), errorType, filePath }
      );
      return true;
    }
  }

  /**
   * 读取二进制文件
   *
   * ACP 协议目前只支持文本文件读取，二进制文件回退到本地。
   */
  async readBinaryFile(filePath: string): Promise<Buffer> {
    // ACP 协议暂不支持二进制读取，使用本地
    logger.debug(`[AcpFileSystem] readBinaryFile fallback: ${filePath}`);
    return this.fallback.readBinaryFile(filePath);
  }

  /**
   * 获取文件统计信息
   *
   * ACP 协议暂不支持 stat 操作，回退到本地。
   */
  async stat(filePath: string): Promise<FileStat | null> {
    // ACP 协议暂无 stat 方法，使用本地
    logger.debug(`[AcpFileSystem] stat fallback: ${filePath}`);
    return this.fallback.stat(filePath);
  }

  /**
   * 创建目录
   *
   * ACP 协议暂不支持 mkdir 操作，回退到本地。
   * 注：writeTextFile 通常会自动创建父目录。
   */
  async mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    // ACP 协议暂无 mkdir 方法，使用本地
    logger.debug(`[AcpFileSystem] mkdir fallback: ${dirPath}`);
    return this.fallback.mkdir(dirPath, options);
  }

  /**
   * 获取 IDE 支持的文件系统能力
   */
  getCapabilities(): FileSystemCapability {
    return this.capabilities;
  }

  /**
   * 检查是否支持读取文件
   */
  canReadTextFile(): boolean {
    return this.capabilities.readTextFile ?? false;
  }

  /**
   * 检查是否支持写入文件
   */
  canWriteTextFile(): boolean {
    return this.capabilities.writeTextFile ?? false;
  }
}



/**
 * 对错误信息进行分类，便于诊断
 */
function categorizeError(errorMsg: string): string {
  if (errorMsg.includes('permission') || errorMsg.includes('access denied')) {
    return 'permission';
  }
  if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
    return 'timeout';
  }
  if (errorMsg.includes('binary') || errorMsg.includes('encoding')) {
    return 'binary';
  }
  if (errorMsg.includes('too large') || errorMsg.includes('size')) {
    return 'size';
  }
  if (errorMsg.includes('connection') || errorMsg.includes('network')) {
    return 'network';
  }
  return 'unknown';
}
