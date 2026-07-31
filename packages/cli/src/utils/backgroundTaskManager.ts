import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';

const MAX_OUTPUT_SIZE = 100 * 1024 * 1024; // 100MB

export interface BackgroundTask {
  id: string;
  command: string;
  pid: number;
  pgid?: number; // 进程组 ID
  status: 'running' | 'completed' | 'killed' | 'failed';
  createdAt: number;
  output: string;
  exitCode: number | null;
}

interface CreateTaskInput {
  command: string;
  pid: number;
  pgid?: number;
}

export class BackgroundTaskManager {
  private tasks: Map<string, BackgroundTask> = new Map();

  /**
   * 创建新的后台任务
   */
  createTask(input: CreateTaskInput): string {
    const id = `task_${crypto.randomBytes(6).toString('hex')}`;
    const task: BackgroundTask = {
      id,
      command: input.command,
      pid: input.pid,
      pgid: input.pgid,
      status: 'running',
      createdAt: Date.now(),
      output: '',
      exitCode: null,
    };
    this.tasks.set(id, task);
    return id;
  }

  /**
   * 获取指定任务
   */
  getTask(id: string): BackgroundTask | null {
    return this.tasks.get(id) || null;
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 追加任务输出
   * 自动处理输出大小限制，超过限制时截断旧内容
   */
  appendOutput(id: string, output: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      return;
    }

    const newOutput = task.output + output;

    // 检查是否超过最大大小
    if (newOutput.length > MAX_OUTPUT_SIZE) {
      // 截断旧内容，保留最新的 70%
      const truncateAmount = Math.floor(MAX_OUTPUT_SIZE * 0.3);
      task.output =
        '... [output truncated] ...\n' +
        newOutput.slice(newOutput.length - MAX_OUTPUT_SIZE + truncateAmount);
    } else {
      task.output = newOutput;
    }
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(
    id: string,
    status: BackgroundTask['status'],
    exitCode: number | null = null
  ): void {
    const task = this.tasks.get(id);
    if (!task) {
      return;
    }

    task.status = status;
    if (exitCode !== null) {
      task.exitCode = exitCode;
    }
  }

  /**
   * 删除任务
   */
  deleteTask(id: string): void {
    this.tasks.delete(id);
  }

  /**
   * 检查进程是否存活
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // 发送信号 0 只检查进程是否存在，不会实际发送信号
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 终止后台任务
   * 支持跨平台进程组终止，避免孤儿进程
   */
  async killTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') {
      return false;
    }

    const isWindows = os.platform() === 'win32';

    try {
      if (isWindows) {
        // Windows: 使用 taskkill 终止进程树
        spawn('taskkill', ['/pid', task.pid.toString(), '/f', '/t']);
      } else {
        // Unix-like: 使用进程组 ID 终止整个进程组
        const targetPid = task.pgid || task.pid;

        try {
          // 首先尝试优雅终止（SIGTERM）
          process.kill(-targetPid, 'SIGTERM');

          // 等待一小段时间
          await new Promise((resolve) => setTimeout(resolve, 200));

          // 如果进程还活着，强制终止（SIGKILL）
          if (this.isProcessAlive(targetPid)) {
            process.kill(-targetPid, 'SIGKILL');
          }
        } catch {
          // 如果进程组终止失败，尝试终止单个进程
          try {
            process.kill(task.pid, 'SIGKILL');
          } catch {
            // 进程可能已经不存在，标记为已终止
          }
        }
      }

      this.updateTaskStatus(id, 'killed');
      return true;
    } catch (_error) {
      // 即使终止失败，也标记状态
      this.updateTaskStatus(id, 'failed');
      return false;
    }
  }

  /**
   * 清理已完成的任务
   * 可选择保留最近 N 个任务
   */
  cleanupCompletedTasks(keepRecent: number = 10): number {
    const completedTasks = Array.from(this.tasks.values())
      .filter((task) => task.status === 'completed' || task.status === 'failed')
      .sort((a, b) => b.createdAt - a.createdAt); // 按创建时间倒序

    // 保留最近的 N 个，删除其余的
    const toDelete = completedTasks.slice(keepRecent);
    for (const task of toDelete) {
      this.tasks.delete(task.id);
    }

    return toDelete.length;
  }

  /**
   * 获取运行中的任务数量
   */
  getRunningTaskCount(): number {
    return Array.from(this.tasks.values()).filter((task) => task.status === 'running')
      .length;
  }

  /**
   * 获取任务统计信息
   */
  getStats(): {
    total: number;
    running: number;
    completed: number;
    killed: number;
    failed: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      running: tasks.filter((t) => t.status === 'running').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      killed: tasks.filter((t) => t.status === 'killed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  }

  /**
   * 终止所有运行中的任务
   */
  async killAllRunningTasks(): Promise<number> {
    const runningTasks = Array.from(this.tasks.values()).filter(
      (task) => task.status === 'running'
    );

    let killedCount = 0;
    for (const task of runningTasks) {
      const killed = await this.killTask(task.id);
      if (killed) {
        killedCount++;
      }
    }

    return killedCount;
  }
}
