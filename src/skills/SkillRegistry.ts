/**
 * SkillRegistry - Skill 注册表
 *
 * 负责发现、加载、管理所有可用的 Skills。
 * 使用 Progressive Disclosure：启动时仅加载元数据，执行时才加载完整内容。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { hasSkillFile, loadSkillContent, loadSkillMetadata } from './SkillLoader.js';
import type {
  SkillContent,
  SkillDiscoveryResult,
  SkillMetadata,
  SkillRegistryConfig,
} from './types.js';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Required<SkillRegistryConfig> = {
  userSkillsDir: path.join(homedir(), '.blade', 'skills'),
  projectSkillsDir: '.blade/skills',
  cwd: process.cwd(),
};

/**
 * SkillRegistry 单例
 */
let instance: SkillRegistry | null = null;

/**
 * Skill 注册表
 */
export class SkillRegistry {
  private skills: Map<string, SkillMetadata> = new Map();
  private config: Required<SkillRegistryConfig>;
  private initialized = false;

  constructor(config?: SkillRegistryConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 获取单例实例
   */
  static getInstance(config?: SkillRegistryConfig): SkillRegistry {
    if (!instance) {
      instance = new SkillRegistry(config);
    }
    return instance;
  }

  /**
   * 重置单例（用于测试）
   */
  static resetInstance(): void {
    instance = null;
  }

  /**
   * 初始化注册表，扫描所有 skills 目录
   */
  async initialize(): Promise<SkillDiscoveryResult> {
    if (this.initialized) {
      return {
        skills: Array.from(this.skills.values()),
        errors: [],
      };
    }

    const errors: SkillDiscoveryResult['errors'] = [];
    const discoveredSkills: SkillMetadata[] = [];

    // 扫描用户级 skills（优先级 1）
    const userResult = await this.scanDirectory(this.config.userSkillsDir, 'user');
    discoveredSkills.push(...userResult.skills);
    errors.push(...userResult.errors);

    // 扫描项目级 skills（优先级 2，可覆盖用户级同名 skill）
    const projectDir = path.isAbsolute(this.config.projectSkillsDir)
      ? this.config.projectSkillsDir
      : path.join(this.config.cwd, this.config.projectSkillsDir);
    const projectResult = await this.scanDirectory(projectDir, 'project');
    discoveredSkills.push(...projectResult.skills);
    errors.push(...projectResult.errors);

    // 注册所有发现的 skills（后发现的覆盖先发现的）
    for (const skill of discoveredSkills) {
      this.skills.set(skill.name, skill);
    }

    this.initialized = true;

    return {
      skills: Array.from(this.skills.values()),
      errors,
    };
  }

  /**
   * 扫描指定目录下的所有 skills
   */
  private async scanDirectory(
    dirPath: string,
    source: 'user' | 'project'
  ): Promise<SkillDiscoveryResult> {
    const skills: SkillMetadata[] = [];
    const errors: SkillDiscoveryResult['errors'] = [];

    try {
      // 检查目录是否存在
      await fs.access(dirPath);
    } catch {
      // 目录不存在，静默返回空结果
      return { skills, errors };
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(dirPath, entry.name);
        const skillFile = path.join(skillDir, 'SKILL.md');

        // 检查是否存在 SKILL.md
        if (!(await hasSkillFile(skillDir))) continue;

        // 加载元数据
        const result = await loadSkillMetadata(skillFile, source);
        if (result.success && result.content) {
          skills.push(result.content.metadata);
        } else {
          errors.push({
            path: skillFile,
            error: result.error || 'Unknown error',
          });
        }
      }
    } catch (e) {
      errors.push({
        path: dirPath,
        error: `Failed to scan directory: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    return { skills, errors };
  }

  /**
   * 获取所有已注册的 skills 元数据
   */
  getAll(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  /**
   * 根据名称获取 skill 元数据
   */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  /**
   * 检查 skill 是否存在
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 加载 skill 的完整内容（懒加载）
   */
  async loadContent(name: string): Promise<SkillContent | null> {
    const metadata = this.skills.get(name);
    if (!metadata) return null;
    return loadSkillContent(metadata);
  }

  /**
   * 生成 <available_skills> 列表内容
   * 格式：每个 skill 一行 `- name: description`
   */
  generateAvailableSkillsList(): string {
    if (this.skills.size === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const skill of this.skills.values()) {
      // 截断过长的描述，保持列表简洁
      const desc =
        skill.description.length > 100 ? `${skill.description.substring(0, 97)}...` : skill.description;
      lines.push(`- ${skill.name}: ${desc}`);
    }

    return lines.join('\n');
  }

  /**
   * 获取 skills 数量
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * 重新扫描并刷新注册表
   */
  async refresh(): Promise<SkillDiscoveryResult> {
    this.skills.clear();
    this.initialized = false;
    return this.initialize();
  }
}

/**
 * 获取 SkillRegistry 单例
 */
export function getSkillRegistry(config?: SkillRegistryConfig): SkillRegistry {
  return SkillRegistry.getInstance(config);
}

/**
 * 初始化并获取所有 skills
 */
export async function discoverSkills(config?: SkillRegistryConfig): Promise<SkillDiscoveryResult> {
  const registry = getSkillRegistry(config);
  return registry.initialize();
}
