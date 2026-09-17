import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comprehensiveLoopEvents } from '../../support/comprehensiveLoopEvents.js';

const state = vi.hoisted(() => ({
  chatStream: vi.fn(),
  createAgent: vi.fn(),
  createRuntime: vi.fn(),
  disposeRuntime: vi.fn(),
  resolveSession: vi.fn(),
  setPermissionMode: vi.fn(),
}));

vi.mock('../../../src/agent/Agent.js', () => ({
  Agent: { createWithRuntime: state.createAgent },
}));

vi.mock('../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: { create: state.createRuntime },
}));

vi.mock('../../../src/commands/shared/sessionContext.js', () => ({
  resolveNonInteractiveSession: state.resolveSession,
}));

vi.mock('../../../src/services/SessionService.js', () => ({
  SessionService: { setSessionPermissionMode: state.setPermissionMode },
}));

describe('runHeadless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resolveSession.mockResolvedValue({
      sessionId: 'headless-session',
      messages: [],
    });
    state.setPermissionMode.mockResolvedValue({ permissionMode: 'yolo' });
    state.disposeRuntime.mockResolvedValue(undefined);
    state.createRuntime.mockResolvedValue({
      dispose: state.disposeRuntime,
      getConfig: () => ({ maxTurns: -1 }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => null,
      getRecoveredFinalResponse: async () => undefined,
      executeUserShellCommand: vi.fn(),
    });
    state.chatStream.mockImplementation(async function* () {
      for (const event of comprehensiveLoopEvents()) yield event;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 3, duration: 1 },
      };
    });
    state.createAgent.mockResolvedValue({ chatStream: state.chatStream });
  });

  it('projects the complete loop event surface and disposes the runtime', async () => {
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect and edit',
        outputFormat: 'jsonl',
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    const events = stdout.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(exitCode).toBe(0);
    expect(new Set(events.map((event) => event.type))).toEqual(
      expect.objectContaining(
        new Set([
          'content_delta',
          'thinking_delta',
          'stream_end',
          'tool_start',
          'tool_progress',
          'tool_result',
          'tool_detail',
          'token_usage',
          'compacting',
          'task_update',
          'goal_frontier',
          'turn_recovery',
          'structured_output',
          'mcp_catalog_changed',
          'mcp_content_changed',
          'mcp_resource_updated',
          'mcp_connection_changed',
          'mcp_log',
          'mcp_instructions_changed',
          'mcp_task_changed',
          'project_rules_loaded',
          'goal',
          'subagent',
          'model_fallback',
          'provider_admission',
          'provider_retry',
          'provider_circuit',
          'provider_stall',
          'provider_recovery',
          'turn_activity',
          'action_stationarity',
          'phase',
        ])
      )
    );
    expect(state.createAgent).toHaveBeenCalledOnce();
    expect(state.disposeRuntime).toHaveBeenCalledOnce();
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
