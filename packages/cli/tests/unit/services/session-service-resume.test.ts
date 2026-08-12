import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService.toUISafeMessages', () => {
  it('filters internal messages while preserving user-visible multimodal placeholders', () => {
    const messages: Message[] = [
      { role: 'system', content: 'internal summary' },
      {
        role: 'user',
        content: 'internal control',
        metadata: { clientVisible: false },
      },
      {
        role: 'user',
        content:
          'This turn made a non-trivial implementation. Before finishing, call Task ' +
          'with subagent_type="verification". Only a fresh structured PASS verdict ' +
          'allows completion.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at ' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,def' } },
        ],
      },
      { role: 'tool', content: '{"secret":"tool-json"}' },
      { role: 'assistant', content: 'Done' },
    ];

    expect(SessionService.toUISafeMessages(messages)).toMatchObject([
      { role: 'user', content: 'Look at [Image]' },
      { role: 'assistant', content: '[Image]' },
      { role: 'assistant', content: 'Done' },
    ]);
  });

  it('drops consecutive duplicate visible messages during resume normalization', () => {
    const messages: Message[] = [
      { role: 'user', content: 'same prompt' },
      { role: 'user', content: 'same prompt' },
      { role: 'assistant', content: 'same answer' },
      { role: 'assistant', content: 'same answer' },
    ];

    expect(SessionService.toUISafeMessages(messages)).toMatchObject([
      { role: 'user', content: 'same prompt' },
      { role: 'assistant', content: 'same answer' },
    ]);
  });

  it('projects durable user shell metadata without exposing model XML', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content:
          '<user_shell_command><command>pwd</command><result>private</result></user_shell_command>',
        metadata: {
          userShellCommand: {
            version: 1,
            command: 'pwd',
            status: 'completed',
            exitCode: 0,
            durationMs: 5,
            stdout: '/workspace',
            stderr: '',
            stdoutOmittedBytes: 0,
            stderrOmittedBytes: 0,
            binaryOutput: false,
            truncated: false,
          },
        },
      },
    ];

    expect(SessionService.toUISafeMessages(messages)).toMatchObject([
      {
        role: 'user',
        content: '! pwd\n/workspace',
        metadata: {
          userShellCommand: expect.objectContaining({
            status: 'completed',
          }),
        },
      },
    ]);
  });
});

describe('SessionService subagent history projection', () => {
  it('attaches subtask lineage stored under the tool-call identity', () => {
    const base = {
      sessionId: 'parent-session',
      timestamp: '2026-08-05T00:00:00.000Z',
      cwd: '/workspace',
      version: 'test',
    };
    const entries: SessionEvent[] = [
      {
        ...base,
        id: 'created',
        type: 'session_created',
        data: {
          sessionId: 'parent-session',
          rootId: 'parent-session',
          createdAt: base.timestamp,
          updatedAt: base.timestamp,
        },
      },
      {
        ...base,
        id: 'assistant-created',
        type: 'message_created',
        data: {
          messageId: 'assistant-message',
          role: 'assistant',
          createdAt: base.timestamp,
        },
      },
      {
        ...base,
        id: 'tool-call',
        type: 'part_created',
        data: {
          partId: 'tool-call-id',
          messageId: 'assistant-message',
          partType: 'tool_call',
          payload: {
            toolCallId: 'tool-call-id',
            toolName: 'Task',
            input: { subagent_type: 'Explore' },
          },
          createdAt: base.timestamp,
        },
      },
      {
        ...base,
        id: 'subtask-ref',
        type: 'part_created',
        data: {
          partId: 'subtask-ref-id',
          messageId: 'tool-call-id',
          partType: 'subtask_ref',
          payload: {
            childSessionId: 'agent-child',
            agentType: 'Explore',
            status: 'completed',
            resumedFrom: 'agent-source',
            rootAgentId: 'agent-root',
            resumeDepth: 2,
          },
          createdAt: base.timestamp,
        },
      },
    ];

    expect(SessionService.convertJSONLToMessages(entries)).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        metadata: {
          subtaskRef: expect.objectContaining({
            childSessionId: 'agent-child',
            resumedFrom: 'agent-source',
            rootAgentId: 'agent-root',
            resumeDepth: 2,
          }),
        },
      })
    );
  });
});
