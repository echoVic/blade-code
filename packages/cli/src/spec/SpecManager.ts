/**
 * Spec 状态管理器
 *
 * 单例模式，管理当前 Spec 会话状态和工作流转换。
 *
 * **SSOT 设计**:
 * - 所有状态存储在 Zustand Store (specSlice)
 * - SpecManager 只是 Store 的操作包装器
 * - 文件操作委托给 SpecFileManager
 */

import { nanoid } from 'nanoid';
import { PermissionMode } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { SpecState } from '../store/slices/specSlice.js';
import { configActions, vanillaStore } from '../store/vanilla.js';
import { SpecFileManager } from './SpecFileManager.js';
import {
  PHASE_TRANSITIONS,
  type SpecListItem,
  type SpecMetadata,
  type SpecOperationResult,
  type SpecPhase,
  type SpecSearchOptions,
  type SpecTask,
  type SpecValidationResult,
  type SteeringContext,
  type TaskComplexity,
  type TaskStatus,
} from './types.js';

const logger = createLogger(LogCategory.SPEC);

/**
 * Spec 管理器
 *
 * 注意：不再维护内部状态，所有状态读写通过 Zustand Store
 */
export class SpecManager {
  private static instance: SpecManager | null = null;
  private fileManager: SpecFileManager | null = null;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): SpecManager {
    if (!SpecManager.instance) {
      SpecManager.instance = new SpecManager();
    }
    return SpecManager.instance;
  }

  /**
   * 重置实例（用于测试）
   */
  static resetInstance(): void {
    SpecManager.instance = null;
  }

  // =====================================
  // Store 访问器（SSOT）
  // =====================================

  /**
   * 获取 Store 中的 Spec 状态
   */
  private getStoreState() {
    return vanillaStore.getState().spec;
  }

  /**
   * 更新 Store 中的 Spec 状态
   */
  private updateStoreState(updates: Partial<SpecState>): void {
    vanillaStore.setState((state) => ({
      spec: {
        ...state.spec,
        ...updates,
      },
    }));
  }

  /**
   * 初始化管理器（幂等，可重复调用）
   */
  async initialize(workspaceRoot: string): Promise<void> {
    // 如果已经初始化过，跳过（幂等性）
    if (this.fileManager) {
      logger.debug('SpecManager already initialized, skipping...');
      return;
    }

    this.fileManager = new SpecFileManager(workspaceRoot);
    await this.fileManager.initializeDirectories();

    // 加载 Steering Context 并更新 Store
    const steeringContext = await this.fileManager.readSteeringContext();
    this.updateStoreState({ steeringContext });

    logger.debug('SpecManager initialized successfully');
  }

  /**
   * 获取文件管理器
   */
  getFileManager(): SpecFileManager {
    if (!this.fileManager) {
      throw new Error('SpecManager not initialized. Call initialize() first.');
    }
    return this.fileManager;
  }

  // =====================================
  // 状态访问（从 Store 读取）
  // =====================================

  /**
   * 获取当前状态
   */
  getState(): SpecState {
    return { ...this.getStoreState() };
  }

  /**
   * 获取当前 Spec
   */
  getCurrentSpec(): SpecMetadata | null {
    return this.getStoreState().currentSpec;
  }

  /**
   * 是否处于 Spec 模式
   */
  isActive(): boolean {
    return this.getStoreState().isActive;
  }

  /**
   * 获取 Steering 上下文
   */
  getSteeringContext(): SteeringContext | null {
    return this.getStoreState().steeringContext;
  }

  /**
   * 获取 Steering 上下文字符串（用于系统提示词）
   */
  async getSteeringContextString(): Promise<string | null> {
    const ctx = this.getStoreState().steeringContext;
    if (!ctx) return null;

    const parts: string[] = [];

    if (ctx.constitution) {
      parts.push(`## Constitution (Project Governance)\n\n${ctx.constitution}`);
    }
    if (ctx.product) {
      parts.push(`## Product Vision\n\n${ctx.product}`);
    }
    if (ctx.tech) {
      parts.push(`## Technology Stack\n\n${ctx.tech}`);
    }
    if (ctx.structure) {
      parts.push(`## Code Structure\n\n${ctx.structure}`);
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  // =====================================
  // Spec 生命周期
  // =====================================

  /**
   * 创建新的 Spec（提案）
   */
  async createSpec(name: string, description: string): Promise<SpecOperationResult> {
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

    // 更新最近使用列表
    const recentSpecs = this.getStoreState().recentSpecs.filter((n) => n !== name);
    recentSpecs.unshift(name);

    // 更新 Store（SSOT）
    this.updateStoreState({
      currentSpec: metadata,
      specPath: changePath,
      isActive: true,
      recentSpecs: recentSpecs.slice(0, 10),
    });

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
   * 加载已有的 Spec
   */
  async loadSpec(name: string): Promise<SpecOperationResult> {
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

    // 更新最近使用列表
    const recentSpecs = this.getStoreState().recentSpecs.filter((n) => n !== name);
    recentSpecs.unshift(name);

    // 更新 Store（SSOT）
    this.updateStoreState({
      currentSpec: metadata,
      specPath: changePath,
      isActive: true,
      recentSpecs: recentSpecs.slice(0, 10),
    });

    return {
      success: true,
      message: `Spec "${name}" loaded successfully`,
      data: {
        spec: metadata,
        path: changePath,
      },
    };
  }

  /**
   * 关闭当前 Spec（不删除）
   */
  closeSpec(): void {
    this.updateStoreState({
      currentSpec: null,
      specPath: null,
      isActive: false,
    });
  }

  /**
   * 退出 Spec 模式
   */
  exitSpecMode(): void {
    this.closeSpec();
  }

  // =====================================
  // 阶段转换
  // =====================================

  /**
   * 转换到下一阶段
   */
  async transitionPhase(targetPhase: SpecPhase): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    // 验证阶段转换是否合法
    const allowedTransitions = PHASE_TRANSITIONS[current.phase];
    if (!allowedTransitions.includes(targetPhase)) {
      return {
        success: false,
        message: `Cannot transition from "${current.phase}" to "${targetPhase}"`,
        error: 'INVALID_TRANSITION',
      };
    }

    // 更新元数据
    const fm = this.getFileManager();
    const updated = await fm.updatePhase(current.name, targetPhase);
    if (!updated) {
      return {
        success: false,
        message: 'Failed to update phase',
        error: 'UPDATE_FAILED',
      };
    }

    // 更新 Store（SSOT）
    this.updateStoreState({
      currentSpec: updated,
    });

    // 完成时自动切换到 DEFAULT 模式
    if (targetPhase === 'done') {
      try {
        await configActions().setPermissionMode(PermissionMode.DEFAULT);
        logger.info('Spec 已完成，已自动退出 Spec 模式');
      } catch (error) {
        logger.error('自动退出 Spec 模式失败:', error);
      }
    }

    return {
      success: true,
      message: `Transitioned to "${targetPhase}" phase`,
      data: {
        spec: updated,
        phase: targetPhase,
      },
    };
  }

  /**
   * 获取当前阶段允许的下一阶段
   */
  getAllowedTransitions(): SpecPhase[] {
    const current = this.getCurrentSpec();
    if (!current) return [];
    return PHASE_TRANSITIONS[current.phase];
  }

  // =====================================
  // 任务管理
  // =====================================

  /**
   * 添加任务
   */
  async addTask(
    title: string,
    description: string,
    options?: {
      dependencies?: string[];
      affectedFiles?: string[];
      complexity?: TaskComplexity;
    }
  ): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const task: SpecTask = {
      id: nanoid(8),
      title,
      description,
      status: 'pending',
      dependencies: options?.dependencies || [],
      affectedFiles: options?.affectedFiles || [],
      complexity: options?.complexity || 'medium',
    };

    const updatedSpec: SpecMetadata = {
      ...current,
      tasks: [...current.tasks, task],
      updatedAt: new Date().toISOString(),
    };

    // 持久化
    await this.getFileManager().writeMetadata(current.name, updatedSpec);

    // 更新 Store（SSOT）
    this.updateStoreState({
      currentSpec: updatedSpec,
    });

    return {
      success: true,
      message: `Task "${title}" added`,
      data: { task },
    };
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus
  ): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const task = current.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        message: `Task "${taskId}" not found`,
        error: 'TASK_NOT_FOUND',
      };
    }

    // 更新任务
    const updatedTask: SpecTask = {
      ...task,
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : task.completedAt,
    };

    const updatedTasks = current.tasks.map((t) => (t.id === taskId ? updatedTask : t));

    const updatedSpec: SpecMetadata = {
      ...current,
      tasks: updatedTasks,
      currentTaskId:
        status === 'in_progress'
          ? taskId
          : current.currentTaskId === taskId
            ? undefined
            : current.currentTaskId,
      updatedAt: new Date().toISOString(),
    };

    // 持久化
    await this.getFileManager().writeMetadata(current.name, updatedSpec);

    // 更新 Store（SSOT）
    this.updateStoreState({
      currentSpec: updatedSpec,
    });

    return {
      success: true,
      message: `Task status updated to "${status}"`,
      data: { task: updatedTask },
    };
  }

  /**
   * 获取下一个待执行的任务
   */
  getNextTask(): SpecTask | null {
    const current = this.getCurrentSpec();
    if (!current) return null;

    // 找到第一个 pending 且依赖都已完成的任务
    return (
      current.tasks.find((task) => {
        if (task.status !== 'pending') return false;

        // 检查所有依赖是否已完成
        return task.dependencies.every((depId) => {
          const dep = current.tasks.find((t) => t.id === depId);
          return dep?.status === 'completed';
        });
      }) || null
    );
  }

  /**
   * 获取任务进度
   */
  getTaskProgress(): { total: number; completed: number; percentage: number } {
    const current = this.getCurrentSpec();
    if (!current || current.tasks.length === 0) {
      return { total: 0, completed: 0, percentage: 0 };
    }

    const total = current.tasks.length;
    const completed = current.tasks.filter((t) => t.status === 'completed').length;
    const percentage = Math.round((completed / total) * 100);

    return { total, completed, percentage };
  }

  // =====================================
  // 列表和搜索
  // =====================================

  /**
   * 列出所有 Specs
   */
  async listSpecs(options?: SpecSearchOptions): Promise<SpecListItem[]> {
    const fm = this.getFileManager();
    const items: SpecListItem[] = [];

    // 获取活跃的变更
    const activeNames = await fm.listActiveChanges();
    for (const name of activeNames) {
      const metadata = await fm.readMetadata(name);
      if (!metadata) continue;

      // 应用过滤器
      if (options?.phase && metadata.phase !== options.phase) continue;
      if (options?.tags && !options.tags.some((tag) => metadata.tags?.includes(tag))) {
        continue;
      }
      if (
        options?.query &&
        !metadata.name.toLowerCase().includes(options.query.toLowerCase()) &&
        !metadata.description.toLowerCase().includes(options.query.toLowerCase())
      ) {
        continue;
      }

      const progress = this.calculateTaskProgress(metadata.tasks);
      items.push({
        name: metadata.name,
        description: metadata.description,
        phase: metadata.phase,
        updatedAt: metadata.updatedAt,
        path: fm.getChangePath(name),
        isArchived: false,
        taskProgress: progress,
      });
    }

    // 获取归档的变更
    if (options?.includeArchived) {
      const archivedNames = await fm.listArchivedChanges();
      for (const name of archivedNames) {
        // 归档的变更需要从 archive 目录读取
        // 简化处理：只显示名称
        items.push({
          name,
          description: '(archived)',
          phase: 'done',
          updatedAt: '',
          path: `${fm.getArchiveDir()}/${name}`,
          isArchived: true,
          taskProgress: { total: 0, completed: 0 },
        });
      }
    }

    // 按更新时间排序
    items.sort((a, b) => {
      if (a.isArchived !== b.isArchived) {
        return a.isArchived ? 1 : -1; // 归档的排在后面
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return items;
  }

  // =====================================
  // 归档
  // =====================================

  /**
   * 归档当前 Spec
   */
  async archiveCurrentSpec(): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const fm = this.getFileManager();

    // 合并 Spec deltas 到权威 Specs
    const _mergedDomains = await fm.mergeSpecDeltas(current.name);

    // 更新阶段为 done
    await fm.updatePhase(current.name, 'done');

    // 移动到 archive
    await fm.archiveChange(current.name);

    // 清除当前状态（更新 Store）
    this.closeSpec();

    return {
      success: true,
      message: `Spec "${current.name}" archived successfully`,
      data: {
        spec: { ...current, phase: 'done' },
      },
    };
  }

  // =====================================
  // 验证
  // =====================================

  /**
   * 验证当前 Spec 的完整性
   */
  async validateCurrentSpec(): Promise<SpecValidationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        valid: false,
        phase: 'init',
        completeness: {
          proposal: false,
          spec: false,
          requirements: false,
          design: false,
          tasks: false,
        },
        issues: [{ severity: 'error', file: 'meta', message: 'No active spec' }],
        suggestions: ['Create a new spec with /spec proposal <name>'],
      };
    }

    const fm = this.getFileManager();
    const issues: SpecValidationResult['issues'] = [];
    const suggestions: string[] = [];

    // 检查各文件是否存在
    const [proposal, spec, requirements, design, tasks] = await Promise.all([
      fm.readSpecFile(current.name, 'proposal'),
      fm.readSpecFile(current.name, 'spec'),
      fm.readSpecFile(current.name, 'requirements'),
      fm.readSpecFile(current.name, 'design'),
      fm.readSpecFile(current.name, 'tasks'),
    ]);

    const completeness = {
      proposal: !!proposal,
      spec: !!spec,
      requirements: !!requirements,
      design: !!design,
      tasks: !!tasks,
    };

    // 根据阶段检查必要文件
    if (current.phase === 'requirements' && !completeness.requirements) {
      issues.push({
        severity: 'warning',
        file: 'requirements',
        message: 'Requirements document is missing',
      });
      suggestions.push('Generate requirements using EARS format');
    }

    if (current.phase === 'design' && !completeness.design) {
      issues.push({
        severity: 'warning',
        file: 'design',
        message: 'Design document is missing',
      });
      suggestions.push('Create architecture diagrams and API contracts');
    }

    if (current.phase === 'tasks' && current.tasks.length === 0) {
      issues.push({
        severity: 'warning',
        file: 'tasks',
        message: 'No tasks defined',
      });
      suggestions.push('Break down the spec into atomic tasks');
    }

    if (current.phase === 'implementation') {
      const progress = this.getTaskProgress();
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
      phase: current.phase,
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

  /**
   * 计算任务进度
   */
  private calculateTaskProgress(tasks: SpecTask[]): {
    total: number;
    completed: number;
  } {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    return { total, completed };
  }
}
