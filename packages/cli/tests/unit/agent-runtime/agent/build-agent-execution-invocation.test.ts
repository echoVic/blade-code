import { describe, expect, it } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { buildAgentExecutionInvocation } from '../../../../src/agent/buildAgentExecutionInvocation.js';

describe('buildAgentExecutionInvocation', () => {
  it('packages agent loop invocation with an optional system prompt', () => {
    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    } as any;
    const options = { stream: false };

    const invocation = buildAgentExecutionInvocation({
      message: 'hello',
      context,
      options,
      systemPrompt: 'system',
    });

    expect(invocation).toEqual({
      message: 'hello',
      context,
      options,
      systemPrompt: 'system',
    });
  });
});
