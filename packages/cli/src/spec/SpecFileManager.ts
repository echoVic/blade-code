/**
 * Spec 文件 I/O 管理器
 *
 * 负责 Spec 相关文件的读写、目录结构管理
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import {
  PHASE_PRIMARY_FILE,
  SPEC_DIRS,
  SPEC_FILE_NAMES,
  type SpecFileType,
  type SpecMetadata,
  type SpecPhase,
  STEERING_FILES,
  type SteeringContext,
} from './types.js';

// 获取模板目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, 'templates');

/**
 * Spec 文件管理器
 */
export class SpecFileManager {
  private workspaceRoot: string;
  private bladeDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.bladeDir = path.join(workspaceRoot, '.blade');
  }

  // =====================================
  // 目录路径获取
  // =====================================

  /**
   * 获取 specs 目录路径
   */
  getSpecsDir(): string {
    return path.join(this.bladeDir, SPEC_DIRS.SPECS);
  }

  /**
   * 获取 changes 目录路径
   */
  getChangesDir(): string {
    return path.join(this.bladeDir, SPEC_DIRS.CHANGES);
  }

  /**
   * 获取 archive 目录路径
   */
  getArchiveDir(): string {
    return path.join(this.bladeDir, SPEC_DIRS.ARCHIVE);
  }

  /**
   * 获取 steering 目录路径
   */
  getSteeringDir(): string {
    return path.join(this.bladeDir, SPEC_DIRS.STEERING);
  }

  /**
   * 获取特定 change 的目录路径
   */
  getChangePath(featureName: string): string {
    return path.join(this.getChangesDir(), featureName);
  }

  /**
   * 获取特定 change 的文件路径
   */
  getChangeFilePath(featureName: string, fileType: SpecFileType): string {
    return path.join(this.getChangePath(featureName), SPEC_FILE_NAMES[fileType]);
  }

  // =====================================
  // 目录初始化
  // =====================================

  /**
   * 初始化 Spec 目录结构
   * 只创建 changes 目录（最常用），其他目录按需创建
   */
  async initializeDirectories(): Promise<void> {
    // 只创建 changes 目录，其他目录在使用时按需创建
    await fs.mkdir(this.getChangesDir(), { recursive: true, mode: 0o755 });
  }

  /**
   * 创建新的 change 目录
   */
  async createChangeDir(featureName: string): Promise<string> {
    const changePath = this.getChangePath(featureName);
    await fs.mkdir(changePath, { recursive: true, mode: 0o755 });

    // 创建 specs delta 子目录
    await fs.mkdir(path.join(changePath, SPEC_DIRS.SPEC_DELTA), { recursive: true, mode: 0o755 });

    return changePath;
  }

  // =====================================
  // 文件读写
  // =====================================

  /**
   * 读取文件内容
   */
  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 写入文件内容
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * 检查文件是否存在
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查目录是否存在
   */
  async dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  // =====================================
  // Spec 元数据管理
  // =====================================

  /**
   * 创建新的 Spec 元数据
   */
  createMetadata(name: string, description: string): SpecMetadata {
    const now = new Date().toISOString();
    return {
      id: nanoid(),
      name,
      description,
      phase: 'init',
      createdAt: now,
      updatedAt: now,
      tasks: [],
    };
  }

  /**
   * 读取 Spec 元数据
   */
  async readMetadata(featureName: string): Promise<SpecMetadata | null> {
    const metaPath = this.getChangeFilePath(featureName, 'meta');
    const content = await this.readFile(metaPath);
    if (!content) return null;

    try {
      return JSON.parse(content) as SpecMetadata;
    } catch {
      return null;
    }
  }

  /**
   * 写入 Spec 元数据
   */
  async writeMetadata(featureName: string, metadata: SpecMetadata): Promise<void> {
    const metaPath = this.getChangeFilePath(featureName, 'meta');
    metadata.updatedAt = new Date().toISOString();
    await this.writeFile(metaPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * 更新 Spec 阶段
   */
  async updatePhase(
    featureName: string,
    phase: SpecPhase
  ): Promise<SpecMetadata | null> {
    const metadata = await this.readMetadata(featureName);
    if (!metadata) return null;

    metadata.phase = phase;
    await this.writeMetadata(featureName, metadata);
    return metadata;
  }

  // =====================================
  // Spec 文件内容管理
  // =====================================

  /**
   * 读取 Spec 文件
   */
  async readSpecFile(
    featureName: string,
    fileType: SpecFileType
  ): Promise<string | null> {
    const filePath = this.getChangeFilePath(featureName, fileType);
    return this.readFile(filePath);
  }

  /**
   * 写入 Spec 文件
   */
  async writeSpecFile(
    featureName: string,
    fileType: SpecFileType,
    content: string
  ): Promise<void> {
    const filePath = this.getChangeFilePath(featureName, fileType);
    await this.writeFile(filePath, content);

    // 更新元数据的 updatedAt
    const metadata = await this.readMetadata(featureName);
    if (metadata) {
      await this.writeMetadata(featureName, metadata);
    }
  }

  /**
   * 获取阶段对应的主要文件内容
   */
  async getPhaseContent(featureName: string, phase: SpecPhase): Promise<string | null> {
    const fileType = PHASE_PRIMARY_FILE[phase];
    if (!fileType) return null;
    return this.readSpecFile(featureName, fileType);
  }

  // =====================================
  // Steering Documents 管理
  // =====================================

  /**
   * 读取 Steering 上下文
   */
  async readSteeringContext(): Promise<SteeringContext> {
    const steeringDir = this.getSteeringDir();

    const [constitution, product, tech, structure] = await Promise.all([
      this.readFile(path.join(steeringDir, STEERING_FILES.CONSTITUTION)),
      this.readFile(path.join(steeringDir, STEERING_FILES.PRODUCT)),
      this.readFile(path.join(steeringDir, STEERING_FILES.TECH)),
      this.readFile(path.join(steeringDir, STEERING_FILES.STRUCTURE)),
    ]);

    return {
      constitution: constitution || undefined,
      product: product || undefined,
      tech: tech || undefined,
      structure: structure || undefined,
    };
  }

  /**
   * 写入 Steering 文件
   */
  async writeSteeringFile(
    fileName: keyof typeof STEERING_FILES,
    content: string
  ): Promise<void> {
    const filePath = path.join(this.getSteeringDir(), STEERING_FILES[fileName]);
    await this.writeFile(filePath, content);
  }

  /**
   * 检查是否有 Steering Documents
   */
  async hasSteeringDocs(): Promise<boolean> {
    const steeringDir = this.getSteeringDir();
    if (!(await this.dirExists(steeringDir))) return false;

    const files = await fs.readdir(steeringDir);
    return files.length > 0;
  }

  // =====================================
  // 变更列表和搜索
  // =====================================

  /**
   * 列出所有活跃的变更
   */
  async listActiveChanges(): Promise<string[]> {
    const changesDir = this.getChangesDir();
    if (!(await this.dirExists(changesDir))) return [];

    const entries = await fs.readdir(changesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * 列出所有归档的变更
   */
  async listArchivedChanges(): Promise<string[]> {
    const archiveDir = this.getArchiveDir();
    if (!(await this.dirExists(archiveDir))) return [];

    const entries = await fs.readdir(archiveDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * 检查变更是否存在
   */
  async changeExists(featureName: string): Promise<boolean> {
    return this.dirExists(this.getChangePath(featureName));
  }

  // =====================================
  // 归档操作
  // =====================================

  /**
   * 归档变更
   */
  async archiveChange(featureName: string): Promise<void> {
    const sourcePath = this.getChangePath(featureName);
    const targetPath = path.join(this.getArchiveDir(), featureName);

    // 确保目标目录存在
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });

    // 移动目录
    await fs.rename(sourcePath, targetPath);
  }

  /**
   * 从归档恢复变更
   */
  async restoreChange(featureName: string): Promise<void> {
    const sourcePath = path.join(this.getArchiveDir(), featureName);
    const targetPath = this.getChangePath(featureName);

    await fs.rename(sourcePath, targetPath);
  }

  // =====================================
  // 权威 Specs 管理
  // =====================================

  /**
   * 列出所有权威 Spec 领域
   */
  async listSpecDomains(): Promise<string[]> {
    const specsDir = this.getSpecsDir();
    if (!(await this.dirExists(specsDir))) return [];

    const entries = await fs.readdir(specsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * 读取权威 Spec
   */
  async readAuthorativeSpec(domain: string): Promise<string | null> {
    const specPath = path.join(this.getSpecsDir(), domain, 'spec.md');
    return this.readFile(specPath);
  }

  /**
   * 写入权威 Spec
   */
  async writeAuthorativeSpec(domain: string, content: string): Promise<void> {
    const specPath = path.join(this.getSpecsDir(), domain, 'spec.md');
    await this.writeFile(specPath, content);
  }

  /**
   * 合并变更的 Spec delta 到权威 Specs
   */
  async mergeSpecDeltas(featureName: string): Promise<string[]> {
    const deltaDir = path.join(this.getChangePath(featureName), SPEC_DIRS.SPEC_DELTA);
    if (!(await this.dirExists(deltaDir))) return [];

    const mergedDomains: string[] = [];
    const domains = await fs.readdir(deltaDir, { withFileTypes: true });

    for (const domain of domains) {
      if (!domain.isDirectory()) continue;

      const deltaSpecPath = path.join(deltaDir, domain.name, 'spec.md');
      const deltaContent = await this.readFile(deltaSpecPath);

      if (deltaContent) {
        // 读取现有权威 Spec
        const existingContent = await this.readAuthorativeSpec(domain.name);

        // 合并策略：追加或替换（这里采用追加）
        const mergedContent = existingContent
          ? `${existingContent}\n\n---\n\n<!-- Merged from ${featureName} -->\n\n${deltaContent}`
          : deltaContent;

        await this.writeAuthorativeSpec(domain.name, mergedContent);
        mergedDomains.push(domain.name);
      }
    }

    return mergedDomains;
  }

  // =====================================
  // 模板管理
  // =====================================

  /**
   * 模板文件名映射
   */
  private static readonly TEMPLATE_NAMES: Record<SpecFileType, string> = {
    proposal: 'proposal.md.template',
    spec: 'spec.md.template',
    requirements: 'requirements.md.template',
    design: 'design.md.template',
    tasks: 'tasks.md.template',
    meta: '', // meta 不使用模板
  };

  /**
   * Steering 模板文件名映射
   */
  private static readonly STEERING_TEMPLATE_NAMES: Record<
    keyof typeof STEERING_FILES,
    string
  > = {
    CONSTITUTION: 'steering/constitution.md.template',
    PRODUCT: 'steering/product.md.template',
    TECH: 'steering/tech.md.template',
    STRUCTURE: 'steering/structure.md.template',
  };

  /**
   * 读取模板文件
   */
  async readTemplate(fileType: SpecFileType): Promise<string | null> {
    const templateName = SpecFileManager.TEMPLATE_NAMES[fileType];
    if (!templateName) return null;

    const templatePath = path.join(TEMPLATES_DIR, templateName);
    return this.readFile(templatePath);
  }

  /**
   * 读取 Steering 模板文件
   */
  async readSteeringTemplate(
    fileName: keyof typeof STEERING_FILES
  ): Promise<string | null> {
    const templateName = SpecFileManager.STEERING_TEMPLATE_NAMES[fileName];
    const templatePath = path.join(TEMPLATES_DIR, templateName);
    return this.readFile(templatePath);
  }

  /**
   * 填充模板变量
   */
  fillTemplate(template: string, variables: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return result;
  }

  /**
   * 从模板创建 Spec 文件
   */
  async createFromTemplate(
    featureName: string,
    fileType: SpecFileType,
    variables: Record<string, string>
  ): Promise<string | null> {
    const template = await this.readTemplate(fileType);
    if (!template) return null;

    const content = this.fillTemplate(template, {
      name: featureName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...variables,
    });

    await this.writeSpecFile(featureName, fileType, content);
    return content;
  }

  /**
   * 从模板创建 Steering 文件
   */
  async createSteeringFromTemplate(
    fileName: keyof typeof STEERING_FILES,
    variables: Record<string, string> = {}
  ): Promise<string | null> {
    const template = await this.readSteeringTemplate(fileName);
    if (!template) return null;

    const content = this.fillTemplate(template, {
      createdAt: new Date().toISOString(),
      ...variables,
    });

    await this.writeSteeringFile(fileName, content);
    return content;
  }

  /**
   * 初始化所有 Steering 文件（如果不存在）
   */
  async initializeSteeringDocs(): Promise<string[]> {
    const createdFiles: string[] = [];
    const steeringDir = this.getSteeringDir();

    for (const [key, fileName] of Object.entries(STEERING_FILES)) {
      const filePath = path.join(steeringDir, fileName);
      if (!(await this.fileExists(filePath))) {
        await this.createSteeringFromTemplate(key as keyof typeof STEERING_FILES);
        createdFiles.push(fileName);
      }
    }

    return createdFiles;
  }
}
