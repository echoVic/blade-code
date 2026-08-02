import * as fsSync from 'node:fs';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionEvent } from '../types.js';

const TAIL_SCAN_CHUNK_SIZE = 64 * 1024;

function parseCommittedLine(
  line: string,
  lineNumber: number,
  source: string
): SessionEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as SessionEvent;
  } catch (error) {
    throw new Error(`Invalid session JSONL in ${source} at line ${lineNumber}`, {
      cause: error,
    });
  }
}

/**
 * Parses committed JSONL records while tolerating one unterminated crash tail.
 * A malformed newline-terminated record is durable corruption and fails closed.
 */
export function parseSessionJSONL(
  content: string,
  source = 'session transcript'
): SessionEvent[] {
  const lines = content.split('\n');
  const finalLineIsUnterminated = !content.endsWith('\n');
  const entries: SessionEvent[] = [];

  for (const [index, line] of lines.entries()) {
    try {
      const entry = parseCommittedLine(line, index + 1, source);
      if (entry) entries.push(entry);
    } catch (error) {
      if (finalLineIsUnterminated && index === lines.length - 1) break;
      throw error;
    }
  }

  return entries;
}

/**
 * JSONL 存储类 - 处理 JSONL 格式的读写
 */
export class JSONLStore {
  private static readonly appendQueues = new Map<string, Promise<void>>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * 追加一条 JSONL 记录到文件
   * @param entry JSONL 条目
   */
  async append(entry: SessionEvent): Promise<void> {
    try {
      const line = JSON.stringify(entry) + '\n';
      await this.appendSerialized(line);
    } catch (error) {
      console.error(`[JSONLStore] 追加写入失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 批量追加多条 JSONL 记录
   * @param entries JSONL 条目数组
   */
  async appendBatch(entries: SessionEvent[]): Promise<void> {
    try {
      const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      await this.appendSerialized(lines);
    } catch (error) {
      console.error(`[JSONLStore] 批量追加写入失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 读取所有 JSONL 记录
   * @returns JSONL 条目数组
   */
  async readAll(): Promise<SessionEvent[]> {
    if (!fsSync.existsSync(this.filePath)) return [];
    const content = await fs.readFile(this.filePath, 'utf-8');
    return parseSessionJSONL(content, this.filePath);
  }

  /**
   * 流式读取 JSONL 记录（适合大文件）
   * @param callback 每条记录的回调函数
   */
  async readStream(
    callback: (entry: SessionEvent) => void | Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!fsSync.existsSync(this.filePath)) {
        resolve();
        return;
      }

      const fileStream = createReadStream(this.filePath, 'utf-8');
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        try {
          const entry = JSON.parse(trimmed) as SessionEvent;
          await callback(entry);
        } catch (error) {
          console.warn(`[JSONLStore] 解析 JSON 行失败: ${trimmed}`, error);
        }
      });

      rl.on('close', () => resolve());
      rl.on('error', reject);
      fileStream.on('error', reject);
    });
  }

  /**
   * 按条件过滤读取 JSONL 记录
   * @param predicate 过滤条件
   * @returns 符合条件的 JSONL 条目数组
   */
  async filter(predicate: (entry: SessionEvent) => boolean): Promise<SessionEvent[]> {
    const results: SessionEvent[] = [];
    await this.readStream((entry) => {
      if (predicate(entry)) {
        results.push(entry);
      }
    });
    return results;
  }

  /**
   * 获取最后 N 条记录
   * @param count 记录数量
   * @returns JSONL 条目数组
   */
  async readLast(count: number): Promise<SessionEvent[]> {
    const all = await this.readAll();
    return all.slice(-count);
  }

  /**
   * 获取文件统计信息
   * @returns 统计信息
   */
  async getStats(): Promise<{
    exists: boolean;
    size: number; // 字节
    lineCount: number;
  }> {
    try {
      if (!fsSync.existsSync(this.filePath)) {
        return { exists: false, size: 0, lineCount: 0 };
      }

      const stats = await fs.stat(this.filePath);
      const content = await fs.readFile(this.filePath, 'utf-8');
      const lineCount = content
        .split('\n')
        .filter((line) => line.trim().length > 0).length;

      return {
        exists: true,
        size: stats.size,
        lineCount,
      };
    } catch (error) {
      console.error(`[JSONLStore] 获取统计信息失败: ${this.filePath}`, error);
      return { exists: false, size: 0, lineCount: 0 };
    }
  }

  /**
   * 检查文件是否存在
   * @returns 文件是否存在
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除 JSONL 文件
   */
  async delete(): Promise<void> {
    try {
      if (await this.exists()) {
        await fs.unlink(this.filePath);
      }
    } catch (error) {
      console.error(`[JSONLStore] 删除文件失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 获取文件路径
   */
  getFilePath(): string {
    return this.filePath;
  }

  private async appendSerialized(content: string): Promise<void> {
    const previous = JSONLStore.appendQueues.get(this.filePath) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
        const separator = await this.repairIncompleteTail();
        await fs.appendFile(this.filePath, separator + content, 'utf-8');
      });
    JSONLStore.appendQueues.set(this.filePath, operation);

    try {
      await operation;
    } finally {
      if (JSONLStore.appendQueues.get(this.filePath) === operation) {
        JSONLStore.appendQueues.delete(this.filePath);
      }
    }
  }

  private async repairIncompleteTail(): Promise<string> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, 'r+');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return '';
      }
      throw error;
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) return '';

      const lastByte = Buffer.allocUnsafe(1);
      await handle.read(lastByte, 0, 1, size - 1);
      if (lastByte[0] === 0x0a) return '';

      const tailStart = await this.findTailStart(handle, size);
      const tail = Buffer.allocUnsafe(size - tailStart);
      await handle.read(tail, 0, tail.length, tailStart);

      try {
        JSON.parse(tail.toString('utf8').trim());
        return '\n';
      } catch {
        await handle.truncate(tailStart);
        return '';
      }
    } finally {
      await handle.close();
    }
  }

  private async findTailStart(handle: fs.FileHandle, size: number): Promise<number> {
    let cursor = size;
    while (cursor > 0) {
      const start = Math.max(0, cursor - TAIL_SCAN_CHUNK_SIZE);
      const chunk = Buffer.allocUnsafe(cursor - start);
      await handle.read(chunk, 0, chunk.length, start);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      cursor = start;
    }
    return 0;
  }
}
