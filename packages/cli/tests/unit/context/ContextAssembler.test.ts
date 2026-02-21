/**
 * ContextAssembler 单元测试
 */

import { describe, expect, it } from 'vitest';
import { ContextAssembler } from '../../../src/context/ContextAssembler.js';
import type { SessionEvent } from '../../../src/context/types.js';

// Helper: 创建基础事件字段
const base = (
  type: string,
  sessionId = 'sess-1',
  timestamp = '2026-02-21T10:00:00.000Z'
): Omit<SessionEvent, 'type' | 'data'> => ({
  id: `evt-${Math.random().toString(36).slice(2, 8)}`,
  sessionId,
  timestamp,
  type: type as any,
  cwd: '/tmp/test',
  version: '1.0.0',
});

function sessionCreatedEvent(sessionId = 'sess-1', ts = '2026-02-21T10:00:00.000Z'): SessionEvent {
  return {
    ...base('session_created', sessionId, ts),
    type: 'session_created',
    data: {
      sessionId,
      rootId: sessionId,
      createdAt: ts,
    },
  } as SessionEvent;
}

function messageCreatedEvent(
  messageId: string,
  role: 'user' | 'assistant' | 'system',
  ts = '2026-02-21T10:01:00.000Z',
  model?: string
): SessionEvent {
  return {
    ...base('message_created', 'sess-1', ts),
    type: 'message_created',
    data: { messageId, role, createdAt: ts, model },
  } as SessionEvent;
}

function textPartEvent(messageId: string, text: string, ts = '2026-02-21T10:01:01.000Z'): SessionEvent {
  return {
    ...base('part_created', 'sess-1', ts),
    type: 'part_created',
    data: {
      partId: `part-${Math.random().toString(36).slice(2, 8)}`,
      messageId,
      partType: 'text',
      payload: { text },
      createdAt: ts,
    },
  } as SessionEvent;
}

function summaryPartEvent(messageId: string, text: string, ts = '2026-02-21T10:05:00.000Z'): SessionEvent {
  return {
    ...base('part_created', 'sess-1', ts),
    type: 'part_created',
    data: {
      partId: `part-${Math.random().toString(36).slice(2, 8)}`,
      messageId,
      partType: 'summary',
      payload: { text, metadata: { trigger: 'auto', preTokens: 5000 } },
      createdAt: ts,
    },
  } as SessionEvent;
}

function toolCallPartEvent(
  messageId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  ts = '2026-02-21T10:02:00.000Z'
): SessionEvent {
  return {
    ...base('part_created', 'sess-1', ts),
    type: 'part_created',
    data: {
      partId: toolCallId,
      messageId,
      partType: 'tool_call',
      payload: { toolCallId, toolName, input },
      createdAt: ts,
    },
  } as SessionEvent;
}

function toolResultPartEvent(
  messageId: string,
  toolCallId: string,
  toolName: string,
  output: unknown,
  error?: string,
  ts = '2026-02-21T10:02:30.000Z'
): SessionEvent {
  return {
    ...base('part_created', 'sess-1', ts),
    type: 'part_created',
    data: {
      partId: toolCallId,
      messageId,
      partType: 'tool_result',
      payload: { toolCallId, toolName, output, error: error ?? null },
      createdAt: ts,
    },
  } as SessionEvent;
}

function partUpdatedEvent(messageId: string, text: string, ts = '2026-02-21T10:03:00.000Z'): SessionEvent {
  return {
    ...base('part_updated', 'sess-1', ts),
    type: 'part_updated',
    data: {
      partId: `part-upd`,
      messageId,
      partType: 'text',
      payload: { text },
      createdAt: ts,
    },
  } as SessionEvent;
}

function sessionUpdatedEvent(data: Record<string, unknown>, ts = '2026-02-21T10:04:00.000Z'): SessionEvent {
  return {
    ...base('session_updated', 'sess-1', ts),
    type: 'session_updated',
    data,
  } as SessionEvent;
}

describe('ContextAssembler', () => {
  const assembler = new ContextAssembler();

  describe('assemble', () => {
    it('should return null for empty events', () => {
      expect(assembler.assemble([])).toBeNull();
    });

    it('should assemble a basic session with one message', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'user'),
        textPartEvent('msg-1', 'Hello world'),
      ];

      const result = assembler.assemble(events)!;
      expect(result).not.toBeNull();
      expect(result.session.sessionId).toBe('sess-1');
      expect(result.conversation.messages).toHaveLength(1);
      expect(result.conversation.messages[0].content).toBe('Hello world');
      expect(result.conversation.messages[0].role).toBe('user');
      expect(result.toolCalls).toHaveLength(0);
    });

    it('should assemble multiple messages in order', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'user', '2026-02-21T10:01:00.000Z'),
        textPartEvent('msg-1', 'What is 1+1?', '2026-02-21T10:01:01.000Z'),
        messageCreatedEvent('msg-2', 'assistant', '2026-02-21T10:01:02.000Z'),
        textPartEvent('msg-2', '1+1 = 2', '2026-02-21T10:01:03.000Z'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.messages).toHaveLength(2);
      expect(result.conversation.messages[0].content).toBe('What is 1+1?');
      expect(result.conversation.messages[1].content).toBe('1+1 = 2');
    });

    it('should preserve model metadata on messages', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant', '2026-02-21T10:01:00.000Z', 'claude-3-opus'),
        textPartEvent('msg-1', 'Hello'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.messages[0].metadata).toEqual({ model: 'claude-3-opus' });
    });

    it('should not add metadata when model is undefined', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'user'),
        textPartEvent('msg-1', 'Hello'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.messages[0].metadata).toBeUndefined();
    });
  });

  describe('assembleSession', () => {
    it('should extract sessionId and startTime from session_created', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent('my-session', '2026-02-21T08:00:00.000Z'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.session.sessionId).toBe('my-session');
      expect(result.session.startTime).toBe(new Date('2026-02-21T08:00:00.000Z').getTime());
    });

    it('should fallback to first event when no session_created', () => {
      const events: SessionEvent[] = [
        messageCreatedEvent('msg-1', 'user', '2026-02-21T09:00:00.000Z'),
        textPartEvent('msg-1', 'Hello'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.session.sessionId).toBe('sess-1');
    });

    it('should pick latest session_updated for configuration', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        sessionUpdatedEvent({ model: 'gpt-4' }, '2026-02-21T10:01:00.000Z'),
        sessionUpdatedEvent({ model: 'claude-3' }, '2026-02-21T10:02:00.000Z'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.session.configuration).toEqual({ model: 'claude-3' });
    });

    it('should have empty configuration when no session_updated', () => {
      const events: SessionEvent[] = [sessionCreatedEvent()];

      const result = assembler.assemble(events)!;
      expect(result.session.configuration).toEqual({});
    });
  });

  describe('assembleConversation - summary', () => {
    it('should extract compaction summary', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-s', 'system', '2026-02-21T10:05:00.000Z'),
        summaryPartEvent('msg-s', 'This is a summary of the conversation.'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.summary).toBe('This is a summary of the conversation.');
    });

    it('should use latest summary when multiple exist', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-s1', 'system', '2026-02-21T10:05:00.000Z'),
        summaryPartEvent('msg-s1', 'First summary', '2026-02-21T10:05:00.000Z'),
        messageCreatedEvent('msg-s2', 'system', '2026-02-21T10:10:00.000Z'),
        summaryPartEvent('msg-s2', 'Second summary', '2026-02-21T10:10:00.000Z'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.summary).toBe('Second summary');
    });

    it('should have undefined summary when no summary parts', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'user'),
        textPartEvent('msg-1', 'Hello'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.summary).toBeUndefined();
    });
  });

  describe('assembleConversation - part_updated', () => {
    it('should overwrite message content on part_updated', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant'),
        textPartEvent('msg-1', 'Original text'),
        partUpdatedEvent('msg-1', 'Updated text'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.conversation.messages[0].content).toBe('Updated text');
    });
  });

  describe('assembleToolCalls', () => {
    it('should assemble tool call with pending status', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant'),
        toolCallPartEvent('msg-1', 'tc-1', 'ReadFile', { path: '/tmp/test.ts' }),
      ];

      const result = assembler.assemble(events)!;
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('ReadFile');
      expect(result.toolCalls[0].status).toBe('pending');
      expect(result.toolCalls[0].input).toEqual({ path: '/tmp/test.ts' });
    });

    it('should match tool result to existing tool call', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant'),
        toolCallPartEvent('msg-1', 'tc-1', 'ReadFile', { path: '/tmp/test.ts' }),
        toolResultPartEvent('msg-1', 'tc-1', 'ReadFile', { content: 'file content' }),
      ];

      const result = assembler.assemble(events)!;
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].status).toBe('success');
      expect(result.toolCalls[0].output).toEqual({ content: 'file content' });
    });

    it('should mark tool call as error when error present', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant'),
        toolCallPartEvent('msg-1', 'tc-1', 'ReadFile', { path: '/nonexistent' }),
        toolResultPartEvent('msg-1', 'tc-1', 'ReadFile', null, 'File not found'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].status).toBe('error');
      expect(result.toolCalls[0].error).toBe('File not found');
    });

    it('should handle orphaned tool result (no matching call)', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant'),
        toolResultPartEvent('msg-1', 'tc-orphan', 'WriteFile', { written: true }),
      ];

      const result = assembler.assemble(events)!;
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe('tc-orphan');
      expect(result.toolCalls[0].name).toBe('WriteFile');
      expect(result.toolCalls[0].status).toBe('success');
    });

    it('should assemble multiple tool calls', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'assistant'),
        toolCallPartEvent('msg-1', 'tc-1', 'ReadFile', { path: 'a.ts' }, '2026-02-21T10:02:00.000Z'),
        toolCallPartEvent('msg-1', 'tc-2', 'ReadFile', { path: 'b.ts' }, '2026-02-21T10:02:01.000Z'),
        toolResultPartEvent('msg-1', 'tc-1', 'ReadFile', 'content-a', undefined, '2026-02-21T10:02:02.000Z'),
        toolResultPartEvent('msg-1', 'tc-2', 'ReadFile', 'content-b', undefined, '2026-02-21T10:02:03.000Z'),
      ];

      const result = assembler.assemble(events)!;
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].status).toBe('success');
      expect(result.toolCalls[1].status).toBe('success');
    });
  });

  describe('assembleContextData', () => {
    const mockSystem = { platform: 'test', version: '1.0' } as any;
    const mockWorkspace = { rootPath: '/tmp', files: [] } as any;

    it('should return null for empty events', () => {
      expect(assembler.assembleContextData([], mockSystem, mockWorkspace)).toBeNull();
    });

    it('should build complete ContextData with all layers', () => {
      const events: SessionEvent[] = [
        sessionCreatedEvent(),
        messageCreatedEvent('msg-1', 'user'),
        textPartEvent('msg-1', 'Hello'),
        messageCreatedEvent('msg-2', 'assistant'),
        toolCallPartEvent('msg-2', 'tc-1', 'Bash', { command: 'ls' }),
        toolResultPartEvent('msg-2', 'tc-1', 'Bash', 'file1.ts\nfile2.ts'),
        textPartEvent('msg-2', 'Here are the files.'),
      ];

      const result = assembler.assembleContextData(events, mockSystem, mockWorkspace)!;
      expect(result).not.toBeNull();

      // layers 完整
      expect(result.layers.system).toBe(mockSystem);
      expect(result.layers.workspace).toBe(mockWorkspace);
      expect(result.layers.session.sessionId).toBe('sess-1');
      expect(result.layers.conversation.messages).toHaveLength(2);
      expect(result.layers.tool.recentCalls).toHaveLength(1);
      expect(result.layers.tool.recentCalls[0].name).toBe('Bash');
      expect(result.layers.tool.recentCalls[0].status).toBe('success');

      // metadata
      expect(result.metadata.totalTokens).toBe(0);
      expect(result.metadata.priority).toBe(1);
    });
  });
});
