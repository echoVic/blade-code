/**
 * SkillRegistry - Skill 注册表
 *
 * 负责发现、加载、管理所有可用的 Skills。
 * 使用 Progressive Disclosure：启动时仅加载元数据，执行时才加载完整内容。
 */

import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { PluginSkill } from '../plugins/types.js';
import {
  getSkillCreatorContent,
  skillCreatorMetadata,
} from './builtin/skill-creator.js';
import { getSkillInstaller } from './SkillInstaller.js';
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
  // Claude Code 兼容路径
  claudeUserSkillsDir: path.join(homedir(), '.claude', 'skills'),
  claudeProjectSkillsDir: '.claude/skills',
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
  /** Plugin skills stored with namespaced names */
  private pluginSkills: Map<string, PluginSkill> = new Map();
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
   *
   * 优先级（后加载的覆盖先加载的）：
   * 1. 内置 Skills（builtin）- 作为 fallback，会被外部同名 Skill 覆盖
   * 2. Claude Code 用户级 Skills（~/.claude/skills/）
   * 3. Blade 用户级 Skills（~/.blade/skills/）
   * 4. Claude Code 项目级 Skills（.claude/skills/）
   * 5. Blade 项目级 Skills（.blade/skills/）- 优先级最高
   *
   * 注意：首次启动时，SkillInstaller 会自动下载官方 skill-creator 到
   * ~/.blade/skills/，因此内置版本仅作为离线 fallback。
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

    // 0. 确保默认 Skills 已安装（首次启动时从 GitHub 下载）
    try {
      const installer = getSkillInstaller(this.config.userSkillsDir);
      await installer.ensureDefaultSkillsInstalled();
    } catch (error) {
      // 下载失败不阻塞启动，内置版本作为 fallback
      errors.push({
        path: 'SkillInstaller',
        error: `Failed to install default skills: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }

    // 1. 加载内置 Skills（优先级最低，可被覆盖）
    this.loadBuiltinSkills();

    // 2. 扫描 Claude Code 用户级 skills（~/.claude/skills/）
    const claudeUserResult = await this.scanDirectory(
      this.config.claudeUserSkillsDir,
      'user'
    );
    discoveredSkills.push(...claudeUserResult.skills);
    errors.push(...claudeUserResult.errors);

    // 3. 扫描 Blade 用户级 skills（~/.blade/skills/）
    const userResult = await this.scanDirectory(this.config.userSkillsDir, 'user');
    discoveredSkills.push(...userResult.skills);
    errors.push(...userResult.errors);

    // 4. 扫描 Claude Code 项目级 skills（.claude/skills/）
    const claudeProjectDir = path.isAbsolute(this.config.claudeProjectSkillsDir)
      ? this.config.claudeProjectSkillsDir
      : path.join(this.config.cwd, this.config.claudeProjectSkillsDir);
    const claudeProjectResult = await this.scanDirectory(claudeProjectDir, 'project');
    discoveredSkills.push(...claudeProjectResult.skills);
    errors.push(...claudeProjectResult.errors);

    // 5. 扫描 Blade 项目级 skills（.blade/skills/）- 优先级最高
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
   * 加载内置 Skills
   */
  private loadBuiltinSkills(): void {
    // 注册 skill-creator
    this.skills.set(skillCreatorMetadata.name, skillCreatorMetadata);
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

    // 内置 Skill 直接返回内容
    if (metadata.source === 'builtin') {
      return this.loadBuiltinContent(name);
    }

    // 文件系统 Skill 从文件加载
    return loadSkillContent(metadata);
  }

  /**
   * 加载内置 Skill 的完整内容
   */
  private loadBuiltinContent(name: string): SkillContent | null {
    switch (name) {
      case 'skill-creator':
        return getSkillCreatorContent();
      default:
        return null;
    }
  }

  /**
   * 获取可被 AI 自动调用的 Skills（Model-invoked）
   * 排除设置了 disable-model-invocation: true 的 Skills
   */
  getModelInvocableSkills(): SkillMetadata[] {
    return Array.from(this.skills.values()).filter(
      (skill) => !skill.disableModelInvocation
    );
  }

  /**
   * 获取可通过 /skill-name 命令调用的 Skills（User-invoked）
   * 仅包含设置了 user-invocable: true 的 Skills
   */
  getUserInvocableSkills(): SkillMetadata[] {
    return Array.from(this.skills.values()).filter(
      (skill) => skill.userInvocable === true
    );
  }

  /**
   * 生成 <available_skills> 列表内容
   * 格式：每个 skill 一行 `- name [argument-hint]: description`
   * 仅包含可被 AI 自动调用的 Skills
   */
  generateAvailableSkillsList(): string {
    const modelInvocableSkills = this.getModelInvocableSkills();
    if (modelInvocableSkills.length === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const skill of modelInvocableSkills) {
      // 截断过长的描述，保持列表简洁
      const desc =
        skill.description.length > 100
          ? `${skill.description.substring(0, 97)}...`
          : skill.description;

      // 如果有 argument-hint，添加到名称后面
      const nameWithHint = skill.argumentHint
        ? `${skill.name} ${skill.argumentHint}`
        : skill.name;

      lines.push(`- ${nameWithHint}: ${desc}`);
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
    this.pluginSkills.clear();
    this.initialized = false;
    return this.initialize();
  }

  // ============================================================
  // Plugin Skill Methods
  // ============================================================

  /**
   * 注册插件技能
   *
   * Plugin skills are stored with their namespaced names (e.g., "plugin:skill")
   * to prevent conflicts with other plugins or standalone skills.
   *
   * @param skill - Plugin skill to register
   */
  registerPluginSkill(skill: PluginSkill): void {
    this.pluginSkills.set(skill.namespacedName, skill);
    // Also register in the main skills map for unified access
    this.skills.set(skill.namespacedName, skill.metadata);
  }

  /**
   * 查找插件技能
   *
   * Supports both:
   * - Full namespaced name: "plugin:skill"
   * - Short name if unique: "skill"
   *
   * @param name - Skill name to find
   * @returns Plugin skill or undefined
   */
  findPluginSkill(name: string): PluginSkill | undefined {
    // Try exact namespaced match first
    const exact = this.pluginSkills.get(name);
    if (exact) return exact;

    // Try short name match (if unique)
    const matches: PluginSkill[] = [];
    for (const skill of this.pluginSkills.values()) {
      if (skill.originalName === name) {
        matches.push(skill);
      }
    }

    // Only return if exactly one match
    if (matches.length === 1) {
      return matches[0];
    }

    return undefined;
  }

  /**
   * 获取所有插件技能
   */
  getAllPluginSkills(): PluginSkill[] {
    return Array.from(this.pluginSkills.values());
  }

  /**
   * 清除所有插件技能
   * Called when refreshing plugins
   */
  clearPluginSkills(): void {
    // Remove from main skills map
    for (const skill of this.pluginSkills.values()) {
      this.skills.delete(skill.namespacedName);
    }
    this.pluginSkills.clear();
  }

  /**
   * 获取插件技能数量
   */
  getPluginSkillCount(): number {
    return this.pluginSkills.size;
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
export async function discoverSkills(
  config?: SkillRegistryConfig
): Promise<SkillDiscoveryResult> {
  const registry = getSkillRegistry(config);
  return registry.initialize();
}
