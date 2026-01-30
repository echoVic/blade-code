/**
 * Spec 文件服务
 *
 * 无状态的文件操作服务，不持有任何运行时状态。
 * 所有状态由 specSlice (Zustand Store) 管理。
 */

import { nanoid } from 'nanoid';
import { SpecFileManager } from './SpecFileManager.js';
import {
  PHASE_TRANSITIONS,
  type SpecMetadata,
  type SpecOperationResult,
  type SpecPhase,
  type SpecTask,
  type SpecValidationResult,
  type SteeringContext,
  type TaskComplexity,
  type TaskStatus,
} from './types.js';

/**
 * Spec 文件服务（无状态）
 */
export class SpecService {
  private static instance: SpecService | null = null;
  private fileManager: SpecFileManager | null = null;
  private workspaceRoot: string | null = null;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): SpecService {
    if (!SpecService.instance) {
      SpecService.instance = new SpecService();
    }
    return SpecService.instance;
  }

  /**
   * 重置实例（用于测试）
   */
  static resetInstance(): void {
    SpecService.instance = null;
  }

  /**
   * 初始化服务
   */
  async initialize(workspaceRoot: string): Promise<void> {
    if (this.workspaceRoot === workspaceRoot && this.fileManager) {
      return; // 已初始化
    }
    this.workspaceRoot = workspaceRoot;
    this.fileManager = new SpecFileManager(workspaceRoot);
    await this.fileManager.initializeDirectories();
  }

  /**
   * 获取文件管理器
   */
  getFileManager(): SpecFileManager {
    if (!this.fileManager) {
      throw new Error('SpecService not initialized. Call initialize() first.');
    }
    return this.fileManager;
  }

  // =====================================
  // 文件读取操作
  // =====================================

  /**
   * 读取 Steering 上下文
   */
  async readSteeringContext(): Promise<SteeringContext | null> {
    const fm = this.getFileManager();
    return fm.readSteeringContext();
  }

  /**
   * 读取 Spec 元数据
   */
  async readSpecMetadata(name: string): Promise<SpecMetadata | null> {
    const fm = this.getFileManager();
    return fm.readMetadata(name);
  }

  /**
   * 检查 Spec 是否存在
   */
  async specExists(name: string): Promise<boolean> {
    const fm = this.getFileManager();
    return fm.changeExists(name);
  }

  /**
   * 获取 Spec 路径
   */
  getSpecPath(name: string): string {
    const fm = this.getFileManager();
    return fm.getChangePath(name);
  }

  // =====================================
  // Spec 生命周期操作
  // =====================================

  /**
   * 创建新的 Spec
   */
  async createSpec(
    name: string,
    description: string
  ): Promise<SpecOperationResult<{ spec: SpecMetadata; path: string }>> {
    const fm = this.getFileManager();

    // 检查是否已存在
    if (await fm.changeExists(name)) {
      return {
        success: false,
        message: `Spec "${name}" already exists`,
        error: 'SPEC_EXISTS',
      };
    }

    // 创建目录
    const changePath = await fm.createChangeDir(name);

    // 创建元数据
    const metadata = fm.createMetadata(name, description);
    await fm.writeMetadata(name, metadata);

    // 创建初始 proposal.md
    const proposalContent = this.generateProposalTemplate(name, description);
    await fm.writeSpecFile(name, 'proposal', proposalContent);

    return {
      success: true,
      message: `Spec "${name}" created successfully`,
      data: {
        spec: metadata,
        path: changePath,
      },
    };
  }

  /**
   * 加载 Spec 元数据
   */
  async loadSpec(
    name: string
  ): Promise<SpecOperationResult<{ spec: SpecMetadata; path: string }>> {
    const fm = this.getFileManager();

    const metadata = await fm.readMetadata(name);
    if (!metadata) {
      return {
        success: false,
        message: `Spec "${name}" not found`,
        error: 'SPEC_NOT_FOUND',
      };
    }

    const changePath = fm.getChangePath(name);

    return {
      success: true,
      message: `Spec "${name}" loaded successfully`,
      data: {
        spec: metadata,
        path: changePath,
      },
    };
  }

  // =====================================
  // 阶段转换
  // =====================================

  /**
   * 验证阶段转换是否合法
   */
  canTransitionPhase(currentPhase: SpecPhase, targetPhase: SpecPhase): boolean {
    const allowedTransitions = PHASE_TRANSITIONS[currentPhase];
    return allowedTransitions.includes(targetPhase);
  }

  /**
   * 获取允许的下一阶段
   */
  getAllowedTransitions(currentPhase: SpecPhase): SpecPhase[] {
    return PHASE_TRANSITIONS[currentPhase];
  }

  /**
   * 更新 Spec 阶段（写入文件）
   */
  async updatePhase(
    name: string,
    targetPhase: SpecPhase
  ): Promise<SpecMetadata | null> {
    const fm = this.getFileManager();
    return fm.updatePhase(name, targetPhase);
  }

  // =====================================
  // 任务管理
  // =====================================

  /**
   * 创建新任务对象
   */
  createTask(
    title: string,
    description: string,
    options?: {
      dependencies?: string[];
      affectedFiles?: string[];
      complexity?: TaskComplexity;
    }
  ): SpecTask {
    return {
      id: nanoid(8),
      title,
      description,
      status: 'pending',
      dependencies: options?.dependencies || [],
      affectedFiles: options?.affectedFiles || [],
      complexity: options?.complexity || 'medium',
    };
  }

  /**
   * 保存 Spec 元数据（包含任务更新）
   */
  async saveMetadata(name: string, metadata: SpecMetadata): Promise<void> {
    const fm = this.getFileManager();
    await fm.writeMetadata(name, metadata);
  }

  /**
   * 获取下一个待执行的任务
   */
  getNextTask(tasks: SpecTask[]): SpecTask | null {
    return (
      tasks.find((task) => {
        if (task.status !== 'pending') return false;

        // 检查所有依赖是否已完成
        return task.dependencies.every((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          return dep?.status === 'completed';
        });
      }) || null
    );
  }

  /**
   * 计算任务进度
   */
  getTaskProgress(tasks: SpecTask[]): {
    total: number;
    completed: number;
    percentage: number;
  } {
    if (tasks.length === 0) {
      return { total: 0, completed: 0, percentage: 0 };
    }

    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const percentage = Math.round((completed / total) * 100);

    return { total, completed, percentage };
  }

  // =====================================
  // 列表和搜索
  // =====================================

  /**
   * 列出所有活跃的 Spec 名称
   */
  async listActiveSpecs(): Promise<string[]> {
    const fm = this.getFileManager();
    return fm.listActiveChanges();
  }

  /**
   * 列出所有归档的 Spec 名称
   */
  async listArchivedSpecs(): Promise<string[]> {
    const fm = this.getFileManager();
    return fm.listArchivedChanges();
  }

  // =====================================
  // 归档
  // =====================================

  /**
   * 归档 Spec
   */
  async archiveSpec(name: string): Promise<SpecOperationResult> {
    const fm = this.getFileManager();

    // 合并 Spec deltas 到权威 Specs
    await fm.mergeSpecDeltas(name);

    // 更新阶段为 done
    await fm.updatePhase(name, 'done');

    // 移动到 archive
    await fm.archiveChange(name);

    return {
      success: true,
      message: `Spec "${name}" archived successfully`,
    };
  }

  // =====================================
  // 验证
  // =====================================

  /**
   * 验证 Spec 的完整性
   */
  async validateSpec(spec: SpecMetadata): Promise<SpecValidationResult> {
    const fm = this.getFileManager();
    const issues: SpecValidationResult['issues'] = [];
    const suggestions: string[] = [];

    // 检查各文件是否存在
    const [proposal, specFile, requirements, design, tasks] = await Promise.all([
      fm.readSpecFile(spec.name, 'proposal'),
      fm.readSpecFile(spec.name, 'spec'),
      fm.readSpecFile(spec.name, 'requirements'),
      fm.readSpecFile(spec.name, 'design'),
      fm.readSpecFile(spec.name, 'tasks'),
    ]);

    const completeness = {
      proposal: !!proposal,
      spec: !!specFile,
      requirements: !!requirements,
      design: !!design,
      tasks: !!tasks,
    };

    // 根据阶段检查必要文件
    if (spec.phase === 'requirements' && !completeness.requirements) {
      issues.push({
        severity: 'warning',
        file: 'requirements',
        message: 'Requirements document is missing',
      });
      suggestions.push('Generate requirements using EARS format');
    }

    if (spec.phase === 'design' && !completeness.design) {
      issues.push({
        severity: 'warning',
        file: 'design',
        message: 'Design document is missing',
      });
      suggestions.push('Create architecture diagrams and API contracts');
    }

    if (spec.phase === 'tasks' && spec.tasks.length === 0) {
      issues.push({
        severity: 'warning',
        file: 'tasks',
        message: 'No tasks defined',
      });
      suggestions.push('Break down the spec into atomic tasks');
    }

    if (spec.phase === 'implementation') {
      const progress = this.getTaskProgress(spec.tasks);
      if (progress.completed < progress.total) {
        issues.push({
          severity: 'info',
          file: 'tasks',
          message: `${progress.total - progress.completed} tasks remaining`,
        });
      }
    }

    return {
      valid: issues.filter((i) => i.severity === 'error').length === 0,
      phase: spec.phase,
      completeness,
      issues,
      suggestions,
    };
  }

  // =====================================
  // 私有辅助方法
  // =====================================

  /**
   * 生成 proposal 模板
   */
  private generateProposalTemplate(name: string, description: string): string {
    return `# ${name}

## Summary

${description}

## Background

<!-- Why is this change needed? What problem does it solve? -->

## Goals

<!-- What are the specific objectives of this change? -->

- [ ] Goal 1
- [ ] Goal 2

## Non-Goals

<!-- What is explicitly out of scope? -->

## Risks and Mitigations

<!-- What could go wrong? How will you address it? -->

| Risk | Mitigation |
|------|------------|
| | |

## Open Questions

<!-- What needs to be clarified before proceeding? -->

1.
`;
  }
}
