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

  it('does not surface hidden token budget handoff markers in public resume messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'before visible' },
      {
        id: 'handoff-message-1',
        role: 'user',
        content:
          '<token-budget-handoff version="1">\n' +
          'Context rollover is approaching. Continue the user task from this state only.\n' +
          'Make objective, decisions, mutations, verification, background work, blockers, and the exact next action explicit.\n' +
          'Do not claim success or completion unless it is already proven in the transcript.\n' +
          'Do not create bookkeeping files the user did not request.\n' +
          'Remaining prompt-token headroom before compaction: 5.',
        metadata: {
          clientVisible: false,
          tokenBudgetHandoff: {
            version: 1,
            messageId: 'handoff-message-1',
          },
        },
      },
      { role: 'assistant', content: 'after visible' },
    ];

    expect(SessionService.toUISafeMessages(messages)).toMatchObject([
      { role: 'user', content: 'before visible' },
      { role: 'assistant', content: 'after visible' },
    ]);
    expect(SessionService.toUISafeMessages(messages)).not.toContainEqual(
      expect.objectContaining({ id: 'handoff-message-1' })
    );
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

describe('SessionService durable tool result restoration', () => {
  const base = {
    sessionId: 'durable-tool-session',
    timestamp: '2026-08-13T00:00:00.000Z',
    cwd: '/workspace',
    version: 'test',
  };

  it('restores object output and failed null output without rendering null', () => {
    const entries: SessionEvent[] = [
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
        id: 'success-result',
        type: 'part_created',
        data: {
          partId: 'success-result',
          messageId: 'assistant-message',
          partType: 'tool_result',
          payload: {
            toolCallId: 'success-call',
            toolName: 'Bash',
            output: { stdout: 'SAFE_TAIL', stderr: '' },
            error: null,
            metadata: { output_truncated: false },
          },
          createdAt: base.timestamp,
        },
      },
      {
        ...base,
        id: 'failed-result',
        type: 'part_created',
        data: {
          partId: 'failed-result',
          messageId: 'assistant-message',
          partType: 'tool_result',
          payload: {
            toolCallId: 'failed-call',
            toolName: 'Bash',
            output: null,
            error: 'Command interrupted because Blade restarted',
            metadata: { processRestartRecovery: true },
          },
          createdAt: base.timestamp,
        },
      },
    ];

    const tools = SessionService.convertJSONLToMessages(entries).filter(
      (message) => message.role === 'tool'
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]?.content).toBe('{"stdout":"SAFE_TAIL","stderr":""}');
    expect(tools[1]?.content).toBe(
      'Error: Command interrupted because Blade restarted'
    );
    expect(tools[1]?.content).not.toContain('null');
    expect(tools[1]?.metadata).toMatchObject({
      output: null,
      metadata: { processRestartRecovery: true },
    });
  });
});
