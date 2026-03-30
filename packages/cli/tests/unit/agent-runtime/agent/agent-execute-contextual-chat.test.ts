import { describe, expect, it, vi } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';

describe('Agent.executeContextualChat', () => {
  it('returns an empty string when the loop requests an early exit', async () => {
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.executeContextualLoop = vi.fn().mockResolvedValue({
      success: false,
      metadata: { shouldExitLoop: true },
    });
    agent.continueApprovedPlanExecution = vi.fn();

    const result = await agent.executeContextualChat(
      'hello',
      {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
      },
      { stream: false }
    );

    expect(result).toBe('');
    expect(agent.continueApprovedPlanExecution).not.toHaveBeenCalled();
  });

  it('continues execution when plan mode returns a target mode', async () => {
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.executeContextualLoop = vi.fn().mockResolvedValue({
      success: true,
      metadata: {
        targetMode: PermissionMode.AUTO_EDIT,
        planContent: 'follow steps',
      },
    });
    agent.continueApprovedPlanExecution = vi.fn().mockResolvedValue('done');

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.PLAN,
    };

    const result = await agent.executeContextualChat('hello', context as any, {
      stream: false,
    });

    expect(agent.continueApprovedPlanExecution).toHaveBeenCalledOnce();
    expect(result).toBe('done');
  });
});
