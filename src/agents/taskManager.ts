/**
 * Blade Subagent System - Task Manager
 *
 * 管理 Subagent 任务的生命周期、持久化和并发控制
 */

import { nanoid } from 'nanoid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SubagentExecutor } from './executor.js';
import type { PersistedTask, SubagentResult, TaskStatus } from './types.js';
import { ConcurrentLimitError } from './types.js';

/**
 * Subagent 任务管理器
 *
 * 负责:
 * 1. 任务创建和状态跟踪
 * 2. 任务持久化（JSONL 格式）
 * 3. 并发控制（最多 5 个同时运行的任务）
 * 4. 任务查询和历史管理
 */
export class SubagentTaskManager {
  /** 内存中的任务映射 */
  private tasks = new Map<string, PersistedTask>();

  /** 当前运行的任务数 */
  private runningCount = 0;

  /** 最大并发数 */
  private readonly MAX_CONCURRENT = 5;

  /** 任务存储目录 */
  private readonly tasksDir: string;

  /** 任务日志文件（JSONL） */
  private readonly tasksLog: string;

  constructor(dataDir: string) {
    this.tasksDir = path.join(dataDir, 'subagent-tasks');
    this.tasksLog = path.join(this.tasksDir, 'tasks.jsonl');

    // 确保目录存在
    this.ensureDirectory();

    // 加载已有任务
    this.loadTasks();
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  /**
   * 从磁盘加载任务历史
   */
  private loadTasks(): void {
    if (!fs.existsSync(this.tasksLog)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.tasksLog, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        try {
          const task: PersistedTask = JSON.parse(line);
          this.tasks.set(task.id, task);

          // 恢复运行计数（如果任务状态为 running）
          if (task.status === 'running') {
            // 任务意外中断，标记为 failed
            task.status = 'failed';
            task.error = 'Task interrupted (system restart)';
            task.completedAt = Date.now();
          }
        } catch (error) {
          console.error('Failed to parse task line:', error);
        }
      }

      console.log(`Loaded ${this.tasks.size} task(s) from history`);
    } catch (error) {
      console.error('Failed to load tasks:', error);
    }
  }

  /**
   * 持久化任务到磁盘
   */
  private persistTask(task: PersistedTask): void {
    try {
      // 追加到 JSONL
      const line = JSON.stringify(task) + '\n';
      fs.appendFileSync(this.tasksLog, line, 'utf-8');

      // 如果任务完成且有结果，保存详细结果到单独文件
      if (task.result && (task.status === 'completed' || task.status === 'failed')) {
        const resultPath = path.join(this.tasksDir, `${task.id}.json`);
        fs.writeFileSync(resultPath, JSON.stringify(task.result, null, 2), 'utf-8');
      }
    } catch (error) {
      console.error('Failed to persist task:', error);
    }
  }

  /**
   * 创建新任务
   *
   * @param agentName Subagent 名称
   * @param params 输入参数
   * @returns 任务 ID
   */
  createTask(agentName: string, params: Record<string, unknown>): string {
    const taskId = nanoid();
    const task: PersistedTask = {
      id: taskId,
      status: 'pending',
      agentName,
      params,
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.persistTask(task);

    return taskId;
  }

  /**
   * 检查是否可以运行新任务
   */
  canRunTask(): boolean {
    return this.runningCount < this.MAX_CONCURRENT;
  }

  /**
   * 获取当前运行的任务数
   */
  getRunningCount(): number {
    return this.runningCount;
  }

  /**
   * 执行任务（同步模式）
   *
   * @param taskId 任务 ID
   * @param executor Subagent 执行器
   * @param signal AbortSignal（可选）
   * @returns SubagentResult
   * @throws ConcurrentLimitError 如果超出并发限制
   */
  async executeTask(
    taskId: string,
    executor: SubagentExecutor,
    signal?: AbortSignal
  ): Promise<SubagentResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 检查并发限制
    if (!this.canRunTask()) {
      throw new ConcurrentLimitError(
        `Concurrent limit reached (${this.MAX_CONCURRENT}). Consider using background mode.`
      );
    }

    // 更新状态为 running
    this.runningCount++;
    task.status = 'running';
    task.startedAt = Date.now();
    this.persistTask(task);

    try {
      // 执行 subagent
      const result = await executor.execute(task.params, { signal });

      // 更新任务结果
      task.result = result;
      task.status = result.terminateReason === 'GOAL' ? 'completed' : 'failed';
      task.completedAt = Date.now();
      task.tokenUsage = result.tokenUsage;

      this.persistTask(task);

      return result;
    } catch (error) {
      // 处理错误
      task.status = 'failed';
      task.error = (error as Error).message;
      task.completedAt = Date.now();
      this.persistTask(task);

      throw error;
    } finally {
      this.runningCount--;
    }
  }

  /**
   * 执行任务（后台模式）
   *
   * 不阻塞，异步执行
   *
   * @param taskId 任务 ID
   * @param executor Subagent 执行器
   */
  async executeTaskInBackground(
    taskId: string,
    executor: SubagentExecutor
  ): Promise<void> {
    // 异步执行，不阻塞
    this.executeTask(taskId, executor).catch((error) => {
      console.error(`Background task ${taskId} failed:`, error);
    });
  }

  /**
   * 获取任务
   *
   * @param taskId 任务 ID
   * @returns PersistedTask 或 undefined
   */
  getTask(taskId: string): PersistedTask | undefined {
    const task = this.tasks.get(taskId);

    // 如果任务有详细结果文件，尝试加载
    if (
      task &&
      !task.result &&
      task.status !== 'pending' &&
      task.status !== 'running'
    ) {
      const resultPath = path.join(this.tasksDir, `${taskId}.json`);
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          task.result = result;
        } catch (error) {
          console.error(`Failed to load result for task ${taskId}:`, error);
        }
      }
    }

    return task;
  }

  /**
   * 列出任务
   *
   * @param filter 过滤条件
   * @returns PersistedTask 数组
   */
  listTasks(filter?: {
    status?: TaskStatus;
    agentName?: string;
    limit?: number;
  }): PersistedTask[] {
    let tasks = Array.from(this.tasks.values());

    // 按状态过滤
    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }

    // 按 agent 名称过滤
    if (filter?.agentName) {
      tasks = tasks.filter((t) => t.agentName === filter.agentName);
    }

    // 按创建时间倒序排序（最新的在前）
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    // 限制数量
    if (filter?.limit && filter.limit > 0) {
      tasks = tasks.slice(0, filter.limit);
    }

    return tasks;
  }

  /**
   * 取消任务
   *
   * @param taskId 任务 ID
   * @returns 是否成功取消
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);

    if (!task) {
      return false;
    }

    // 只能取消 pending 或 running 状态的任务
    if (task.status !== 'pending' && task.status !== 'running') {
      return false;
    }

    // 更新状态
    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.persistTask(task);

    // 如果是 running 状态，减少计数
    if (task.status === 'running') {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }

    return true;
  }

  /**
   * 清理已完成的任务
   *
   * @param olderThanMs 清理多久之前的任务（毫秒），默认 1 小时
   * @returns 清理的任务数
   */
  cleanup(olderThanMs = 3600000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, task] of this.tasks.entries()) {
      // 只清理已完成的任务
      if (!task.completedAt) {
        continue;
      }

      if (now - task.completedAt > olderThanMs) {
        this.tasks.delete(id);

        // 删除详细结果文件
        const resultPath = path.join(this.tasksDir, `${id}.json`);
        if (fs.existsSync(resultPath)) {
          try {
            fs.unlinkSync(resultPath);
          } catch (error) {
            console.error(`Failed to delete result file for task ${id}:`, error);
          }
        }

        cleaned++;
      }
    }

    // 如果清理了任务，重写日志文件
    if (cleaned > 0) {
      this.rewriteLogFile();
    }

    return cleaned;
  }

  /**
   * 重写日志文件
   *
   * 移除已删除的任务记录
   */
  private rewriteLogFile(): void {
    try {
      const lines = Array.from(this.tasks.values())
        .map((task) => JSON.stringify(task))
        .join('\n');

      fs.writeFileSync(this.tasksLog, lines + '\n', 'utf-8');
    } catch (error) {
      console.error('Failed to rewrite log file:', error);
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byStatus: Record<TaskStatus, number>;
    byAgent: Record<string, number>;
    running: number;
  } {
    const stats = {
      total: this.tasks.size,
      byStatus: {} as Record<TaskStatus, number>,
      byAgent: {} as Record<string, number>,
      running: this.runningCount,
    };

    for (const task of this.tasks.values()) {
      // 按状态统计
      stats.byStatus[task.status] = (stats.byStatus[task.status] || 0) + 1;

      // 按 agent 统计
      stats.byAgent[task.agentName] = (stats.byAgent[task.agentName] || 0) + 1;
    }

    return stats;
  }

  /**
   * 清空所有任务（谨慎使用！）
   */
  clear(): void {
    this.tasks.clear();
    this.runningCount = 0;

    // 删除日志文件
    if (fs.existsSync(this.tasksLog)) {
      fs.unlinkSync(this.tasksLog);
    }

    // 删除所有结果文件
    if (fs.existsSync(this.tasksDir)) {
      const files = fs.readdirSync(this.tasksDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(this.tasksDir, file));
        }
      }
    }
  }
}

/**
 * 创建任务管理器
 *
 * @param dataDir 数据目录
 * @returns SubagentTaskManager 实例
 */
export function createTaskManager(dataDir: string): SubagentTaskManager {
  return new SubagentTaskManager(dataDir);
}
