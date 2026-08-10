/**
 * TaskOutput 工具单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock BackgroundShellManager
const mockShellManager = {
  getProcess: vi.fn(),
  consumeOutput: vi.fn(),
};

vi.mock('../../../../../src/tools/builtin/shell/BackgroundShellManager.js', () => ({
  BackgroundShellManager: {
    getInstance: () => mockShellManager,
  },
}));

// Mock BackgroundAgentManager
const mockAgentManager = {
  getAgent: vi.fn(),
  waitForCompletion: vi.fn(),
};

vi.mock('../../../../../src/agent/subagents/BackgroundAgentManager.js', () => ({
  BackgroundAgentManager: {
    getInstance: () => mockAgentManager,
  },
}));

import { taskOutputTool } from '../../../../../src/tools/builtin/task/taskOutput.js';

describe('TaskOutput Tool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('tool metadata', () => {
    it('应有正确的名称', () => {
      expect(taskOutputTool.name).toBe('TaskOutput');
    });

    it('应有描述', () => {
      expect(taskOutputTool.description.short).toContain('output');
    });

    it('应是只读工具', () => {
      expect(taskOutputTool.isReadOnly).toBe(true);
    });
  });

  describe('shell output (bash_xxx)', () => {
    it('拒绝读取其他 session 的 shell 输出', async () => {
      mockShellManager.getProcess.mockImplementation(
        (_taskId: string, sessionId?: string) =>
          sessionId === 'session-owner'
            ? { id: 'bash_private', status: 'running' }
            : undefined
      );

      const result = await taskOutputTool.execute(
        {
          task_id: 'bash_private',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'session-other' }
      );

      expect(result.success).toBe(false);
      expect(mockShellManager.getProcess).toHaveBeenCalledWith(
        'bash_private',
        'session-other'
      );
    });

    it('应获取后台 shell 输出', async () => {
      mockShellManager.getProcess.mockReturnValue({
        id: 'bash_abc123',
        status: 'exited',
      });
      mockShellManager.consumeOutput.mockReturnValue({
        id: 'bash_abc123',
        command: 'echo hello',
        status: 'exited',
        stdout: 'hello\n',
        stderr: '',
        exitCode: 0,
        pid: 12345,
        startedAt: 1000,
        endedAt: 2000,
      });

      const result = await taskOutputTool.execute({
        task_id: 'bash_abc123',
        block: false,
        timeout: 30000,
      });

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({
        task_id: 'bash_abc123',
        type: 'shell',
        status: 'exited',
        stdout: 'hello\n',
        exit_code: 0,
      });
    });

    it('应向所有客户端暴露后台 shell 输出丢弃计数', async () => {
      mockShellManager.getProcess.mockReturnValue({
        id: 'bash_bounded',
        status: 'exited',
      });
      mockShellManager.consumeOutput.mockReturnValue({
        id: 'bash_bounded',
        command: 'noisy-command',
        status: 'exited',
        stdout: 'latest stdout',
        stderr: 'latest stderr',
        stdoutOmittedBytes: 4096,
        stderrOmittedBytes: 2048,
        exitCode: 0,
        pid: 12345,
        startedAt: 1000,
        endedAt: 2000,
      });

      const result = await taskOutputTool.execute({
        task_id: 'bash_bounded',
        block: false,
        timeout: 30000,
      });

      expect(result.llmContent).toMatchObject({
        stdout: 'latest stdout',
        stderr: 'latest stderr',
        output_truncated: true,
        stdout_omitted_bytes: 4096,
        stderr_omitted_bytes: 2048,
      });
      expect(result.metadata).toMatchObject({
        output_truncated: true,
        stdout_omitted_bytes: 4096,
        stderr_omitted_bytes: 2048,
      });
    });

    it('应限制发送给模型和客户端的后台 shell 输出大小', async () => {
      const latestMarker = 'LATEST_DIAGNOSTIC';
      const retainedOutput = `${'x'.repeat(30_000)}${latestMarker}`;
      mockShellManager.getProcess.mockReturnValue({
        id: 'bash_context_bounded',
        status: 'exited',
      });
      mockShellManager.consumeOutput.mockReturnValue({
        id: 'bash_context_bounded',
        command: 'noisy-command',
        status: 'exited',
        stdout: retainedOutput,
        stderr: '',
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        exitCode: 0,
        pid: 12345,
        startedAt: 1000,
        endedAt: 2000,
      });

      const result = await taskOutputTool.execute({
        task_id: 'bash_context_bounded',
        block: false,
        timeout: 30000,
      });
      const payload = result.llmContent as {
        stdout: string;
        output_truncated: boolean;
        truncation_info?: string;
      };

      expect(Buffer.byteLength(payload.stdout)).toBeLessThanOrEqual(15_000);
      expect(payload.stdout.endsWith(latestMarker)).toBe(true);
      expect(payload.output_truncated).toBe(true);
      expect(payload.truncation_info).toContain('stdout');
      expect(result.metadata?.stdout).toBe(payload.stdout);
    });

    it('shell 不存在时应返回错误', async () => {
      mockShellManager.getProcess.mockReturnValue(undefined);

      const result = await taskOutputTool.execute({
        task_id: 'bash_nonexistent',
        block: false,
        timeout: 30000,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Shell 会话不存在');
    });

    it('block=true 时应等待 shell 完成', async () => {
      // 初始状态：运行中
      mockShellManager.getProcess
        .mockReturnValueOnce({ id: 'bash_wait', status: 'running' })
        .mockReturnValue({ id: 'bash_wait', status: 'exited' });

      mockShellManager.consumeOutput.mockReturnValue({
        id: 'bash_wait',
        command: 'sleep 1',
        status: 'exited',
        stdout: '',
        stderr: '',
        exitCode: 0,
        startedAt: 1000,
        endedAt: 2000,
      });

      const result = await taskOutputTool.execute({
        task_id: 'bash_wait',
        block: true,
        timeout: 100,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('agent output (agent_xxx)', () => {
    it('拒绝读取其他 parent session 的 agent 输出', async () => {
      mockAgentManager.getAgent.mockImplementation(
        (_taskId: string, owner?: { sessionId?: string; projectPath?: string }) =>
          owner?.sessionId === 'parent-owner'
            ? { id: 'agent_private', status: 'completed' }
            : undefined
      );

      const result = await taskOutputTool.execute(
        {
          task_id: 'agent_private',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'parent-other', workspaceRoot: '/workspace/other' }
      );

      expect(result.success).toBe(false);
      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('agent_private', {
        sessionId: 'parent-other',
        projectPath: '/workspace/other',
      });
    });

    it('应获取后台 agent 输出', async () => {
      const mockSession = {
        id: 'agent_xyz789',
        subagentType: 'verification',
        description: 'Find files',
        status: 'completed',
        createdAt: 1000,
        lastActiveAt: 2000,
        completedAt: 2000,
        result: {
          success: true,
          message: 'Found 10 files',
          verificationCommands: ['npm test'],
          verificationVerdict: 'pass',
          modifiedFiles: [],
        },
        configSnapshot: {
          name: 'verification',
          description: 'Built-in verifier',
          source: 'builtin',
        },
        stats: {
          duration: 1000,
          toolCalls: 5,
        },
      };
      mockAgentManager.getAgent.mockReturnValue(mockSession);

      const result = await taskOutputTool.execute(
        {
          task_id: 'agent_xyz789',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'parent-default', workspaceRoot: '/workspace/default' }
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({
        task_id: 'agent_xyz789',
        type: 'agent',
        status: 'completed',
        subagent_type: 'verification',
        description: 'Find files',
      });
      expect(result.metadata?.verificationCommands).toEqual(['npm test']);
      expect(result.metadata).toMatchObject({
        verificationVerdict: 'pass',
        modifiedFiles: [],
        verificationAgentBuiltin: true,
      });
    });

    it('agent 不存在时应返回错误', async () => {
      mockAgentManager.getAgent.mockReturnValue(undefined);

      const result = await taskOutputTool.execute({
        task_id: 'agent_nonexistent',
        block: false,
        timeout: 30000,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Unknown task ID');
    });

    it('block=true 时应等待 agent 完成', async () => {
      const runningSession = {
        id: 'agent_wait',
        subagentType: 'Explore',
        description: 'Wait task',
        status: 'running',
        createdAt: 1000,
        lastActiveAt: 1000,
      };

      const completedSession = {
        ...runningSession,
        status: 'completed',
        completedAt: 2000,
        result: { success: true, message: 'Done' },
      };

      mockAgentManager.getAgent.mockReturnValue(runningSession);
      mockAgentManager.waitForCompletion.mockResolvedValue(completedSession);

      const result = await taskOutputTool.execute(
        {
          task_id: 'agent_wait',
          block: true,
          timeout: 5000,
        },
        new AbortController().signal,
        { sessionId: 'parent-wait', workspaceRoot: '/workspace/wait' }
      );

      expect(result.success).toBe(true);
      expect(mockAgentManager.waitForCompletion).toHaveBeenCalledWith(
        'agent_wait',
        5000,
        {
          sessionId: 'parent-wait',
          projectPath: '/workspace/wait',
        }
      );
    });
  });

  describe('unknown task type', () => {
    it('未知前缀应尝试两种类型', async () => {
      mockShellManager.getProcess.mockReturnValue(undefined);
      mockAgentManager.getAgent.mockReturnValue(undefined);

      const result = await taskOutputTool.execute({
        task_id: 'unknown_123',
        block: false,
        timeout: 30000,
      });

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('Unknown task ID');
    });

    it('如果找到 shell 应返回 shell 输出', async () => {
      mockShellManager.getProcess.mockReturnValue({
        id: 'custom_shell',
        status: 'exited',
      });
      mockShellManager.consumeOutput.mockReturnValue({
        id: 'custom_shell',
        command: 'ls',
        status: 'exited',
        stdout: 'file.txt',
        stderr: '',
        exitCode: 0,
        startedAt: 1000,
        endedAt: 2000,
      });

      const result = await taskOutputTool.execute({
        task_id: 'custom_shell',
        block: false,
        timeout: 30000,
      });

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({
        type: 'shell',
      });
    });

    it('如果找到 agent 应返回 agent 输出', async () => {
      mockShellManager.getProcess.mockReturnValue(undefined);
      mockAgentManager.getAgent.mockReturnValue({
        id: 'custom_agent',
        subagentType: 'Plan',
        description: 'Custom',
        status: 'completed',
        createdAt: 1000,
        lastActiveAt: 2000,
      });

      const result = await taskOutputTool.execute(
        {
          task_id: 'custom_agent',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'parent-default', workspaceRoot: '/workspace/default' }
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({
        type: 'agent',
      });
    });
  });

  describe('status display', () => {
    it('running 状态应返回成功', async () => {
      mockAgentManager.getAgent.mockReturnValue({
        id: 'agent_running',
        subagentType: 'Explore',
        description: 'Running',
        status: 'running',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });

      const result = await taskOutputTool.execute(
        {
          task_id: 'agent_running',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'parent-default', workspaceRoot: '/workspace/default' }
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({ status: 'running' });
    });

    it('completed 状态应返回成功', async () => {
      mockAgentManager.getAgent.mockReturnValue({
        id: 'agent_done',
        subagentType: 'Explore',
        description: 'Done',
        status: 'completed',
        createdAt: 1000,
        lastActiveAt: 2000,
        completedAt: 2000,
      });

      const result = await taskOutputTool.execute(
        {
          task_id: 'agent_done',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'parent-default', workspaceRoot: '/workspace/default' }
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({ status: 'completed' });
    });

    it('failed 状态应返回成功但包含错误信息', async () => {
      mockAgentManager.getAgent.mockReturnValue({
        id: 'agent_failed',
        subagentType: 'Explore',
        description: 'Failed',
        status: 'failed',
        createdAt: 1000,
        lastActiveAt: 2000,
        result: { success: false, message: '', error: 'Something broke' },
      });

      const result = await taskOutputTool.execute(
        {
          task_id: 'agent_failed',
          block: false,
          timeout: 30000,
        },
        new AbortController().signal,
        { sessionId: 'parent-default', workspaceRoot: '/workspace/default' }
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toMatchObject({ status: 'failed' });
    });
  });
});
