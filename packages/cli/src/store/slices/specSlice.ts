/**
 * Spec Slice - Spec-Driven Development 状态管理
 *
 * 职责：
 * - 作为 SSOT（单一信息源）管理所有 Spec 状态
 * - 调用 SpecService 进行文件 I/O
 * - 提供完整的业务逻辑方法
 */

import type { StateCreator } from 'zustand';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { SpecService } from '../../spec/SpecService.js';
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
} from '../../spec/types.js';
import type { BladeStore } from '../types.js';

const logger = createLogger(LogCategory.SPEC);

/**
 * Spec 状态
 */
export interface SpecState {
  /** 当前活跃的 Spec */
  currentSpec: SpecMetadata | null;
  /** Spec 文件路径 */
  specPath: string | null;
  /** 是否处于 Spec 模式 */
  isActive: boolean;
  /** Steering 上下文（缓存） */
  steeringContext: SteeringContext | null;
  /** 最近使用的 Spec 列表 */
  recentSpecs: string[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 工作区根目录 */
  workspaceRoot: string | null;
}

/**
 * Spec Actions - 完整业务逻辑
 */
export interface SpecActions {
  // ===== 初始化 =====
  /** 初始化 Spec 服务 */
  initialize: (workspaceRoot: string) => Promise<void>;

  // ===== Spec 生命周期 =====
  /** 创建新的 Spec */
  createSpec: (name: string, description: string) => Promise<SpecOperationResult>;
  /** 加载已有的 Spec */
  loadSpec: (name: string) => Promise<SpecOperationResult>;
  /** 关闭当前 Spec */
  closeSpec: () => void;
  /** 退出 Spec 模式 */
  exitSpecMode: () => void;

  // ===== 阶段转换 =====
  /** 转换到下一阶段 */
  transitionPhase: (targetPhase: SpecPhase) => Promise<SpecOperationResult>;
  /** 获取允许的下一阶段 */
  getAllowedTransitions: () => SpecPhase[];

  // ===== 任务管理 =====
  /** 添加任务 */
  addTask: (
    title: string,
    description: string,
    options?: {
      dependencies?: string[];
      affectedFiles?: string[];
      complexity?: TaskComplexity;
    }
  ) => Promise<SpecOperationResult>;
  /** 更新任务状态 */
  updateTaskStatus: (
    taskId: string,
    status: TaskStatus
  ) => Promise<SpecOperationResult>;
  /** 获取下一个待执行任务 */
  getNextTask: () => SpecTask | null;
  /** 获取任务进度 */
  getTaskProgress: () => { total: number; completed: number; percentage: number };

  // ===== 列表和搜索 =====
  /** 列出所有 Specs */
  listSpecs: (options?: SpecSearchOptions) => Promise<SpecListItem[]>;

  // ===== 归档 =====
  /** 归档当前 Spec */
  archiveCurrentSpec: () => Promise<SpecOperationResult>;

  // ===== 验证 =====
  /** 验证当前 Spec */
  validateCurrentSpec: () => Promise<SpecValidationResult>;

  // ===== Steering =====
  /** 获取 Steering 上下文字符串 */
  getSteeringContextString: () => Promise<string | null>;

  // ===== 辅助方法 =====
  /** 设置错误 */
  setError: (error: string | null) => void;
  /** 设置加载状态 */
  setLoading: (isLoading: boolean) => void;
  /** 重置状态 */
  reset: () => void;
}

/**
 * Spec Slice 类型
 */
export interface SpecSlice extends SpecState {
  actions: SpecActions;
}

/**
 * 初始状态
 */
const initialSpecState: SpecState = {
  currentSpec: null,
  specPath: null,
  isActive: false,
  steeringContext: null,
  recentSpecs: [],
  isLoading: false,
  error: null,
  workspaceRoot: null,
};

/**
 * 创建 Spec Slice
 */
export const createSpecSlice: StateCreator<BladeStore, [], [], SpecSlice> = (
  set,
  get
) => ({
  ...initialSpecState,

  actions: {
    // ===== 初始化 =====

    initialize: async (workspaceRoot: string) => {
      const service = SpecService.getInstance();
      await service.initialize(workspaceRoot);

      const steeringContext = await service.readSteeringContext();

      set((state) => ({
        spec: {
          ...state.spec,
          workspaceRoot,
          steeringContext,
        },
      }));
    },

    // ===== Spec 生命周期 =====

    createSpec: async (name: string, description: string) => {
      const service = SpecService.getInstance();
      const result = await service.createSpec(name, description);

      if (result.success && result.data) {
        const { spec, path } = result.data;

        // 更新最近使用列表
        const recentSpecs = get().spec.recentSpecs.filter((n) => n !== name);
        recentSpecs.unshift(name);

        set((state) => ({
          spec: {
            ...state.spec,
            currentSpec: spec,
            specPath: path,
            isActive: true,
            recentSpecs: recentSpecs.slice(0, 10),
          },
        }));
      }

      return result;
    },

    loadSpec: async (name: string) => {
      const service = SpecService.getInstance();
      const result = await service.loadSpec(name);

      if (result.success && result.data) {
        const { spec, path } = result.data;

        // 更新最近使用列表
        const recentSpecs = get().spec.recentSpecs.filter((n) => n !== name);
        recentSpecs.unshift(name);

        set((state) => ({
          spec: {
            ...state.spec,
            currentSpec: spec,
            specPath: path,
            isActive: true,
            recentSpecs: recentSpecs.slice(0, 10),
          },
        }));
      }

      return result;
    },

    closeSpec: () => {
      set((state) => ({
        spec: {
          ...state.spec,
          currentSpec: null,
          specPath: null,
          isActive: false,
        },
      }));
    },

    exitSpecMode: () => {
      get().spec.actions.closeSpec();
    },

    // ===== 阶段转换 =====

    transitionPhase: async (targetPhase: SpecPhase) => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) {
        return {
          success: false,
          message: 'No active spec',
          error: 'NO_ACTIVE_SPEC',
        };
      }

      const service = SpecService.getInstance();

      // 验证阶段转换是否合法
      if (!service.canTransitionPhase(currentSpec.phase, targetPhase)) {
        return {
          success: false,
          message: `Cannot transition from "${currentSpec.phase}" to "${targetPhase}"`,
          error: 'INVALID_TRANSITION',
        };
      }

      // 更新文件
      const updated = await service.updatePhase(currentSpec.name, targetPhase);
      if (!updated) {
        return {
          success: false,
          message: 'Failed to update phase',
          error: 'UPDATE_FAILED',
        };
      }

      // 更新 Store
      set((state) => ({
        spec: {
          ...state.spec,
          currentSpec: updated,
        },
      }));

      // 完成时自动切换到 DEFAULT 模式
      if (targetPhase === 'done') {
        try {
          const { config } = get();
          if (config.actions) {
            config.actions.updateConfig({ permissionMode: PermissionMode.DEFAULT });
          }
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
    },

    getAllowedTransitions: () => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) return [];
      return PHASE_TRANSITIONS[currentSpec.phase];
    },

    // ===== 任务管理 =====

    addTask: async (title, description, options) => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) {
        return {
          success: false,
          message: 'No active spec',
          error: 'NO_ACTIVE_SPEC',
        };
      }

      const service = SpecService.getInstance();
      const task = service.createTask(title, description, options);

      // 更新内存状态
      const updatedSpec: SpecMetadata = {
        ...currentSpec,
        tasks: [...currentSpec.tasks, task],
        updatedAt: new Date().toISOString(),
      };

      // 保存到文件
      await service.saveMetadata(currentSpec.name, updatedSpec);

      // 更新 Store
      set((state) => ({
        spec: {
          ...state.spec,
          currentSpec: updatedSpec,
        },
      }));

      return {
        success: true,
        message: `Task "${title}" added`,
        data: { task },
      };
    },

    updateTaskStatus: async (taskId: string, status: TaskStatus) => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) {
        return {
          success: false,
          message: 'No active spec',
          error: 'NO_ACTIVE_SPEC',
        };
      }

      const task = currentSpec.tasks.find((t) => t.id === taskId);
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
        completedAt:
          status === 'completed' ? new Date().toISOString() : task.completedAt,
      };

      const updatedTasks = currentSpec.tasks.map((t) =>
        t.id === taskId ? updatedTask : t
      );

      const updatedSpec: SpecMetadata = {
        ...currentSpec,
        tasks: updatedTasks,
        currentTaskId:
          status === 'in_progress'
            ? taskId
            : currentSpec.currentTaskId === taskId
              ? undefined
              : currentSpec.currentTaskId,
        updatedAt: new Date().toISOString(),
      };

      // 保存到文件
      const service = SpecService.getInstance();
      await service.saveMetadata(currentSpec.name, updatedSpec);

      // 更新 Store
      set((state) => ({
        spec: {
          ...state.spec,
          currentSpec: updatedSpec,
        },
      }));

      return {
        success: true,
        message: `Task status updated to "${status}"`,
        data: { task: updatedTask },
      };
    },

    getNextTask: () => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) return null;

      const service = SpecService.getInstance();
      return service.getNextTask(currentSpec.tasks);
    },

    getTaskProgress: () => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) {
        return { total: 0, completed: 0, percentage: 0 };
      }

      const service = SpecService.getInstance();
      return service.getTaskProgress(currentSpec.tasks);
    },

    // ===== 列表和搜索 =====

    listSpecs: async (options?: SpecSearchOptions) => {
      const service = SpecService.getInstance();
      const items: SpecListItem[] = [];

      // 获取活跃的变更
      const activeNames = await service.listActiveSpecs();
      for (const name of activeNames) {
        const metadata = await service.readSpecMetadata(name);
        if (!metadata) continue;

        // 应用过滤器
        if (options?.phase && metadata.phase !== options.phase) continue;
        if (
          options?.tags &&
          !options.tags.some((tag) => metadata.tags?.includes(tag))
        ) {
          continue;
        }
        if (
          options?.query &&
          !metadata.name.toLowerCase().includes(options.query.toLowerCase()) &&
          !metadata.description.toLowerCase().includes(options.query.toLowerCase())
        ) {
          continue;
        }

        const progress = service.getTaskProgress(metadata.tasks);
        items.push({
          name: metadata.name,
          description: metadata.description,
          phase: metadata.phase,
          updatedAt: metadata.updatedAt,
          path: service.getSpecPath(name),
          isArchived: false,
          taskProgress: { total: progress.total, completed: progress.completed },
        });
      }

      // 获取归档的变更
      if (options?.includeArchived) {
        const archivedNames = await service.listArchivedSpecs();
        for (const name of archivedNames) {
          items.push({
            name,
            description: '(archived)',
            phase: 'done',
            updatedAt: '',
            path: `archive/${name}`,
            isArchived: true,
            taskProgress: { total: 0, completed: 0 },
          });
        }
      }

      // 按更新时间排序
      items.sort((a, b) => {
        if (a.isArchived !== b.isArchived) {
          return a.isArchived ? 1 : -1;
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });

      return items;
    },

    // ===== 归档 =====

    archiveCurrentSpec: async () => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) {
        return {
          success: false,
          message: 'No active spec',
          error: 'NO_ACTIVE_SPEC',
        };
      }

      const service = SpecService.getInstance();
      const result = await service.archiveSpec(currentSpec.name);

      if (result.success) {
        // 清除当前状态
        get().spec.actions.closeSpec();
      }

      return result;
    },

    // ===== 验证 =====

    validateCurrentSpec: async () => {
      const currentSpec = get().spec.currentSpec;
      if (!currentSpec) {
        return {
          valid: false,
          phase: 'init' as SpecPhase,
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

      const service = SpecService.getInstance();
      return service.validateSpec(currentSpec);
    },

    // ===== Steering =====

    getSteeringContextString: async () => {
      const ctx = get().spec.steeringContext;
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
    },

    // ===== 辅助方法 =====

    setError: (error: string | null) => {
      set((state) => ({
        spec: { ...state.spec, error },
      }));
    },

    setLoading: (isLoading: boolean) => {
      set((state) => ({
        spec: { ...state.spec, isLoading },
      }));
    },

    reset: () => {
      set((state) => ({
        spec: { ...initialSpecState, actions: state.spec.actions },
      }));
    },
  },
});
