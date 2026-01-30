import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { TodoItem, TodoStatus, ValidationResult } from './types.js';
import type { NodeError } from '../../types/index.js';

/**
 * TODO 任务管理器
 * 负责管理会话级别的 TODO 列表，支持持久化存储和状态验证
 */
export class TodoManager {
  private static instances = new Map<string, TodoManager>();
  private todos: TodoItem[] = [];
  private filePath: string;
  private loaded = false;

  private constructor(sessionId: string, configDir: string) {
    this.filePath = path.join(
      configDir,
      'todos',
      `${sessionId}-agent-${sessionId}.json`
    );
  }

  /**
   * 获取 TodoManager 实例（单例模式，按会话隔离）
   */
  static getInstance(sessionId: string, configDir: string): TodoManager {
    const key = `${sessionId}-${configDir}`;
    if (!TodoManager.instances.has(key)) {
      TodoManager.instances.set(key, new TodoManager(sessionId, configDir));
    }
    return TodoManager.instances.get(key)!;
  }

  /**
   * 验证 TODO 列表
   * 规则：同时只能有一个任务处于 in_progress 状态
   */
  validate(todos: TodoItem[]): ValidationResult {
    const inProgress = todos.filter((t) => t.status === 'in_progress').length;

    if (inProgress > 1) {
      return {
        valid: false,
        error: '同时只能有一个任务处于 in_progress 状态',
      };
    }

    return { valid: true };
  }

  /**
   * 更新 TODO 列表
   */
  async updateTodos(
    newTodos: Array<
      Partial<TodoItem> & Pick<TodoItem, 'content' | 'status' | 'activeForm'>
    >
  ): Promise<void> {
    await this.ensureLoaded();

    const now = new Date().toISOString();

    const processed: TodoItem[] = newTodos.map((todo) => {
      const todoWithId = todo as Partial<TodoItem>;
      const existing = this.todos.find(
        (t) => t.id === todoWithId.id || t.content === todo.content
      );

      return {
        ...todo,
        id: todoWithId.id || existing?.id || randomUUID(),
        priority: todo.priority || existing?.priority || 'medium',
        createdAt: existing?.createdAt || now,
        startedAt:
          todo.status === 'in_progress' && !existing?.startedAt
            ? now
            : existing?.startedAt,
        completedAt:
          todo.status === 'completed' && !existing?.completedAt
            ? now
            : existing?.completedAt,
      } as TodoItem;
    });

    const validation = this.validate(processed);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    this.todos = processed;
    await this.saveTodos();
  }

  /**
   * 获取排序后的 TODO 列表
   * 排序规则：
   * 1. 按状态：completed < in_progress < pending
   * 2. 按优先级：high < medium < low
   */
  getSortedTodos(): TodoItem[] {
    const statusOrder: Record<TodoStatus, number> = {
      completed: 0,
      in_progress: 1,
      pending: 2,
    };

    const priorityOrder = { high: 0, medium: 1, low: 2 };

    return [...this.todos].sort((a, b) => {
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;

      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * 获取 TODO 列表（已排序）
   */
  getTodos(): TodoItem[] {
    return this.getSortedTodos();
  }

  /**
   * 确保已加载数据
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadTodos();
      this.loaded = true;
    }
  }

  /**
   * 从文件加载 TODO 列表
   */
  private async loadTodos(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.todos = JSON.parse(data);
    } catch (error) {
      const nodeError = error as NodeError;
      if (nodeError.code === 'ENOENT') {
        this.todos = [];
      } else {
        console.warn('加载 TODO 列表失败:', error);
        this.todos = [];
      }
    }
  }

  /**
   * 保存 TODO 列表到文件
   */
  private async saveTodos(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
      await fs.writeFile(this.filePath, JSON.stringify(this.todos, null, 2), 'utf-8');
    } catch (error) {
      console.error('保存 TODO 列表失败:', error);
      throw error;
    }
  }
}
