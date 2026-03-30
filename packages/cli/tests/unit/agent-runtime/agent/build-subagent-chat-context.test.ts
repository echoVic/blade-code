import { describe, expect, it } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { buildSubagentChatContext } from '../../../../src/agent/subagents/buildSubagentChatContext.js';

describe('buildSubagentChatContext', () => {
  it('builds a chat context with subagent metadata and default messages', () => {
    const context = buildSubagentChatContext({
      sessionId: 'subagent-session',
      permissionMode: PermissionMode.AUTO_EDIT,
      systemPrompt: 'You are an explorer',
      parentSessionId: 'parent-session',
      subagentType: 'Explore',
    });

    expect(context).toEqual({
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

  it('preserves provided messages and workspace overrides', () => {
    const existingMessages = [{ role: 'user', content: 'previous' }] as any;

    const context = buildSubagentChatContext({
      messages: existingMessages,
      sessionId: 'subagent-session',
      workspaceRoot: '/tmp/project',
      subagentType: 'Explore',
    });

    expect(context.messages).toBe(existingMessages);
    expect(context.workspaceRoot).toBe('/tmp/project');
    expect(context.subagentInfo).toEqual({
      parentSessionId: '',
      subagentType: 'Explore',
      isSidechain: false,
    });
  });
});
