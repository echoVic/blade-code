import * as fsSync from 'node:fs';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { BladeJSONLEntry } from '../types.js';

/**
 * JSONL 存储类 - 处理 JSONL 格式的读写
 */
export class JSONLStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * 追加一条 JSONL 记录到文件
   * @param entry JSONL 条目
   */
  async append(entry: BladeJSONLEntry): Promise<void> {
    try {
      // 确保父目录存在
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });

      // 将对象序列化为 JSON 字符串并追加换行符
      const line = JSON.stringify(entry) + '\n';

      // 追加写入文件
      await fs.appendFile(this.filePath, line, 'utf-8');
    } catch (error) {
      console.error(`[JSONLStore] 追加写入失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 批量追加多条 JSONL 记录
   * @param entries JSONL 条目数组
   */
  async appendBatch(entries: BladeJSONLEntry[]): Promise<void> {
    try {
      // 确保父目录存在
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });

      // 将所有条目序列化为一个字符串
      const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

      // 批量追加写入
      await fs.appendFile(this.filePath, lines, 'utf-8');
    } catch (error) {
      console.error(`[JSONLStore] 批量追加写入失败: ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * 读取所有 JSONL 记录
   * @returns JSONL 条目数组
   */
  async readAll(): Promise<BladeJSONLEntry[]> {
    try {
      // 检查文件是否存在
      if (!fsSync.existsSync(this.filePath)) {
        return [];
      }

      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);

      const entries: BladeJSONLEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as BladeJSONLEntry);
        } catch (parseError) {
          console.warn(`[JSONLStore] 解析 JSON 行失败: ${line}`, parseError);
        }
      }

      return entries;
    } catch (error) {
      console.error(`[JSONLStore] 读取文件失败: ${this.filePath}`, error);
      return [];
    }
  }

  /**
   * 流式读取 JSONL 记录（适合大文件）
   * @param callback 每条记录的回调函数
   */
  async readStream(
    callback: (entry: BladeJSONLEntry) => void | Promise<void>
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
          const entry = JSON.parse(trimmed) as BladeJSONLEntry;
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
  async filter(
    predicate: (entry: BladeJSONLEntry) => boolean
  ): Promise<BladeJSONLEntry[]> {
    const results: BladeJSONLEntry[] = [];
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
  async readLast(count: number): Promise<BladeJSONLEntry[]> {
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
}


