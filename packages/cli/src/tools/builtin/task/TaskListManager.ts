import * as fs from 'fs/promises';
import * as path from 'path';
import type { NodeError } from '../../types/index.js';
import type { TaskListItem, TaskStats, TaskStatus } from './taskListTypes.js';
import { TaskListItemSchema } from './taskListTypes.js';

interface TaskListFile {
  nextId: number;
  tasks: TaskListItem[];
}

export class TaskListManager {
  private static instances = new Map<string, TaskListManager>();
  private tasks: TaskListItem[] = [];
  private nextId = 1;
  private loaded = false;
  private readonly filePath: string;

  private constructor(sessionId: string, configDir: string) {
    this.filePath = path.join(
      configDir,
      'tasks',
      `${sessionId}-agent-${sessionId}.json`
    );
  }

  static getInstance(sessionId: string, configDir: string): TaskListManager {
    const key = `${sessionId}-${configDir}`;
    if (!TaskListManager.instances.has(key)) {
      TaskListManager.instances.set(key, new TaskListManager(sessionId, configDir));
    }
    return TaskListManager.instances.get(key)!;
  }

  async createTask(input: {
    subject: string;
    description: string;
    activeForm?: string;
    owner?: string;
    priority?: TaskListItem['priority'];
    metadata?: Record<string, unknown>;
  }): Promise<TaskListItem> {
    await this.ensureLoaded();

    const now = new Date().toISOString();
    const task: TaskListItem = {
      id: String(this.nextId),
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      owner: input.owner,
      priority: input.priority || 'medium',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
      createdAt: now,
    };

    this.nextId += 1;
    this.tasks = [...this.tasks, task];
    await this.saveTasks();
    return task;
  }

  async getTask(taskId: string): Promise<TaskListItem | null> {
    await this.ensureLoaded();
    return this.tasks.find((task) => task.id === taskId) || null;
  }

  async listTasks(): Promise<TaskListItem[]> {
    await this.ensureLoaded();
    return this.getSortedTasks();
  }

  async updateTask(
    taskId: string,
    updates: {
      subject?: string;
      description?: string;
      activeForm?: string;
      status?: TaskStatus;
      owner?: string;
      addBlocks?: string[];
      addBlockedBy?: string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<{
    task: TaskListItem | null;
    updatedFields: string[];
    statusChange?: { from: TaskStatus; to: TaskStatus };
  }> {
    await this.ensureLoaded();

    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) {
      return { task: null, updatedFields: [] };
    }

    const existing = this.tasks[index]!;
    const updatedFields: string[] = [];
    const next: TaskListItem = { ...existing };

    if (updates.subject !== undefined && updates.subject !== existing.subject) {
      next.subject = updates.subject;
      updatedFields.push('subject');
    }
    if (
      updates.description !== undefined &&
      updates.description !== existing.description
    ) {
      next.description = updates.description;
      updatedFields.push('description');
    }
    if (
      updates.activeForm !== undefined &&
      updates.activeForm !== existing.activeForm
    ) {
      next.activeForm = updates.activeForm;
      updatedFields.push('activeForm');
    }
    if (updates.owner !== undefined && updates.owner !== existing.owner) {
      next.owner = updates.owner;
      updatedFields.push('owner');
    }
    if (updates.metadata !== undefined) {
      next.metadata = mergeMetadata(existing.metadata, updates.metadata);
      updatedFields.push('metadata');
    }

    let statusChange: { from: TaskStatus; to: TaskStatus } | undefined;
    if (updates.status !== undefined && updates.status !== existing.status) {
      next.status = updates.status;
      if (updates.status === 'in_progress' && !existing.startedAt) {
        next.startedAt = new Date().toISOString();
      }
      if (updates.status === 'completed' && !existing.completedAt) {
        next.completedAt = new Date().toISOString();
      }
      statusChange = { from: existing.status, to: updates.status };
      updatedFields.push('status');
    }

    if (updates.addBlocks && updates.addBlocks.length > 0) {
      next.blocks = unique([...existing.blocks, ...updates.addBlocks]);
      if (next.blocks.length !== existing.blocks.length) {
        updatedFields.push('blocks');
      }
    }
    if (updates.addBlockedBy && updates.addBlockedBy.length > 0) {
      next.blockedBy = unique([...existing.blockedBy, ...updates.addBlockedBy]);
      if (next.blockedBy.length !== existing.blockedBy.length) {
        updatedFields.push('blockedBy');
      }
    }

    this.tasks = this.tasks.map((task) => (task.id === taskId ? next : task));
    await this.syncDependencyEdges(next, updates.addBlocks, updates.addBlockedBy);
    await this.saveTasks();
    return { task: next, updatedFields, statusChange };
  }

  async deleteTask(taskId: string): Promise<boolean> {
    await this.ensureLoaded();

    const before = this.tasks.length;
    this.tasks = this.tasks
      .filter((task) => task.id !== taskId)
      .map((task) => ({
        ...task,
        blocks: task.blocks.filter((id) => id !== taskId),
        blockedBy: task.blockedBy.filter((id) => id !== taskId),
      }));

    if (this.tasks.length === before) {
      return false;
    }

    await this.saveTasks();
    return true;
  }

  getStats(): TaskStats {
    return {
      total: this.tasks.length,
      completed: this.tasks.filter((task) => task.status === 'completed').length,
      inProgress: this.tasks.filter((task) => task.status === 'in_progress').length,
      pending: this.tasks.filter((task) => task.status === 'pending').length,
    };
  }

  private getSortedTasks(): TaskListItem[] {
    const statusOrder: Record<TaskStatus, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
    };
    const priorityOrder: Record<TaskListItem['priority'], number> = {
      high: 0,
      medium: 1,
      low: 2,
    };

    return [...this.tasks].sort((a, b) => {
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return Number(a.id) - Number(b.id);
    });
  }

  private async syncDependencyEdges(
    task: TaskListItem,
    addBlocks?: string[],
    addBlockedBy?: string[]
  ): Promise<void> {
    for (const blockedTaskId of addBlocks || []) {
      this.tasks = this.tasks.map((candidate) =>
        candidate.id === blockedTaskId
          ? { ...candidate, blockedBy: unique([...candidate.blockedBy, task.id]) }
          : candidate
      );
    }

    for (const blockerTaskId of addBlockedBy || []) {
      this.tasks = this.tasks.map((candidate) =>
        candidate.id === blockerTaskId
          ? { ...candidate, blocks: unique([...candidate.blocks, task.id]) }
          : candidate
      );
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadTasks();
      this.loaded = true;
    }
  }

  private async loadTasks(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown;
      const file = normalizeTaskFile(data);
      this.tasks = file.tasks;
      this.nextId = file.nextId;
    } catch (error) {
      const nodeError = error as NodeError;
      if (nodeError.code !== 'ENOENT') {
        console.warn('加载任务列表失败:', error);
      }
      this.tasks = [];
      this.nextId = 1;
    }
  }

  private async saveTasks(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
    const payload: TaskListFile = {
      nextId: this.nextId,
      tasks: this.tasks,
    };
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }
}

function normalizeTaskFile(data: unknown): TaskListFile {
  const rawTasks =
    data && typeof data === 'object' && Array.isArray((data as TaskListFile).tasks)
      ? (data as TaskListFile).tasks
      : Array.isArray(data)
        ? data
        : [];

  const tasks = rawTasks
    .map((task) => TaskListItemSchema.safeParse(task))
    .filter((result): result is { success: true; data: TaskListItem } => result.success)
    .map((result) => result.data);

  const nextIdFromData =
    data &&
    typeof data === 'object' &&
    typeof (data as TaskListFile).nextId === 'number'
      ? (data as TaskListFile).nextId
      : undefined;
  const highestTaskId = tasks.reduce((highest, task) => {
    const numericId = Number(task.id);
    return Number.isFinite(numericId) ? Math.max(highest, numericId) : highest;
  }, 0);

  return {
    tasks,
    nextId: Math.max(nextIdFromData || 1, highestTaskId + 1),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
