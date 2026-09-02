import * as fsSync from 'node:fs';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionEvent } from '../types.js';

const TAIL_SCAN_CHUNK_SIZE = 64 * 1024;

export interface JSONLValidatedAppendOptions {
  noFollow?: boolean;
  validateHandle?: (handle: fs.FileHandle) => Promise<void>;
}

export interface JSONLReadOptions {
  signal?: AbortSignal;
}

export interface JSONLValidatedReadOptions
  extends JSONLValidatedAppendOptions,
    JSONLReadOptions {}

function serializeSessionEvent(entry: SessionEvent): string {
  const data = (entry as { data?: unknown }).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Session event data must be a JSON object');
  }
  return JSON.stringify(entry);
}

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
 *
 * Backfills a monotonic `seq` (1-based, by parse order) for legacy records that
 * predate sequence numbers, so replay and Last-Event-ID resume stay well-defined.
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
      if (entry) {
        if (typeof entry.seq !== 'number') {
          entry.seq = entries.length + 1;
        }
        entries.push(entry);
      }
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
  private static readonly appendQueues = new Map<string, Promise<unknown>>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Highest seq among committed entries, or 0 for an empty transcript. */
  private static maxSeq(entries: readonly SessionEvent[]): number {
    let max = 0;
    for (const entry of entries) {
      if (typeof entry.seq === 'number' && entry.seq > max) max = entry.seq;
    }
    return max;
  }

  /**
   * Stamps a monotonic seq onto entries that lack one, continuing after
   * `baseSeq` (the highest committed seq). Assigning inside the per-file write
   * lock keeps seq consistent with on-disk order across every JSONLStore
   * instance.
   */
  private static stampSeqFrom(
    entries: readonly SessionEvent[],
    baseSeq: number
  ): SessionEvent[] {
    let next = baseSeq;
    return entries.map((entry) => {
      if (typeof entry.seq === 'number') {
        if (entry.seq > next) next = entry.seq;
        return entry;
      }
      next += 1;
      return { ...entry, seq: next } as SessionEvent;
    });
  }

  private static stampSeq(
    entries: readonly SessionEvent[],
    committed: readonly SessionEvent[]
  ): SessionEvent[] {
    return JSONLStore.stampSeqFrom(entries, JSONLStore.maxSeq(committed));
  }

  /**
   * 追加一条 JSONL 记录到文件
   * @param entry JSONL 条目
   * @returns 落盘后的条目（已分配 seq）
   */
  async append(entry: SessionEvent): Promise<SessionEvent> {
    try {
      const [stamped] = await this.appendEntries([entry]);
      return stamped;
    } catch (error) {
      console.error(`[JSONLStore] 追加写入失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 批量追加多条 JSONL 记录
   * @param entries JSONL 条目数组
   * @returns 落盘后的条目数组（已分配 seq）
   */
  async appendBatch(entries: SessionEvent[]): Promise<SessionEvent[]> {
    try {
      return await this.appendEntries(entries);
    } catch (error) {
      console.error(`[JSONLStore] 批量追加写入失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 在 per-file 写锁内分配 seq、序列化并落盘。是所有追加写入分配序列号的唯一入口。
   *
   * seq 基准通过只读文件尾部的最后一条 committed 记录获得（O(tail)），避免每次
   * append 都全量解析整个 transcript（否则单会话累计写入为 O(N²)）。旧 transcript
   * 若尾部缺失 seq，回退一次全量解析（其后新写入即带 seq，恢复 O(tail)）。
   */
  private async appendEntries(entries: SessionEvent[]): Promise<SessionEvent[]> {
    if (entries.length === 0) return [];
    return this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
      const handle = await fs.open(this.filePath, 'a+', 0o600);
      try {
        const separator = await this.repairIncompleteTail(handle);
        const baseSeq = await this.readTailSeq(handle);
        const stamped = JSONLStore.stampSeqFrom(entries, baseSeq);
        const content = `${stamped.map(serializeSessionEvent).join('\n')}\n`;
        await handle.appendFile(separator + content, 'utf8');
        await handle.sync();
        return stamped;
      } finally {
        await handle.close();
      }
    });
  }

  /** Create a complete transcript without replacing an existing session. */
  async createExclusive(entries: SessionEvent[]): Promise<void> {
    if (entries.length === 0) {
      throw new Error('Cannot create an empty session transcript');
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, 'wx', 0o600);
      const stamped = JSONLStore.stampSeq(entries, []);
      const content = `${stamped.map(serializeSessionEvent).join('\n')}\n`;
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close();
        handle = undefined;
        await fs.unlink(this.filePath).catch(() => undefined);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /**
   * 读取所有 JSONL 记录
   * @returns JSONL 条目数组
   */
  async readAll(options: JSONLReadOptions = {}): Promise<SessionEvent[]> {
    options.signal?.throwIfAborted();
    if (!fsSync.existsSync(this.filePath)) return [];
    const content = await fs.readFile(this.filePath, {
      encoding: 'utf-8',
      signal: options.signal,
    });
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

      let lineOrdinal = 0;
      rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        try {
          const entry = JSON.parse(trimmed) as SessionEvent;
          lineOrdinal += 1;
          if (typeof entry.seq !== 'number') {
            entry.seq = lineOrdinal;
          }
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
   * 读取 seq >= fromSeq 的所有记录，用于 Last-Event-ID 断点续传的 JSONL 兜底补发。
   * seq 由 {@link parseSessionJSONL} 统一保证（新事件显式携带，旧事件按行号回填）。
   * @param fromSeq 起始序列号（含）
   */
  async readFromSeq(fromSeq: number): Promise<SessionEvent[]> {
    const all = await this.readAll();
    return all.filter((entry) => (entry.seq ?? 0) >= fromSeq);
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
  async delete(): Promise<boolean> {
    try {
      return await this.enqueue(async () => {
        try {
          await fs.unlink(this.filePath);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
          }
          throw error;
        }
      });
    } catch (error) {
      console.error(`[JSONLStore] 删除文件失败: ${this.filePath}`, error);
      throw error;
    }
  }

  async deleteValidated(
    validator: (entries: readonly SessionEvent[]) => boolean
  ): Promise<boolean> {
    return this.enqueue(async () => {
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(this.filePath, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }

      let entries: SessionEvent[];
      try {
        entries = parseSessionJSONL(
          await handle.readFile('utf8'),
          'session transcript'
        );
      } finally {
        await handle.close();
      }

      if (!validator(entries)) return false;
      try {
        await fs.unlink(this.filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    });
  }

  async appendValidated(
    buildEntry: (entries: readonly SessionEvent[]) => SessionEvent,
    options: JSONLValidatedAppendOptions = {}
  ): Promise<SessionEvent> {
    return this.appendValidatedAsync(async (entries) => buildEntry(entries), options);
  }

  async appendValidatedBatch(
    buildEntries: (entries: readonly SessionEvent[]) => SessionEvent[],
    options: JSONLValidatedAppendOptions = {}
  ): Promise<SessionEvent[]> {
    return this.appendValidatedBatchAsync(
      async (entries) => buildEntries(entries),
      options
    );
  }

  async appendValidatedBatchAsync(
    buildEntries: (entries: readonly SessionEvent[]) => Promise<SessionEvent[]>,
    options: JSONLValidatedAppendOptions = {}
  ): Promise<SessionEvent[]> {
    return this.enqueue(async () => {
      const flags = options.noFollow
        ? fsSync.constants.O_RDWR | (fsSync.constants.O_NOFOLLOW ?? 0)
        : 'r+';
      const handle = await fs.open(this.filePath, flags);
      try {
        await options.validateHandle?.(handle);
        const { entries, separator, size } = await this.readCommittedState(
          handle,
          'session transcript'
        );
        const pending = await buildEntries(entries);
        if (pending.length === 0) return [];
        const stamped = JSONLStore.stampSeq(pending, entries);
        const content = `${stamped.map(serializeSessionEvent).join('\n')}\n`;
        await handle.write(separator + content, size, 'utf8');
        await handle.sync();
        await options.validateHandle?.(handle);
        return stamped;
      } finally {
        await handle.close();
      }
    });
  }

  async appendValidatedAsync(
    buildEntry: (entries: readonly SessionEvent[]) => Promise<SessionEvent>,
    options: JSONLValidatedAppendOptions = {}
  ): Promise<SessionEvent> {
    return this.enqueue(async () => {
      const flags = options.noFollow
        ? fsSync.constants.O_RDWR | (fsSync.constants.O_NOFOLLOW ?? 0)
        : 'r+';
      const handle = await fs.open(this.filePath, flags);
      try {
        await options.validateHandle?.(handle);
        const { entries, separator, size } = await this.readCommittedState(
          handle,
          'session transcript'
        );
        const entry = await buildEntry(entries);
        const [stamped] = JSONLStore.stampSeq([entry], entries);
        const line = `${separator}${serializeSessionEvent(stamped)}\n`;
        await handle.write(line, size, 'utf8');
        await handle.sync();
        await options.validateHandle?.(handle);
        return stamped;
      } finally {
        await handle.close();
      }
    });
  }

  async readAllValidated(
    options: JSONLValidatedReadOptions = {}
  ): Promise<SessionEvent[]> {
    options.signal?.throwIfAborted();
    const flags = options.noFollow
      ? fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0)
      : 'r';
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, flags);
    } catch (error) {
      options.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      await options.validateHandle?.(handle);
      options.signal?.throwIfAborted();
      const entries = parseSessionJSONL(
        await handle.readFile({ encoding: 'utf8', signal: options.signal }),
        'session transcript'
      );
      options.signal?.throwIfAborted();
      await options.validateHandle?.(handle);
      options.signal?.throwIfAborted();
      return entries;
    } finally {
      await handle.close();
    }
  }

  /**
   * 获取文件路径
   */
  getFilePath(): string {
    return this.filePath;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = JSONLStore.appendQueues.get(this.filePath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const barrier = result.then(
      () => undefined,
      () => undefined
    );
    JSONLStore.appendQueues.set(this.filePath, barrier);

    try {
      return await result;
    } finally {
      if (JSONLStore.appendQueues.get(this.filePath) === barrier) {
        JSONLStore.appendQueues.delete(this.filePath);
      }
    }
  }

  private async readCommittedState(
    handle: fs.FileHandle,
    source = this.filePath
  ): Promise<{
    entries: SessionEvent[];
    separator: string;
    size: number;
  }> {
    const separator = await this.repairIncompleteTail(handle);
    const content = await handle.readFile('utf8');
    const entries = parseSessionJSONL(content, source);
    const { size } = await handle.stat();
    return { entries, separator, size };
  }

  /**
   * Reads the highest committed seq by scanning only the file tail. Assumes the
   * incomplete tail has already been repaired (so the file ends on a newline).
   * Falls back to a full parse only for legacy transcripts whose last record
   * predates seq numbers — the very next append stamps a seq, restoring O(tail).
   */
  private async readTailSeq(handle: fs.FileHandle): Promise<number> {
    const { size } = await handle.stat();
    if (size === 0) return 0;

    // Read a bounded tail window and take the last non-empty line. One window
    // covers the final record unless a single record exceeds the chunk size.
    const start = Math.max(0, size - TAIL_SCAN_CHUNK_SIZE);
    const window = Buffer.allocUnsafe(size - start);
    await handle.read(window, 0, window.length, start);
    const lines = window.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // A partial first line (record larger than the window) is ambiguous;
      // only trust it when the window starts at the file head.
      if (i === 0 && start > 0) break;
      try {
        const seq = (JSON.parse(line) as SessionEvent).seq;
        if (typeof seq === 'number') return seq;
      } catch {
        // fall through to full-parse fallback
      }
      break;
    }

    // Legacy transcript without a tail seq (or an oversized final record):
    // parse fully to backfill the base. The next append stamps seq, so this
    // fallback is one-time per legacy file.
    const content = await handle.readFile('utf8');
    return JSONLStore.maxSeq(parseSessionJSONL(content, this.filePath));
  }

  private async repairIncompleteTail(handle: fs.FileHandle): Promise<string> {
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
