import type { AgentSession } from '../subagents/AgentSessionStore.js';
import { type TeamTask, TeamTaskGraph } from './TeamTaskGraph.js';

export interface TeamMemberCompletion {
  completedTaskIds: string[];
  unblockedTasks: TeamTask[];
}

export class TeamCoordinator {
  constructor(private readonly taskGraph: TeamTaskGraph) {}

  async claimNext(memberId: string) {
    return this.taskGraph.claimNext(memberId);
  }

  async completeMemberWork(session: AgentSession): Promise<TeamMemberCompletion> {
    if (session.status !== 'completed' || session.result?.success !== true) {
      return { completedTaskIds: [], unblockedTasks: [] };
    }
    const tasks = await this.taskGraph.listTasks();
    const blockedTaskIds = new Set(
      tasks.filter((task) => task.status === 'blocked').map((task) => task.id)
    );
    const result = session.result?.message || session.result?.error;
    const completedTaskIds: string[] = [];
    for (const task of tasks) {
      if (task.owner !== session.id || task.status !== 'running') continue;
      const completed = await this.taskGraph.completeTask(task.id, result);
      if (completed) completedTaskIds.push(completed.id);
    }
    const unblockedTasks = (await this.taskGraph.listTasks()).filter(
      (task) => blockedTaskIds.has(task.id) && task.status === 'pending'
    );
    return { completedTaskIds, unblockedTasks };
  }

  async isComplete(): Promise<boolean> {
    const tasks = await this.taskGraph.listTasks();
    return tasks.length > 0 && tasks.every((task) => task.status === 'completed');
  }
}
