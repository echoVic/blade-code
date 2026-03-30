import { describe, expect, it } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { buildSubagentLoopInvocation } from '../../../../src/agent/subagents/buildSubagentLoopInvocation.js';

describe('buildSubagentLoopInvocation', () => {
  it('packages prompt, chat context, and loop options for subagent execution', () => {
    const loopOptions = { stream: false };

    const invocation = buildSubagentLoopInvocation({
      prompt: 'inspect project',
      sessionId: 'subagent-session',
      permissionMode: PermissionMode.AUTO_EDIT,
      systemPrompt: 'You are an explorer',
      parentSessionId: 'parent-session',
      subagentType: 'Explore',
      loopOptions,
    });

    expect(invocation.message).toBe('inspect project');
    expect(invocation.options).toBe(loopOptions);
    expect(invocation.context).toEqual({
      messages: [],
      userId: 'subagent',
      sessionId: 'subagent-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.AUTO_EDIT,
      systemPrompt: 'You are an explorer',
      subagentInfo: {
        parentSessionId: 'parent-session',
        subagentType: 'Explore',
        isSidechain: false,
      },
    });
  });
});
