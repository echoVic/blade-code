/**
 * ACP 文件系统服务适配器
 *
 * 将文件操作转发给 IDE（ACP Client）执行。
 * 当 IDE 声明支持 fs 能力时，可以使用此服务替代本地文件操作。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AgentSideConnection,
  FileSystemCapabilities,
  RequestError,
} from '@agentclientprotocol/sdk';
import * as acp from '@agentclientprotocol/sdk';
import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type FileStat,
  type FileSystemService,
} from '../services/FileSystemService.js';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  type AcpRemoteFileRequestPurpose,
  type AcpRemoteUserReadPermit,
  createAcpRemoteConnectionPathIdentity,
  getAcpFileRequestCoordinator,
} from './AcpFileRequestCoordinator.js';

const logger = createLogger(LogCategory.AGENT);
const MAX_REMOTE_ACCESS_RECORDS = 1024;

export type RemoteFileOperation = 'read' | 'edit' | 'write';

export interface RemoteFileAccessRecord {
  filePath: string;
  accessTime: number;
  contentSha256: string;
  sessionId: string;
  lastOperation: RemoteFileOperation;
  source: 'remote';
}

export type RemoteAccessStatus = 'missing' | 'current' | 'modified';

export function normalizeAcpRemotePath(filePath: string): string {
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    throw new Error(
      'ACP remote file path must be absolute; UNC paths are not supported'
    );
  }

  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    const normalized = path.win32.normalize(filePath);
    return `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  }

  if (filePath.startsWith('/')) {
    return path.posix.normalize(filePath);
  }

  throw new Error('ACP remote file path must be absolute');
}

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
  private readonly capabilities: FileSystemCapabilities;
  private readonly remoteAccessLedger = new Map<string, RemoteFileAccessRecord>();
  private readonly disposeController = new AbortController();

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    capabilities: FileSystemCapabilities
  ) {
    this.capabilities = {
      readTextFile: capabilities.readTextFile === true,
      writeTextFile: capabilities.writeTextFile === true,
    };
  }

  /**
   * 读取文本文件
   *
   * 如果 IDE 不支持 readTextFile，则 fail-closed。
   */
  async readTextFile(filePath: string): Promise<string> {
    return this.runBoundedTextRead(filePath, {
      purpose: 'preflight',
    });
  }

  async readTextFileForUser(
    filePath: string,
    options?: {
      signal?: AbortSignal;
      deadlineAt?: number;
    }
  ): Promise<string> {
    const normalizedPath = normalizeAcpRemotePath(filePath);
    const coordinator = getAcpFileRequestCoordinator(this.connection);
    const permit = coordinator.beginUserRead(normalizedPath, this.sessionId);

    try {
      const content = await this.runBoundedTextRead(normalizedPath, {
        signal: options?.signal,
        deadlineAt: options?.deadlineAt,
        purpose: 'user-read',
        userReadPermit: permit,
      });
      permit.complete('content', () => {
        this.recordRemoteAccess(normalizedPath, content, 'read');
      });
      return content;
    } catch (error) {
      if (isAcpResourceNotFoundError(error)) {
        permit.complete('not-found', () => {
          this.deleteRemoteAccessRecord(normalizedPath);
        });
        throw error;
      }
      permit.fail();
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
      logger.warn('[AcpFileSystem] writeTextFile ACP request failed');
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
      await this.runBoundedTextRead(filePath, {
        purpose: 'preflight',
      });
      return true;
    } catch (error) {
      if (isAcpResourceNotFoundError(error)) {
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
    _options?: { recursive?: boolean; mode?: number }
  ): Promise<void> {
    logger.debug(`[AcpFileSystem] mkdir unsupported: ${dirPath}`);
    throw new AcpFileSystemCapabilityError('mkdir');
  }

  /**
   * 获取 IDE 支持的文件系统能力
   */
  getCapabilities(): FileSystemCapabilities {
    return { ...this.capabilities };
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

  assertTextMutationCapabilities(): void {
    if (!this.canReadTextFile()) {
      throw new AcpFileSystemCapabilityError('readTextFile');
    }
    if (!this.canWriteTextFile()) {
      throw new AcpFileSystemCapabilityError('writeTextFile');
    }
  }

  usesRemoteFiles(): boolean {
    return this.canReadTextFile() || this.canWriteTextFile();
  }

  createOpaqueLockKey(filePath: string): string {
    const normalizedPath = normalizeAcpRemotePath(filePath);
    return `acp-remote:${createHash('sha256')
      .update(this.sessionId)
      .update('\0')
      .update(normalizedPath)
      .digest('hex')}`;
  }

  async readTextFileIfExists(
    filePath: string
  ): Promise<{ exists: false } | { exists: true; content: string }> {
    try {
      const content = await this.runBoundedTextRead(filePath, {
        purpose: 'preflight',
      });
      return { exists: true, content };
    } catch (error) {
      if (isAcpResourceNotFoundError(error)) {
        return { exists: false };
      }
      throw error;
    }
  }

  recordRemoteAccess(
    filePath: string,
    content: string,
    operation: RemoteFileOperation
  ): void {
    const normalizedPath = normalizeAcpRemotePath(filePath);
    const record: RemoteFileAccessRecord = {
      filePath: normalizedPath,
      accessTime: Date.now(),
      contentSha256: sha256(content),
      sessionId: this.sessionId,
      lastOperation: operation,
      source: 'remote',
    };

    this.remoteAccessLedger.delete(normalizedPath);
    this.remoteAccessLedger.set(normalizedPath, record);

    while (this.remoteAccessLedger.size > MAX_REMOTE_ACCESS_RECORDS) {
      const oldestKey = this.remoteAccessLedger.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.remoteAccessLedger.delete(oldestKey);
    }
  }

  checkRemoteAccess(filePath: string, content: string): RemoteAccessStatus {
    const normalizedPath = normalizeAcpRemotePath(filePath);
    const existing = this.remoteAccessLedger.get(normalizedPath);
    if (!existing) {
      return 'missing';
    }

    this.remoteAccessLedger.delete(normalizedPath);
    this.remoteAccessLedger.set(normalizedPath, existing);

    return existing.contentSha256 === sha256(content) ? 'current' : 'modified';
  }

  getRemoteAccessRecord(filePath: string): RemoteFileAccessRecord | undefined {
    const normalizedPath = normalizeAcpRemotePath(filePath);
    const record = this.remoteAccessLedger.get(normalizedPath);
    if (!record) {
      return undefined;
    }

    return { ...record };
  }

  dispose(): void {
    this.disposeController.abort();
    this.remoteAccessLedger.clear();
  }

  private async runBoundedTextRead(
    filePath: string,
    options: {
      signal?: AbortSignal;
      deadlineAt?: number;
      purpose: AcpRemoteFileRequestPurpose;
      userReadPermit?: AcpRemoteUserReadPermit;
    }
  ): Promise<string> {
    if (!this.capabilities.readTextFile) {
      throw new AcpFileSystemCapabilityError('readTextFile');
    }

    const normalizedPath = normalizeAcpRemotePath(filePath);
    const combinedSignal = createCombinedAbortSignal(
      this.disposeController.signal,
      options.signal
    );
    const coordinator = getAcpFileRequestCoordinator(this.connection);
    const deadlineAt =
      options.deadlineAt ?? Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS;

    try {
      const response = await coordinator.runRequest({
        operation: 'read',
        purpose: options.purpose,
        sessionId: this.sessionId,
        pathIdentity: createAcpRemoteConnectionPathIdentity(normalizedPath),
        deadlineAt,
        signal: combinedSignal.signal,
        userReadPermit: options.userReadPermit,
        dispatch: (cancellationSignal) =>
          this.connection.request(
            acp.CLIENT_METHODS.fs_read_text_file,
            {
              path: normalizedPath,
              sessionId: this.sessionId,
            },
            {
              cancellationSignal,
            }
          ),
      });
      return response.content;
    } catch (error) {
      logger.warn('[AcpFileSystem] readTextFile ACP request failed');
      throw error;
    } finally {
      combinedSignal.cleanup();
    }
  }

  private deleteRemoteAccessRecord(filePath: string): void {
    this.remoteAccessLedger.delete(normalizeAcpRemotePath(filePath));
  }
}

function isRequestErrorWithCode(
  error: unknown,
  code: number
): error is RequestError & { code: number } {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createCombinedAbortSignal(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (activeSignals.length === 0) {
    return {
      signal: new AbortController().signal,
      cleanup: noop,
    };
  }
  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      cleanup: noop,
    };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      return {
        signal: controller.signal,
        cleanup: noop,
      };
    }
    const listener = () => {
      abortFrom(signal);
    };
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

function noop(): void {
  /* intentionally empty */
}
