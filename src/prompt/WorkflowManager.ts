import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { TaskStatus, WorkflowConfig, WorkflowTask } from './types.js';

/**
 * 工作流管理器
 * 实现基于todo.md的结构化工作流管理
 */
export class WorkflowManager {
  private tasks = new Map<string, WorkflowTask>();
  private config: WorkflowConfig;
  private workingDirectory: string;
  private todoFilePath: string;

  constructor(config: Partial<WorkflowConfig> = {}, workingDirectory: string = process.cwd()) {
    this.config = {
      maxConcurrentTasks: 5,
      autoSave: true,
      trackTime: true,
      generateReports: true,
      templatePath: 'todo.md',
      ...config,
    };
    this.workingDirectory = workingDirectory;
    this.todoFilePath = join(workingDirectory, this.config.templatePath);

    this.loadTodoFile();
  }

  /**
   * 加载todo.md文件
   */
  private loadTodoFile(): void {
    if (!existsSync(this.todoFilePath)) {
      this.initializeTodoFile();
      return;
    }

    try {
      const content = readFileSync(this.todoFilePath, 'utf-8');
      this.parseTodoContent(content);
    } catch (error) {
      console.error('加载todo.md文件失败:', error);
      this.initializeTodoFile();
    }
  }

  /**
   * 初始化todo.md文件
   */
  private initializeTodoFile(): void {
    const initialContent = this.generateTodoTemplate();
    writeFileSync(this.todoFilePath, initialContent, 'utf-8');
  }

  /**
   * 生成todo.md模板
   */
  private generateTodoTemplate(): string {
    const timestamp = new Date().toISOString().split('T')[0];
    return `# 📋 工作流任务管理

> 生成时间: ${timestamp}
> 管理器: Agent CLI Workflow Manager

## 🎯 概览

- **总任务数**: 0
- **进行中**: 0
- **已完成**: 0
- **阻塞**: 0

## 📊 任务状态

### 🚀 待办 (TODO)
<!-- 新任务将添加到这里 -->

### ⚡ 进行中 (IN PROGRESS)
<!-- 正在执行的任务 -->

### ✅ 已完成 (COMPLETED)
<!-- 已完成的任务 -->

### 🚫 阻塞 (BLOCKED)
<!-- 被阻塞的任务 -->

### ❌ 已取消 (CANCELLED)
<!-- 已取消的任务 -->

## 📈 工作流指标

- **平均完成时间**: N/A
- **任务成功率**: N/A
- **当前负载**: N/A

---

*此文件由 Agent CLI 自动维护，请勿手动编辑任务ID和元数据*
`;
  }

  /**
   * 解析todo.md内容
   */
  private parseTodoContent(content: string): void {
    const lines = content.split('\n');
    let currentSection = '';
    let currentTask: Partial<WorkflowTask> | null = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // 识别章节
      if (trimmedLine.startsWith('### ')) {
        currentSection = this.extractSectionType(trimmedLine);
        continue;
      }

      // 解析任务项
      if (trimmedLine.startsWith('- [ ]') || trimmedLine.startsWith('- [x]')) {
        if (currentTask) {
          this.addParsedTask(currentTask);
        }
        currentTask = this.parseTaskLine(trimmedLine, currentSection);
      } else if (currentTask && trimmedLine.startsWith('  ')) {
        // 解析任务详情
        this.parseTaskDetails(currentTask, trimmedLine);
      }
    }

    // 添加最后一个任务
    if (currentTask) {
      this.addParsedTask(currentTask);
    }
  }

  /**
   * 提取章节类型
   */
  private extractSectionType(sectionLine: string): string {
    if (sectionLine.includes('待办') || sectionLine.includes('TODO')) return 'todo';
    if (sectionLine.includes('进行中') || sectionLine.includes('IN PROGRESS')) return 'in-progress';
    if (sectionLine.includes('已完成') || sectionLine.includes('COMPLETED')) return 'completed';
    if (sectionLine.includes('阻塞') || sectionLine.includes('BLOCKED')) return 'blocked';
    if (sectionLine.includes('已取消') || sectionLine.includes('CANCELLED')) return 'cancelled';
    return '';
  }

  /**
   * 解析任务行
   */
  private parseTaskLine(line: string, section: string): Partial<WorkflowTask> {
    const isCompleted = line.includes('- [x]');
    const taskText = line.replace(/^- \[[x ]\]\s*/, '').trim();

    // 提取任务ID（如果存在）
    const idMatch = taskText.match(/\[ID:([^\]]+)\]/);
    const id = idMatch ? idMatch[1] : this.generateTaskId();

    // 提取优先级
    const priorityMatch = taskText.match(/\[优先级:([^\]]+)\]/);
    const priority = this.mapPriority(priorityMatch ? priorityMatch[1] : 'medium');

    // 提取任务标题
    const title = taskText
      .replace(/\[ID:[^\]]+\]/g, '')
      .replace(/\[优先级:[^\]]+\]/g, '')
      .replace(/\[估时:[^\]]+\]/g, '')
      .trim();

    // 确定任务状态
    let status: TaskStatus = 'todo';
    if (isCompleted) {
      status = 'completed';
    } else if (section) {
      // 验证section是否为有效的TaskStatus
      const validStatuses: TaskStatus[] = [
        'todo',
        'in-progress',
        'completed',
        'blocked',
        'cancelled',
      ];
      if (validStatuses.includes(section as TaskStatus)) {
        status = section as TaskStatus;
      }
    }

    return {
      id,
      title,
      status,
      priority,
      dependencies: [],
      tags: [],
      notes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * 解析任务详情
   */
  private parseTaskDetails(task: Partial<WorkflowTask>, line: string): void {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('**描述**:')) {
      task.description = trimmedLine.replace('**描述**:', '').trim();
    } else if (trimmedLine.startsWith('**依赖**:')) {
      const deps = trimmedLine.replace('**依赖**:', '').trim();
      task.dependencies = deps ? deps.split(',').map(d => d.trim()) : [];
    } else if (trimmedLine.startsWith('**标签**:')) {
      const tags = trimmedLine.replace('**标签**:', '').trim();
      task.tags = tags ? tags.split(',').map(t => t.trim()) : [];
    } else if (trimmedLine.startsWith('**预估时间**:')) {
      const timeStr = trimmedLine.replace('**预估时间**:', '').trim();
      const timeMatch = timeStr.match(/(\d+)/);
      task.estimatedTime = timeMatch ? parseInt(timeMatch[1]) : undefined;
    } else if (trimmedLine.startsWith('**实际时间**:')) {
      const timeStr = trimmedLine.replace('**实际时间**:', '').trim();
      const timeMatch = timeStr.match(/(\d+)/);
      task.actualTime = timeMatch ? parseInt(timeMatch[1]) : undefined;
    } else if (trimmedLine.startsWith('**负责人**:')) {
      task.assignee = trimmedLine.replace('**负责人**:', '').trim();
    } else if (trimmedLine.startsWith('**备注**:')) {
      const note = trimmedLine.replace('**备注**:', '').trim();
      if (note && !task.notes) task.notes = [];
      if (note) task.notes!.push(note);
    }
  }

  /**
   * 添加解析的任务
   */
  private addParsedTask(taskData: Partial<WorkflowTask>): void {
    if (!taskData.id || !taskData.title) return;

    const task: WorkflowTask = {
      id: taskData.id,
      title: taskData.title,
      description: taskData.description || '',
      status: taskData.status || 'todo',
      priority: taskData.priority || 'medium',
      dependencies: taskData.dependencies || [],
      estimatedTime: taskData.estimatedTime,
      actualTime: taskData.actualTime,
      tags: taskData.tags || [],
      assignee: taskData.assignee,
      createdAt: taskData.createdAt || new Date(),
      updatedAt: taskData.updatedAt || new Date(),
      completedAt: taskData.status === 'completed' ? new Date() : undefined,
      notes: taskData.notes || [],
    };

    this.tasks.set(task.id, task);
  }

  /**
   * 映射优先级
   */
  private mapPriority(priorityStr: string): 'low' | 'medium' | 'high' | 'critical' {
    const priority = priorityStr.toLowerCase();
    if (priority.includes('低') || priority === 'low') return 'low';
    if (priority.includes('高') || priority === 'high') return 'high';
    if (priority.includes('紧急') || priority.includes('critical')) return 'critical';
    return 'medium';
  }

  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `task-${timestamp}-${random}`;
  }

  /**
   * 添加任务
   */
  public addTask(task: Omit<WorkflowTask, 'id' | 'createdAt' | 'updatedAt'>): WorkflowTask {
    const id = this.generateTaskId();
    const newTask: WorkflowTask = {
      ...task,
      id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.tasks.set(id, newTask);

    if (this.config.autoSave) {
      this.saveTodoFile();
    }

    return newTask;
  }

  /**
   * 更新任务
   */
  public updateTask(
    id: string,
    updates: Partial<Omit<WorkflowTask, 'id' | 'createdAt'>>
  ): WorkflowTask {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`任务不存在: ${id}`);
    }

    const updatedTask: WorkflowTask = {
      ...task,
      ...updates,
      updatedAt: new Date(),
      completedAt: updates.status === 'completed' ? new Date() : task.completedAt,
    };

    this.tasks.set(id, updatedTask);

    if (this.config.autoSave) {
      this.saveTodoFile();
    }

    return updatedTask;
  }

  /**
   * 删除任务
   */
  public deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id);

    if (deleted && this.config.autoSave) {
      this.saveTodoFile();
    }

    return deleted;
  }

  /**
   * 获取任务
   */
  public getTask(id: string): WorkflowTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * 获取所有任务
   */
  public getAllTasks(): WorkflowTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 按状态获取任务
   */
  public getTasksByStatus(status: TaskStatus): WorkflowTask[] {
    return Array.from(this.tasks.values()).filter(task => task.status === status);
  }

  /**
   * 按优先级获取任务
   */
  public getTasksByPriority(priority: 'low' | 'medium' | 'high' | 'critical'): WorkflowTask[] {
    return Array.from(this.tasks.values()).filter(task => task.priority === priority);
  }

  /**
   * 获取可执行的任务（没有未完成依赖的任务）
   */
  public getExecutableTasks(): WorkflowTask[] {
    return Array.from(this.tasks.values()).filter(task => {
      if (task.status !== 'todo' && task.status !== 'blocked') return false;

      // 检查依赖是否都已完成
      return task.dependencies.every(depId => {
        const depTask = this.tasks.get(depId);
        return depTask?.status === 'completed';
      });
    });
  }

  /**
   * 开始任务
   */
  public startTask(id: string): WorkflowTask {
    // 检查并发任务限制
    const inProgressTasks = this.getTasksByStatus('in-progress');
    if (inProgressTasks.length >= this.config.maxConcurrentTasks) {
      throw new Error(`已达到最大并发任务数限制: ${this.config.maxConcurrentTasks}`);
    }

    const task = this.getTask(id);
    if (!task) {
      throw new Error(`任务不存在: ${id}`);
    }

    // 检查依赖
    const executableTasks = this.getExecutableTasks();
    if (!executableTasks.find(t => t.id === id)) {
      throw new Error(`任务有未完成的依赖，无法开始: ${id}`);
    }

    return this.updateTask(id, { status: 'in-progress' });
  }

  /**
   * 完成任务
   */
  public completeTask(id: string, actualTime?: number): WorkflowTask {
    const updates: Partial<WorkflowTask> = {
      status: 'completed',
      completedAt: new Date(),
    };

    if (actualTime !== undefined) {
      updates.actualTime = actualTime;
    }

    return this.updateTask(id, updates);
  }

  /**
   * 阻塞任务
   */
  public blockTask(id: string, reason: string): WorkflowTask {
    const task = this.updateTask(id, { status: 'blocked' });
    this.addTaskNote(id, `任务被阻塞: ${reason}`);
    return task;
  }

  /**
   * 取消任务
   */
  public cancelTask(id: string, reason: string): WorkflowTask {
    const task = this.updateTask(id, { status: 'cancelled' });
    this.addTaskNote(id, `任务被取消: ${reason}`);
    return task;
  }

  /**
   * 添加任务备注
   */
  public addTaskNote(id: string, note: string): WorkflowTask {
    const task = this.getTask(id);
    if (!task) {
      throw new Error(`任务不存在: ${id}`);
    }

    const updatedNotes = [...task.notes, `[${new Date().toISOString()}] ${note}`];
    return this.updateTask(id, { notes: updatedNotes });
  }

  /**
   * 保存todo.md文件
   */
  public saveTodoFile(): void {
    const content = this.generateTodoContent();
    writeFileSync(this.todoFilePath, content, 'utf-8');
  }

  /**
   * 生成todo.md内容
   */
  private generateTodoContent(): string {
    const tasks = Array.from(this.tasks.values());
    const stats = this.getStatistics();

    let content = `# 📋 工作流任务管理

> 更新时间: ${new Date().toISOString().split('T')[0]}
> 管理器: Agent CLI Workflow Manager

## 🎯 概览

- **总任务数**: ${stats.totalTasks}
- **进行中**: ${stats.inProgress}
- **已完成**: ${stats.completed}
- **阻塞**: ${stats.blocked}

## 📊 任务状态

`;

    // 按状态分组生成任务
    const statusSections = [
      { status: 'todo' as TaskStatus, title: '🚀 待办 (TODO)' },
      { status: 'in-progress' as TaskStatus, title: '⚡ 进行中 (IN PROGRESS)' },
      { status: 'completed' as TaskStatus, title: '✅ 已完成 (COMPLETED)' },
      { status: 'blocked' as TaskStatus, title: '🚫 阻塞 (BLOCKED)' },
      { status: 'cancelled' as TaskStatus, title: '❌ 已取消 (CANCELLED)' },
    ];

    statusSections.forEach(section => {
      content += `### ${section.title}\n\n`;

      const sectionTasks = tasks
        .filter(task => task.status === section.status)
        .sort((a, b) => {
          // 按优先级排序
          const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        });

      if (sectionTasks.length === 0) {
        content += '<!-- 暂无任务 -->\n\n';
      } else {
        sectionTasks.forEach(task => {
          content += this.formatTaskItem(task);
        });
        content += '\n';
      }
    });

    // 添加统计信息
    content += `## 📈 工作流指标

- **平均完成时间**: ${stats.averageCompletionTime || 'N/A'}
- **任务成功率**: ${stats.successRate}%
- **当前负载**: ${stats.currentLoad}%

---

*此文件由 Agent CLI 自动维护，请勿手动编辑任务ID和元数据*
`;

    return content;
  }

  /**
   * 格式化任务项
   */
  private formatTaskItem(task: WorkflowTask): string {
    const checkbox = task.status === 'completed' ? '[x]' : '[ ]';
    const priorityEmoji = {
      critical: '🔥',
      high: '⚡',
      medium: '📋',
      low: '💤',
    };

    let item = `- ${checkbox} ${priorityEmoji[task.priority]} ${task.title} [ID:${task.id}] [优先级:${task.priority}]`;

    if (task.estimatedTime) {
      item += ` [估时:${task.estimatedTime}min]`;
    }

    item += '\n';

    // 添加详细信息
    if (task.description) {
      item += `  **描述**: ${task.description}\n`;
    }

    if (task.dependencies.length > 0) {
      item += `  **依赖**: ${task.dependencies.join(', ')}\n`;
    }

    if (task.tags.length > 0) {
      item += `  **标签**: ${task.tags.join(', ')}\n`;
    }

    if (task.estimatedTime) {
      item += `  **预估时间**: ${task.estimatedTime} 分钟\n`;
    }

    if (task.actualTime) {
      item += `  **实际时间**: ${task.actualTime} 分钟\n`;
    }

    if (task.assignee) {
      item += `  **负责人**: ${task.assignee}\n`;
    }

    if (task.notes.length > 0) {
      task.notes.forEach(note => {
        item += `  **备注**: ${note}\n`;
      });
    }

    item += '\n';
    return item;
  }

  /**
   * 获取统计信息
   */
  public getStatistics() {
    const tasks = Array.from(this.tasks.values());
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed');
    const inProgressTasks = tasks.filter(t => t.status === 'in-progress');
    const blockedTasks = tasks.filter(t => t.status === 'blocked');

    // 计算平均完成时间
    const completedWithTime = completedTasks.filter(t => t.actualTime);
    const averageCompletionTime =
      completedWithTime.length > 0
        ? Math.round(
            completedWithTime.reduce((sum, t) => sum + (t.actualTime || 0), 0) /
              completedWithTime.length
          )
        : null;

    // 计算成功率
    const finishedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'cancelled');
    const successRate =
      finishedTasks.length > 0
        ? Math.round((completedTasks.length / finishedTasks.length) * 100)
        : 0;

    // 计算当前负载
    const currentLoad =
      this.config.maxConcurrentTasks > 0
        ? Math.round((inProgressTasks.length / this.config.maxConcurrentTasks) * 100)
        : 0;

    return {
      totalTasks,
      todo: tasks.filter(t => t.status === 'todo').length,
      inProgress: inProgressTasks.length,
      completed: completedTasks.length,
      blocked: blockedTasks.length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
      averageCompletionTime: averageCompletionTime ? `${averageCompletionTime}min` : null,
      successRate,
      currentLoad,
      executableTasks: this.getExecutableTasks().length,
    };
  }

  /**
   * 获取工作流报告
   */
  public generateReport(): string {
    const stats = this.getStatistics();
    // const tasks = Array.from(this.tasks.values());

    return `# 📊 工作流报告

## 总体概况
- 总任务数: ${stats.totalTasks}
- 完成率: ${stats.successRate}%
- 当前负载: ${stats.currentLoad}%
- 可执行任务: ${stats.executableTasks}

## 任务分布
- 待办: ${stats.todo}
- 进行中: ${stats.inProgress}
- 已完成: ${stats.completed}  
- 阻塞: ${stats.blocked}
- 已取消: ${stats.cancelled}

## 性能指标
- 平均完成时间: ${stats.averageCompletionTime || 'N/A'}
- 最大并发数: ${this.config.maxConcurrentTasks}

## 高优先级任务
${
  this.getTasksByPriority('critical')
    .concat(this.getTasksByPriority('high'))
    .slice(0, 5)
    .map(task => `- ${task.title} (${task.status})`)
    .join('\n') || '无'
}

生成时间: ${new Date().toLocaleString()}
`;
  }
}
