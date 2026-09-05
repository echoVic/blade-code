/**
 * Auto Memory Manager
 *
 * 管理项目级的自动记忆系统，跨会话持久化 Agent 学到的项目知识。
 *
 * 存储结构：
 * ~/.blade/projects/{escaped-path}/memory/
 * ├── MEMORY.md          # 入口索引（启动时加载前 N 行）
 * ├── patterns.md        # 项目模式
 * ├── debugging.md       # 调试洞察
 * └── ...                # Agent 按需创建
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { getProjectStoragePath } from '../context/storage/pathUtils.js';
import { KeyedMutexRegistry } from '../utils/KeyedMutexRegistry.js';
import {
  AutoMemoryConfig,
  DEFAULT_AUTO_MEMORY_CONFIG,
  MemoryTopicInfo,
} from './types.js';

const MEMORY_DIR = 'memory';
const INDEX_FILE = 'MEMORY.md';
const MANAGED_TOPICS_START = '<!-- blade:auto-memory-topics:start -->';
const MANAGED_TOPICS_END = '<!-- blade:auto-memory-topics:end -->';
const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  retries: {
    retries: 5,
    factor: 1.2,
    minTimeout: 20,
    maxTimeout: 100,
    randomize: true,
  },
};

type LockfileModule = typeof import('proper-lockfile');

export interface MemoryBatchWriteResult {
  written: number;
  duplicate: number;
  topics: string[];
}

const memoryLocks = new KeyedMutexRegistry<string>();
let lockfileModule: LockfileModule | undefined;

function normalizeMemoryEntry(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function storedEntryPayload(line: string): string {
  return normalizeMemoryEntry(line.replace(/^- \[\d{4}-\d{2}-\d{2}\] /, ''));
}

function managedTopicsBlock(topics: readonly string[]): string {
  return [
    MANAGED_TOPICS_START,
    '## Auto-consolidated topics',
    ...topics.map((topic) => `- [${topic}](${topic}.md)`),
    MANAGED_TOPICS_END,
  ].join('\n');
}

function updateManagedTopicsIndex(existing: string, topics: readonly string[]): string {
  const block = managedTopicsBlock(topics);
  const start = existing.indexOf(MANAGED_TOPICS_START);
  const end = existing.indexOf(MANAGED_TOPICS_END, Math.max(0, start));
  if (start >= 0 && end >= start) {
    return (
      existing.slice(0, start) + block + existing.slice(end + MANAGED_TOPICS_END.length)
    );
  }
  if (!existing) return `${block}\n`;
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

function topicsFromManagedIndex(content: string): Set<string> {
  const start = content.indexOf(MANAGED_TOPICS_START);
  const end = content.indexOf(MANAGED_TOPICS_END, Math.max(0, start));
  if (start < 0 || end < start) return new Set();
  const topics = new Set<string>();
  const block = content.slice(start, end);
  for (const match of block.matchAll(/^- \[([^\]\r\n]+)\]\([^\r\n]+\.md\)$/gm)) {
    const topic = match[1];
    if (topic) topics.add(topic);
  }
  return topics;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function getLockfile(): Promise<LockfileModule> {
  lockfileModule ??= await import('proper-lockfile');
  return lockfileModule;
}

export class AutoMemoryManager {
  private static readonly locks = memoryLocks;
  private readonly memoryDir: string;
  private readonly config: AutoMemoryConfig;
  private initialized = false;

  constructor(
    projectPath: string,
    config?: Partial<AutoMemoryConfig>,
    memoryDirOverride?: string
  ) {
    if (memoryDirOverride) {
      this.memoryDir = memoryDirOverride;
    } else {
      const storagePath = getProjectStoragePath(projectPath);
      this.memoryDir = path.join(storagePath, MEMORY_DIR);
    }
    this.config = { ...DEFAULT_AUTO_MEMORY_CONFIG, ...config };
  }

  /**
   * 确保 memory 目录存在
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.memoryDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * 加载 MEMORY.md 前 N 行，用于注入 system prompt
   */
  async loadIndex(): Promise<string | null> {
    if (!this.config.enabled) return null;

    await this.initialize();
    const indexPath = path.join(this.memoryDir, INDEX_FILE);

    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      if (!content.trim()) return null;

      const lines = content.split('\n');
      const truncated = lines.slice(0, this.config.maxIndexLines);
      const result = truncated.join('\n').trim();

      if (lines.length > this.config.maxIndexLines) {
        return (
          result +
          `\n\n<!-- ${lines.length - this.config.maxIndexLines} more lines in MEMORY.md, use MemoryRead to access -->`
        );
      }

      return result || null;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      )
        return null;
      throw err;
    }
  }

  /**
   * 读取主题文件
   */
  async readTopic(topic: string): Promise<string | null> {
    await this.initialize();
    const filePath = this.resolveTopicPath(topic);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content || null;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      )
        return null;
      throw err;
    }
  }

  /**
   * 写入主题文件
   */
  async writeTopic(
    topic: string,
    content: string,
    mode: 'overwrite' | 'append' = 'append'
  ): Promise<void> {
    await this.initialize();
    const filePath = this.resolveTopicPath(topic);

    if (mode === 'append') {
      let existing = '';
      try {
        existing = await fs.readFile(filePath, 'utf-8');
      } catch {
        // 文件不存在，从空开始
      }
      const separator = existing && !existing.endsWith('\n') ? '\n' : '';
      await fs.writeFile(filePath, existing + separator + content, 'utf-8');
    } else {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  /**
   * 更新 MEMORY.md 索引
   */
  async updateIndex(
    content: string,
    mode: 'overwrite' | 'append' = 'overwrite'
  ): Promise<void> {
    await this.initialize();
    const indexPath = path.join(this.memoryDir, INDEX_FILE);

    if (mode === 'append') {
      let existing = '';
      try {
        existing = await fs.readFile(indexPath, 'utf-8');
      } catch {
        // 文件不存在
      }
      const separator = existing && !existing.endsWith('\n') ? '\n' : '';
      await fs.writeFile(indexPath, existing + separator + content, 'utf-8');
    } else {
      await fs.writeFile(indexPath, content, 'utf-8');
    }
  }

  async appendUniqueEntries(
    entriesByTopic: ReadonlyMap<string, readonly string[]>
  ): Promise<MemoryBatchWriteResult> {
    await this.initialize();
    const canonicalMemoryDir = await fs.realpath(this.memoryDir);

    return AutoMemoryManager.locks.runExclusive(canonicalMemoryDir, async () => {
      const lockfile = await getLockfile();
      const release = await lockfile.lock(canonicalMemoryDir, LOCK_OPTIONS);
      try {
        const changedTopics: string[] = [];
        let written = 0;
        let duplicate = 0;
        const timestamp = new Date().toISOString().slice(0, 10);

        for (const topic of [...entriesByTopic.keys()].sort()) {
          const entries = entriesByTopic.get(topic) ?? [];
          const filePath = this.resolveTopicPath(topic);
          const existing = await readOptionalFile(filePath);
          const known = new Set(
            existing.split(/\r?\n/).map(storedEntryPayload).filter(Boolean)
          );
          const additions: string[] = [];
          for (const rawEntry of entries) {
            const entry = normalizeMemoryEntry(rawEntry);
            if (!entry || known.has(entry)) {
              duplicate++;
              continue;
            }
            known.add(entry);
            additions.push(`- [${timestamp}] ${entry}`);
          }
          if (additions.length === 0) continue;

          const separator = existing && !existing.endsWith('\n') ? '\n' : '';
          await writeFileAtomic(
            filePath,
            `${existing}${separator}${additions.join('\n')}\n`,
            { mode: 0o600 }
          );
          changedTopics.push(topic.replace(/\.md$/, ''));
          written += additions.length;
        }

        if (changedTopics.length > 0) {
          const indexPath = path.join(this.memoryDir, INDEX_FILE);
          const existingIndex = await readOptionalFile(indexPath);
          const indexedTopics = topicsFromManagedIndex(existingIndex);
          for (const topic of changedTopics) indexedTopics.add(topic);
          const nextIndex = updateManagedTopicsIndex(
            existingIndex,
            [...indexedTopics].sort()
          );
          if (nextIndex !== existingIndex) {
            await writeFileAtomic(indexPath, nextIndex, { mode: 0o600 });
          }
        }

        return { written, duplicate, topics: changedTopics.sort() };
      } finally {
        await release();
      }
    });
  }

  /**
   * 列出所有主题文件
   */
  async listTopics(): Promise<MemoryTopicInfo[]> {
    await this.initialize();

    try {
      const entries = await fs.readdir(this.memoryDir, { withFileTypes: true });
      const topics: MemoryTopicInfo[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

        const filePath = path.join(this.memoryDir, entry.name);
        const stat = await fs.stat(filePath);
        topics.push({
          name: entry.name.replace(/\.md$/, ''),
          size: stat.size,
          lastModified: stat.mtime,
        });
      }

      return topics.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * 删除主题文件
   */
  async deleteTopic(topic: string): Promise<boolean> {
    const filePath = this.resolveTopicPath(topic);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清空所有记忆
   */
  async clearAll(): Promise<number> {
    const topics = await this.listTopics();
    let count = 0;
    for (const topic of topics) {
      const filePath = path.join(this.memoryDir, `${topic.name}.md`);
      try {
        await fs.unlink(filePath);
        count++;
      } catch {
        // ignore
      }
    }
    return count;
  }

  /**
   * 获取 memory 目录路径
   */
  getMemoryDir(): string {
    return this.memoryDir;
  }

  /**
   * 解析主题文件路径，防止路径穿越
   */
  private resolveTopicPath(topic: string): string {
    // 安全：只允许简单文件名，不允许路径分隔符
    const safeName = topic.replace(/[/\\:*?"<>|]/g, '-');
    const filename = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
    const resolved = path.join(this.memoryDir, filename);

    // 防止路径穿越
    if (!resolved.startsWith(this.memoryDir)) {
      throw new Error(`Invalid topic name: ${topic}`);
    }

    return resolved;
  }
}
