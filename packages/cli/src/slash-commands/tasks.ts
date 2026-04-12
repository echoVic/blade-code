/**
 * /tasks slash command
 *
 * 列出所有后台任务（shells 和 agents）
 */

import { BackgroundAgentManager } from '../agent/subagents/BackgroundAgentManager.js';
import { BackgroundShellManager } from '../tools/builtin/shell/BackgroundShellManager.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from './types.js';

// 列出 shells
type ShellRow = {
  id: string;
  command: string;
  status: string;
  startTime: number;
  endTime?: number;
  pid?: number;
};

/**
 * 格式化时间差
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * 获取状态图标
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'running':
      return '[RUNNING]';
    case 'completed':
    case 'exited':
      return '[OK]';
    case 'failed':
    case 'error':
      return '[FAIL]';
    case 'killed':
    case 'cancelled':
      return '[STOPPED]';
    default:
      return '[?]';
  }
}

/**
 * 截断字符串
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * /tasks 命令处理器
 */
async function tasksHandler(
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const subcommand = args[0];

  // 获取后台 shells
  const shellManager = BackgroundShellManager.getInstance();
  const agentManager = BackgroundAgentManager.getInstance();

  // 子命令：clean（清理已完成的任务）
  if (subcommand === 'clean') {
    const cleaned = agentManager.cleanupExpiredSessions(0); // 清理所有已完成
    ui.sendMessage(`已清理 ${cleaned} 个已完成的 Agent 会话`);
    return { success: true, message: `Cleaned ${cleaned} agent sessions` };
  }

  // 默认：列出所有任务
  const output: string[] = ['**后台任务列表**\n'];

  const shellProcesses = (
    shellManager as unknown as { processes?: Map<string, ShellRow> }
  ).processes;
  const shells = Array.from(shellProcesses?.values() || []);

  if (shells.length > 0) {
    output.push('### Shells\n');
    output.push('| ID | 状态 | 命令 | PID | 运行时间 |');
    output.push('|:---|:-----|:-----|:----|:---------|');

    for (const shell of shells) {
      const duration = shell.endTime
        ? formatDuration(shell.endTime - shell.startTime)
        : formatDuration(Date.now() - shell.startTime);
      const statusIcon = getStatusIcon(shell.status);

      output.push(
        `| \`${shell.id.slice(0, 12)}...\` | ${statusIcon} ${shell.status} | \`${truncate(shell.command, 30)}\` | ${shell.pid || '-'} | ${duration} |`
      );
    }
    output.push('');
  }

  // 列出 agents
  const agents = agentManager.listAll();

  if (agents.length > 0) {
    output.push('### Agents\n');
    output.push('| ID | 状态 | 类型 | 描述 | 运行时间 |');
    output.push('|:---|:-----|:-----|:-----|:---------|');

    for (const agent of agents) {
      const duration = agent.completedAt
        ? formatDuration(agent.completedAt - agent.createdAt)
        : formatDuration(Date.now() - agent.createdAt);
      const statusIcon = getStatusIcon(agent.status);

      output.push(
        `| \`${agent.id.slice(0, 12)}...\` | ${statusIcon} ${agent.status} | ${agent.subagentType} | ${truncate(agent.description, 25)} | ${duration} |`
      );
    }
    output.push('');
  }

  // 统计信息
  const runningShells = shells.filter((s) => s.status === 'running').length;
  const runningAgents = agentManager.getRunningCount();

  if (shells.length === 0 && agents.length === 0) {
    output.push('*暂无后台任务*\n');
  } else {
    output.push(
      `**统计**: ${shells.length} shells (${runningShells} 运行中), ${agents.length} agents (${runningAgents} 运行中)`
    );
  }

  output.push('\n---');
  output.push('**命令**:');
  output.push('- `/tasks` - 列出所有后台任务');
  output.push('- `/tasks clean` - 清理已完成的 Agent 会话');

  ui.sendMessage(output.join('\n'));

  return {
    success: true,
    message: `Listed ${shells.length} shells and ${agents.length} agents`,
  };
}

/**
 * /tasks 命令定义
 */
const tasksCommand: SlashCommand = {
  name: 'tasks',
  description: '列出所有后台任务（shells 和 agents）',
  fullDescription: `查看和管理后台运行的任务。

**功能**：
- 列出所有后台 shell 进程
- 列出所有后台 agent 任务
- 清理已完成的会话

**使用示例**：
- \`/tasks\` - 显示所有后台任务
- \`/tasks clean\` - 清理已完成的 agent 会话`,
  usage: '/tasks [clean]',
  category: 'system',
  examples: ['/tasks', '/tasks clean'],
  handler: tasksHandler,
};

export default tasksCommand;
