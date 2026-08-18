import { createHash } from 'node:crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { safeParseSchema } from '../../../schema/index.js';
import { KeyedMutexRegistry } from '../../../utils/KeyedMutexRegistry.js';
import type { NodeError } from '../../types/index.js';
import { withTaskListFileLock } from './TaskListFileLock.js';
import type { TaskListItem, TaskStats, TaskStatus } from './taskListTypes.js';
import { TaskListItemSchema } from './taskListTypes.js';

interface TaskListFile {
  nextId: number;
  tasks: TaskListItem[];
}

interface TaskListUpdateResult {
  task: TaskListItem | null;
  updatedFields: string[];
  statusChange?: { from: TaskStatus; to: TaskStatus };
}

export class TaskListManager {
  private static readonly operations = new KeyedMutexRegistry<string>();
  private tasks: TaskListItem[] = [];
  private readonly filePath: string;

  private constructor(taskListId: string, configDir: string) {
    this.filePath = path.join(
      path.resolve(configDir),
      'tasks',
      taskListFileName(taskListId)
    );
  }

  static getInstance(taskListId: string, configDir: string): TaskListManager {
    return new TaskListManager(taskListId, configDir);
  }

  static coordinationStatsForTests() {
    return this.operations.getStats();
  }

  async createTask(input: {
    subject: string;
    description: string;
    activeForm?: string;
    owner?: string;
    priority?: TaskListItem['priority'];
    metadata?: Record<string, unknown>;
  }): Promise<TaskListItem> {
    return this.mutate((current) => {
      const task: TaskListItem = {
        id: String(current.nextId),
        subject: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        owner: input.owner,
        priority: input.priority || 'medium',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      };
      return {
        state: {
          nextId: current.nextId + 1,
          tasks: [...current.tasks, task],
        },
        result: task,
        persist: true,
      };
    });
  }

  async getTask(taskId: string): Promise<TaskListItem | null> {
    const state = await this.readLatest();
    return state.tasks.find((task) => task.id === taskId) || null;
  }

  async listTasks(): Promise<TaskListItem[]> {
    await this.readLatest();
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
  ): Promise<TaskListUpdateResult> {
    return this.mutate<TaskListUpdateResult>((current) => {
      const index = current.tasks.findIndex((task) => task.id === taskId);
      if (index === -1) {
        return {
          state: current,
          result: { task: null, updatedFields: [] },
          persist: false,
        };
      }

      const existing = current.tasks[index]!;
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

      let tasks = current.tasks.map((task) => (task.id === taskId ? next : task));
      tasks = syncDependencyEdges(tasks, next, updates.addBlocks, updates.addBlockedBy);
      return {
        state: { ...current, tasks },
        result: { task: next, updatedFields, statusChange },
        persist: true,
      };
    });
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.mutate((current) => {
      const tasks = current.tasks
        .filter((task) => task.id !== taskId)
        .map((task) => ({
          ...task,
          blocks: task.blocks.filter((id) => id !== taskId),
          blockedBy: task.blockedBy.filter((id) => id !== taskId),
        }));
      const deleted = tasks.length !== current.tasks.length;
      return {
        state: deleted ? { ...current, tasks } : current,
        result: deleted,
        persist: deleted,
      };
    });
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

  private async readLatest(): Promise<TaskListFile> {
    return TaskListManager.operations.runExclusive(this.filePath, async () => {
      const state = await this.readTasks();
      this.tasks = state.tasks;
      return state;
    });
  }

  private async mutate<T>(
    operation: (current: TaskListFile) => {
      state: TaskListFile;
      result: T;
      persist: boolean;
    }
  ): Promise<T> {
    return TaskListManager.operations.runExclusive(this.filePath, () =>
      withTaskListFileLock(this.filePath, async () => {
        const current = await this.readTasks();
        const mutation = operation(current);
        if (mutation.persist) {
          await this.saveTasks(mutation.state);
        }
        this.tasks = mutation.state.tasks;
        return mutation.result;
      })
    );
  }

  private async readTasks(): Promise<TaskListFile> {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown;
      return normalizeTaskFile(data);
    } catch (error) {
      if ((error as NodeError).code === 'ENOENT') {
        return { tasks: [], nextId: 1 };
      }
      throw new Error('Task list state is corrupt or unreadable', {
        cause: error,
      });
    }
  }

  private async saveTasks(state: TaskListFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function normalizeTaskFile(data: unknown): TaskListFile {
  const objectFile =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Partial<TaskListFile>)
      : undefined;
  const rawTasks = Array.isArray(data)
    ? data
    : objectFile && Array.isArray(objectFile.tasks)
      ? objectFile.tasks
      : undefined;
  if (!rawTasks) {
    throw new Error('Task list must contain a tasks array');
  }

  const tasks = rawTasks.map((task, index) => {
    const result = safeParseSchema(TaskListItemSchema, task);
    if (!result.success) {
      throw new Error(`Task list item ${index} failed schema validation`);
    }
    return result.data;
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error('Task list contains duplicate task IDs');
  }

  const nextIdFromData =
    objectFile && typeof objectFile.nextId === 'number' ? objectFile.nextId : undefined;
  if (
    nextIdFromData !== undefined &&
    (!Number.isInteger(nextIdFromData) || nextIdFromData < 1)
  ) {
    throw new Error('Task list nextId must be a positive integer');
  }
  const highestTaskId = tasks.reduce((highest, task) => {
    const numericId = Number(task.id);
    return Number.isFinite(numericId) ? Math.max(highest, numericId) : highest;
  }, 0);

  return {
    tasks,
    nextId: Math.max(nextIdFromData || 1, highestTaskId + 1),
  };
}

function syncDependencyEdges(
  current: TaskListItem[],
  task: TaskListItem,
  addBlocks?: string[],
  addBlockedBy?: string[]
): TaskListItem[] {
  let tasks = current;
  for (const blockedTaskId of addBlocks || []) {
    tasks = tasks.map((candidate) =>
      candidate.id === blockedTaskId
        ? { ...candidate, blockedBy: unique([...candidate.blockedBy, task.id]) }
        : candidate
    );
  }
  for (const blockerTaskId of addBlockedBy || []) {
    tasks = tasks.map((candidate) =>
      candidate.id === blockerTaskId
        ? { ...candidate, blocks: unique([...candidate.blocks, task.id]) }
        : candidate
    );
  }
  return tasks;
}

function taskListFileName(taskListId: string): string {
  const encoded = encodeURIComponent(taskListId || 'default');
  if (encoded.length <= 120) {
    return `${encoded}-agent-${encoded}.json`;
  }
  const digest = createHash('sha256').update(taskListId).digest('hex').slice(0, 16);
  return `${encoded.slice(0, 96)}-${digest}.json`;
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
