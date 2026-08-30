/**
 * ACP 文件系统服务适配器
 *
 * 将文件操作转发给 IDE（ACP Client）执行。
 * 当 IDE 声明支持 fs 能力时，可以使用此服务替代本地文件操作。
 */

import type {
  AgentSideConnection,
  FileSystemCapabilities,
  RequestError,
} from '@agentclientprotocol/sdk';
import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type FileStat,
  type FileSystemService,
} from '../services/FileSystemService.js';

const logger = createLogger(LogCategory.AGENT);

export class AcpFileSystemCapabilityError extends Error {
  readonly name = 'AcpFileSystemCapabilityError';

  constructor(readonly operation: string) {
    super(`ACP remote filesystem does not support ${operation}`);
  }
}

export function isAcpResourceNotFoundError(error: unknown): boolean {
  if (isRequestErrorWithCode(error, -32002)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return [
    'not found',
    'no such file',
    'enoent',
    'does not exist',
    'file not found',
    'path not found',
  ].some((pattern) => message.includes(pattern));
}

export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: FileSystemCapabilities
  ) {}

  /**
   * 读取文本文件
   *
   * 如果 IDE 不支持 readTextFile，则 fail-closed。
   */
  async readTextFile(filePath: string): Promise<string> {
    if (!this.capabilities.readTextFile) {
      throw new AcpFileSystemCapabilityError('readTextFile');
    }

    try {
      logger.debug(`[AcpFileSystem] readTextFile via ACP: ${filePath}`);
      const response = await this.connection.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
      });
      return response.content;
    } catch (error) {
      logger.warn(`[AcpFileSystem] readTextFile ACP failed: ${error}`);
      throw error;
    }
  }

  /**
   * 写入文本文件
   *
   * 如果 IDE 不支持 writeTextFile，则 fail-closed。
   */
  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.capabilities.writeTextFile) {
      throw new AcpFileSystemCapabilityError('writeTextFile');
    }

    try {
      logger.debug(`[AcpFileSystem] writeTextFile via ACP: ${filePath}`);
      await this.connection.writeTextFile({
        path: filePath,
        content,
        sessionId: this.sessionId,
      });
    } catch (error) {
      logger.warn(`[AcpFileSystem] writeTextFile ACP failed: ${error}`);
      throw error;
    }
  }

  /**
   * 检查文件是否存在
   *
   * 只通过 ACP 远端 read 判断文件存在性；缺少 read 能力时 fail-closed。
   */
  async exists(filePath: string): Promise<boolean> {
    if (!this.capabilities.readTextFile) {
      throw new AcpFileSystemCapabilityError('readTextFile');
    }

    try {
      await this.connection.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
      });
      logger.debug(`[AcpFileSystem] exists(${filePath}): true (ACP read success)`);
      return true;
    } catch (error) {
      if (isAcpResourceNotFoundError(error)) {
        logger.debug(`[AcpFileSystem] exists(${filePath}): false (ACP: not found)`);
        return false;
      }
      throw error;
    }
  }

  /**
   * 读取二进制文件
   *
   * ACP 协议目前只支持文本文件读取，二进制文件 fail-closed。
   */
  async readBinaryFile(filePath: string): Promise<Buffer> {
    logger.debug(`[AcpFileSystem] readBinaryFile unsupported: ${filePath}`);
    throw new AcpFileSystemCapabilityError('readBinaryFile');
  }

  /**
   * 获取文件统计信息
   *
   * ACP 协议暂不支持 stat 操作，fail-closed。
   */
  async stat(filePath: string): Promise<FileStat | null> {
    logger.debug(`[AcpFileSystem] stat unsupported: ${filePath}`);
    throw new AcpFileSystemCapabilityError('stat');
  }

  /**
   * 创建目录
   *
   * ACP 协议暂不支持 mkdir 操作，fail-closed。
   */
  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean; mode?: number }
  ): Promise<void> {
    void options;
    logger.debug(`[AcpFileSystem] mkdir unsupported: ${dirPath}`);
    throw new AcpFileSystemCapabilityError('mkdir');
  }

  /**
   * 获取 IDE 支持的文件系统能力
   */
  getCapabilities(): FileSystemCapabilities {
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

  usesRemoteFiles(): boolean {
    return this.canReadTextFile() || this.canWriteTextFile();
  }
}

function isRequestErrorWithCode(
  error: unknown,
  code: number
): error is RequestError & { code: number } {
  return error instanceof Error && 'code' in error && error.code === code;
}
