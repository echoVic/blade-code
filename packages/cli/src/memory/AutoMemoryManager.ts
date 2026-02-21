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
import { getProjectStoragePath } from '../context/storage/pathUtils.js';
import { AutoMemoryConfig, DEFAULT_AUTO_MEMORY_CONFIG, MemoryTopicInfo } from './types.js';

const MEMORY_DIR = 'memory';
const INDEX_FILE = 'MEMORY.md';

export class AutoMemoryManager {
  private readonly memoryDir: string;
  private readonly config: AutoMemoryConfig;
  private initialized = false;

  constructor(projectPath: string, config?: Partial<AutoMemoryConfig>) {
    const storagePath = getProjectStoragePath(projectPath);
    this.memoryDir = path.join(storagePath, MEMORY_DIR);
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
        return result + `\n\n<!-- ${lines.length - this.config.maxIndexLines} more lines in MEMORY.md, use MemoryRead to access -->`;
      }

      return result || null;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
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
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * 写入主题文件
   */
  async writeTopic(topic: string, content: string, mode: 'overwrite' | 'append' = 'append'): Promise<void> {
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
  async updateIndex(content: string, mode: 'overwrite' | 'append' = 'overwrite'): Promise<void> {
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
    } catch {
      return [];
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
