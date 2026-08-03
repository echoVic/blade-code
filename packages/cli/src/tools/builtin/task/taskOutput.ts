/**
 * TaskOutput Tool - 统一的后台任务输出获取工具
 *
 * 支持获取：
 * - 后台 shell 输出 (bash_xxx)
 * - 后台 agent 输出
 */

import { z } from 'zod';
import { BackgroundAgentManager } from '../../../agent/subagents/BackgroundAgentManager.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { BackgroundShellManager } from '../shell/BackgroundShellManager.js';

/**
 * TaskOutput 工具
 *
 * 统一接口获取后台任务输出，支持：
 * - background shells (bash_id)
 * - async agents
 */
export const taskOutputTool = createTool({
  name: 'TaskOutput',
  displayName: 'Task Output',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true, // 纯读操作，无副作用

  schema: z.object({
    task_id: z.string().min(1).describe('The task ID to get output from'),
    block: z.boolean().default(true).describe('Whether to wait for completion'),
    timeout: z
      .number()
      .min(0)
      .max(600000)
      .default(30000)
      .describe('Max wait time in ms'),
  }),

  description: {
    short: 'Retrieves output from a running or completed task',
    long: `
- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
`.trim(),
    usageNotes: [
      'task_id is required - the ID returned when starting a background task',
      'block=true (default) waits for task completion',
      'block=false returns current status immediately',
      'timeout defaults to 30000ms (30 seconds), max 600000ms (10 minutes)',
    ],
    examples: [
      {
        description: 'Get output from a background shell',
        params: {
          task_id: 'bash_abc123',
          block: true,
          timeout: 30000,
        },
      },
      {
        description: 'Check agent status without blocking',
        params: {
          task_id: 'session_xyz789',
          block: false,
        },
      },
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { task_id, block, timeout } = params;
    const sessionId = context.sessionId ?? '';

    // 根据 task_id 前缀判断类型
    if (task_id.startsWith('bash_')) {
      return handleShellOutput(task_id, block, timeout, sessionId);
    }
    const shellManager = BackgroundShellManager.getInstance();
    const agentManager = BackgroundAgentManager.getInstance();

    if (shellManager.getProcess(task_id, sessionId)) {
      return handleShellOutput(task_id, block, timeout, sessionId);
    }
    if (agentManager.getAgent(task_id, sessionId)) {
      return handleAgentOutput(task_id, block, timeout, sessionId);
    }

    return {
      success: false,
      llmContent: `Unknown task ID: ${task_id}.`,
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: `Unknown task ID: ${task_id}`,
      },
      metadata: {
        summary: `获取任务输出: ${task_id} (未知ID)`,
      },
    };
  },

  version: '1.0.0',
  category: 'Task',
  tags: ['task', 'output', 'background', 'shell', 'agent'],

  extractSignatureContent: (params) => params.task_id,
  abstractPermissionRule: () => '*',
});

/**
 * 处理后台 Shell 输出
 */
async function handleShellOutput(
  taskId: string,
  block: boolean,
  timeout: number,
  sessionId: string
): Promise<ToolResult> {
  const manager = BackgroundShellManager.getInstance();

  // 获取进程信息
  const processInfo = manager.getProcess(taskId, sessionId);
  if (!processInfo) {
    return {
      success: false,
      llmContent: `Shell not found: ${taskId}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Shell 会话不存在或已清理',
      },
      metadata: {
        summary: `获取任务输出: ${taskId} (未找到)`,
      },
    };
  }

  // 如果需要阻塞等待且进程仍在运行
  if (block && processInfo.status === 'running') {
    // 等待进程完成或超时
    await waitForShellCompletion(taskId, timeout, sessionId);
  }

  // 获取输出
  const snapshot = manager.consumeOutput(taskId, sessionId);
  if (!snapshot) {
    return {
      success: false,
      llmContent: `Failed to get output for shell: ${taskId}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Failed to consume output',
      },
      metadata: {
        summary: `获取任务输出: ${taskId} (失败)`,
      },
    };
  }

  const payload = {
    task_id: snapshot.id,
    type: 'shell',
    status: snapshot.status,
    command: snapshot.command,
    pid: snapshot.pid,
    exit_code: snapshot.exitCode,
    signal: snapshot.signal,
    sandboxed: snapshot.sandboxed,
    started_at: new Date(snapshot.startedAt).toISOString(),
    finished_at: snapshot.endedAt
      ? new Date(snapshot.endedAt).toISOString()
      : undefined,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
  };

  return {
    success: true,
    llmContent: payload,
    metadata: {
      summary: `获取任务输出: ${taskId}`,
      ...payload,
    },
  };
}

/**
 * 处理后台 Agent 输出
 */
async function handleAgentOutput(
  taskId: string,
  block: boolean,
  timeout: number,
  parentSessionId: string
): Promise<ToolResult> {
  const manager = BackgroundAgentManager.getInstance();

  // 获取会话信息
  let session = manager.getAgent(taskId, parentSessionId);
  if (!session) {
    return {
      success: false,
      llmContent: `Agent not found: ${taskId}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Agent 会话不存在或已清理',
      },
      metadata: {
        summary: `获取任务输出: ${taskId} (未找到)`,
      },
    };
  }

  // 如果需要阻塞等待且 agent 仍在运行
  if (block && session.status === 'running') {
    session = await manager.waitForCompletion(taskId, timeout, parentSessionId);
    if (!session) {
      return {
        success: false,
        llmContent: `Failed to wait for agent: ${taskId}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Wait for completion failed',
        },
        metadata: {
          summary: `获取任务输出: ${taskId} (等待失败)`,
        },
      };
    }
  }

  const payload = {
    task_id: session.id,
    type: 'agent',
    status: session.status,
    subagent_type: session.subagentType,
    description: session.description,
    created_at: new Date(session.createdAt).toISOString(),
    last_active_at: new Date(session.lastActiveAt).toISOString(),
    completed_at: session.completedAt
      ? new Date(session.completedAt).toISOString()
      : undefined,
    result: session.result,
    stats: session.stats,
    isolation: session.isolation,
    worktree_path: session.worktree?.worktreeRoot,
    worktree_branch: session.worktree?.branch,
  };

  const subagentStatus =
    session.status === 'completed'
      ? 'completed'
      : session.status === 'failed'
        ? 'failed'
        : 'running';

  return {
    success: true,
    llmContent: payload,
    metadata: {
      summary: `获取任务输出: ${taskId}`,
      ...payload,
      subagentSessionId: session.id,
      subagentType: session.subagentType,
      subagentStatus,
      subagentSummary:
        typeof session.result?.message === 'string'
          ? session.result.message.slice(0, 500)
          : undefined,
      verificationCommands: session.result?.verificationCommands,
    },
  };
}

/**
 * 等待 Shell 完成
 */
async function waitForShellCompletion(
  taskId: string,
  timeout: number,
  sessionId: string
): Promise<void> {
  const manager = BackgroundShellManager.getInstance();
  const startTime = Date.now();

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const processInfo = manager.getProcess(taskId, sessionId);

      // 进程不存在或已完成
      if (!processInfo || processInfo.status !== 'running') {
        clearInterval(checkInterval);
        resolve();
        return;
      }

      // 超时
      if (Date.now() - startTime >= timeout) {
        clearInterval(checkInterval);
        resolve();
        return;
      }
    }, 100); // 每 100ms 检查一次
  });
}
