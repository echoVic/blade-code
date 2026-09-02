import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type SessionSurfaceMessage,
  SessionSurfaceMessageSchema,
} from '../../../src/api/sessionSurfaceSchemas.js';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  projectSessionSurfaceMessages,
  SessionSurfaceProjectionError,
} from '../../../src/services/sessionSurfaceProjection.js';

type MessageCreatedEvent = Extract<SessionEvent, { type: 'message_created' }>;
type PartCreatedEvent = Extract<SessionEvent, { type: 'part_created' }>;
type PartUpdatedEvent = Extract<SessionEvent, { type: 'part_updated' }>;
type RewindEvent = Extract<SessionEvent, { type: 'session_rewound' }>;

const SESSION_ID = 'surface-session';
const CWD = '/workspace/project';
const POSIX_ROOT = '/Users/example/.blade/state';
const WINDOWS_ROOT = 'C:\\Users\\example\\AppData\\Local\\Blade';
const DIGEST_DOMAIN = 'session-surface-message\0';

let nextSeq = 0;

function resetSequence(): void {
  nextSeq = 0;
}

function baseEvent(type: SessionEvent['type']) {
  nextSeq += 1;
  return {
    id: `event-${nextSeq}`,
    seq: nextSeq,
    sessionId: SESSION_ID,
    timestamp: `2026-09-03T00:00:${String(nextSeq).padStart(2, '0')}.000Z`,
    type,
    cwd: CWD,
    version: 'test',
  };
}

function createMessage(
  messageId: string,
  role: 'user' | 'assistant' | 'system' | 'tool',
  options: {
    createdAt?: string;
    metadata?: MessageCreatedEvent['data']['metadata'];
    parentMessageId?: string;
  } = {}
): MessageCreatedEvent {
  const event = baseEvent('message_created');
  return {
    ...event,
    type: 'message_created',
    data: {
      messageId,
      role,
      createdAt: options.createdAt ?? event.timestamp,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.parentMessageId ? { parentMessageId: options.parentMessageId } : {}),
    },
  } satisfies SessionEvent;
}

function createTextPart(
  messageId: string,
  partId: string,
  text: string
): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'text',
      payload: { text },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function updateTextPart(
  messageId: string,
  partId: string,
  text: string
): PartUpdatedEvent {
  const event = baseEvent('part_updated');
  return {
    ...event,
    type: 'part_updated',
    data: {
      messageId,
      partId,
      partType: 'text',
      payload: { text },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createImagePart(messageId: string, partId: string): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'image',
      payload: { dataUrl: 'data:image/png;base64,AA==' },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createReasoningPart(
  messageId: string,
  partId: string,
  text: string
): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'reasoning',
      payload: { text },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createToolCallPart(messageId: string, partId: string): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'tool_call',
      payload: {
        toolCallId: `call-${partId}`,
        toolName: 'Bash',
        input: { canary: 'TOOL_INPUT_CANARY' },
      },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createToolResultPart(messageId: string, partId: string): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'tool_result',
      payload: {
        toolCallId: `call-${partId}`,
        toolName: 'Bash',
        output: 'TOOL_OUTPUT_CANARY',
      },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createSummaryPart(messageId: string, partId: string): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'summary',
      payload: { text: 'SUMMARY_CANARY' },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createSubtaskRefPart(messageId: string, partId: string): PartCreatedEvent {
  const event = baseEvent('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      messageId,
      partId,
      partType: 'subtask_ref',
      payload: {
        subagentSessionId: 'subagent-1',
        subagentType: 'worker',
        subagentStatus: 'completed',
        subagentSummary: 'SUBTASK_CANARY',
      },
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function createRewind(targetMessageId: string): RewindEvent {
  const event = baseEvent('session_rewound');
  return {
    ...event,
    type: 'session_rewound',
    data: {
      rewindId: `rewind-${event.seq}`,
      targetMessageId,
      mode: 'conversation',
      restoredFiles: [],
      createdAt: event.timestamp,
    },
  } satisfies SessionEvent;
}

function expectedSurfaceId(seq: number, messageId: string): string {
  return `surface-message:${seq}:${createHash('sha256')
    .update(DIGEST_DOMAIN)
    .update(messageId)
    .digest('hex')
    .slice(0, 16)}`;
}

function committedSeq(event: { seq?: number }): number {
  const seq = event.seq;
  if (seq === undefined || !Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error('expected committed positive seq in test fixture');
  }
  return seq;
}

function containsDisallowedControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code === 0 ||
      (code >= 1 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    );
  });
}

function repeatedCharacter(character: string, count: number): string {
  return Array.from({ length: count }, () => character).join('');
}

function assertStrictMessage(
  message: SessionSurfaceMessage,
  expectedKeys: readonly string[]
): void {
  expect(SessionSurfaceMessageSchema.parse(message)).toEqual(message);
  expect(Object.keys(message)).toEqual([...expectedKeys]);
}

describe('projectSessionSurfaceMessages', () => {
  it('projects strict visible messages with shell rendering, final parts, redaction, control stripping, and duplicate preservation', () => {
    resetSequence();

    const userMessage = createMessage('user-shell', 'user', {
      metadata: {
        userShellCommand: {
          version: 1,
          command: `cat ${POSIX_ROOT}/notes.txt && type ${WINDOWS_ROOT}\\notes.txt`,
          status: 'completed',
          exitCode: 0,
          durationMs: 5,
          stdout: `${POSIX_ROOT}/stdout.log`,
          stderr: `${WINDOWS_ROOT}\\stderr.log`,
          stdoutOmittedBytes: 0,
          stderrOmittedBytes: 0,
          binaryOutput: false,
          truncated: false,
        },
        privateCanary: `${POSIX_ROOT}/metadata-only.txt`,
      },
    });
    const assistantMessage = createMessage('assistant-visible', 'assistant', {
      parentMessageId: 'user-shell',
      metadata: {
        privateCanary: `${WINDOWS_ROOT}\\assistant-meta.txt`,
      },
    });
    const systemMessage = createMessage('system-hidden', 'system');
    const toolMessage = createMessage('tool-hidden', 'tool');
    const hiddenAssistant = createMessage('assistant-hidden', 'assistant', {
      metadata: {
        clientVisible: false,
        privateCanary: `${POSIX_ROOT}/hidden.txt`,
      },
    });
    const duplicateOne = createMessage('assistant-duplicate-1', 'assistant');
    const duplicateTwo = createMessage('assistant-duplicate-2', 'assistant');

    const projected = projectSessionSurfaceMessages(
      [
        userMessage,
        createTextPart('user-shell', 'user-shell-text', 'typed command'),
        assistantMessage,
        createTextPart(
          'assistant-visible',
          'assistant-text',
          `draft ${POSIX_ROOT}/draft.txt`
        ),
        createReasoningPart(
          'assistant-visible',
          'assistant-reasoning',
          'REASONING_CANARY'
        ),
        createToolCallPart('assistant-visible', 'assistant-tool-call'),
        createToolResultPart('assistant-visible', 'assistant-tool-result'),
        createSummaryPart('assistant-visible', 'assistant-summary'),
        createSubtaskRefPart('assistant-visible', 'assistant-subtask'),
        createImagePart('assistant-visible', 'assistant-image'),
        updateTextPart(
          'assistant-visible',
          'assistant-text',
          [
            `final ${POSIX_ROOT}/visible.txt`,
            `and ${WINDOWS_ROOT}\\nested\\file.txt`,
            '\u001B]52;c;ZXhmaWx0cmF0ZQ==\u0007removed osc52',
            '\u001B]8;;https://evil.example\u0007click me\u001B]8;;\u0007',
            '\u001B[31mred text\u001B[0m',
            '\u0007\u0008\u000D\u0085',
            '\n[badge preserved]',
          ].join(' ')
        ),
        systemMessage,
        createTextPart('system-hidden', 'system-text', 'SYSTEM_CANARY'),
        toolMessage,
        createTextPart('tool-hidden', 'tool-text', 'TOOL_ROLE_CANARY'),
        hiddenAssistant,
        createTextPart('assistant-hidden', 'assistant-hidden-text', 'HIDDEN_CANARY'),
        duplicateOne,
        createTextPart('assistant-duplicate-1', 'duplicate-1-text', 'repeat me'),
        duplicateTwo,
        createTextPart('assistant-duplicate-2', 'duplicate-2-text', 'repeat me'),
      ],
      {
        privateRoots: [POSIX_ROOT],
        bladeStorageRoots: [WINDOWS_ROOT],
      }
    );

    expect(projected).toHaveLength(4);
    expect(projected.map((message) => message.id)).toEqual([
      expectedSurfaceId(committedSeq(userMessage), 'user-shell'),
      expectedSurfaceId(committedSeq(assistantMessage), 'assistant-visible'),
      expectedSurfaceId(committedSeq(duplicateOne), 'assistant-duplicate-1'),
      expectedSurfaceId(committedSeq(duplicateTwo), 'assistant-duplicate-2'),
    ]);

    const userProjection = projected[0];
    const assistantProjection = projected[1];
    const duplicateProjectionOne = projected[2];
    const duplicateProjectionTwo = projected[3];

    expect(userProjection).toMatchObject({
      role: 'user',
      timestamp: userMessage.data.createdAt,
    });
    expect(userProjection.content).toContain('! cat [private state path]');
    expect(userProjection.content).toContain('type [private state path]');
    expect(userProjection.content).toContain('stderr:\n[private state path]');
    expect(userProjection.content).not.toContain(POSIX_ROOT);
    expect(userProjection.content).not.toContain(WINDOWS_ROOT);
    assertStrictMessage(userProjection, ['id', 'role', 'content', 'timestamp']);

    expect(assistantProjection).toMatchObject({
      role: 'assistant',
      timestamp: assistantMessage.data.createdAt,
    });
    expect(assistantProjection.content).toContain('final [private state path]');
    expect(assistantProjection.content).toContain('and [private state path]');
    expect(assistantProjection.content).toContain('removed osc52');
    expect(assistantProjection.content).toContain('click me');
    expect(assistantProjection.content).toContain('red text');
    expect(assistantProjection.content).toContain('\n[badge preserved]');
    expect(assistantProjection.content).toContain('[Image]');
    expect(assistantProjection.content).not.toContain('draft');
    expect(assistantProjection.content).not.toContain(POSIX_ROOT);
    expect(assistantProjection.content).not.toContain(WINDOWS_ROOT);
    expect(assistantProjection.content).not.toContain('REASONING_CANARY');
    expect(assistantProjection.content).not.toContain('TOOL_INPUT_CANARY');
    expect(assistantProjection.content).not.toContain('TOOL_OUTPUT_CANARY');
    expect(assistantProjection.content).not.toContain('SUMMARY_CANARY');
    expect(assistantProjection.content).not.toContain('SUBTASK_CANARY');
    expect(containsDisallowedControlCharacters(assistantProjection.content)).toBe(
      false
    );
    assertStrictMessage(assistantProjection, ['id', 'role', 'content', 'timestamp']);

    expect(duplicateProjectionOne.content).toBe('repeat me');
    expect(duplicateProjectionTwo.content).toBe('repeat me');
    expect(duplicateProjectionOne.id).not.toBe(duplicateProjectionTwo.id);
    assertStrictMessage(duplicateProjectionOne, ['id', 'role', 'content', 'timestamp']);
    assertStrictMessage(duplicateProjectionTwo, ['id', 'role', 'content', 'timestamp']);

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('SYSTEM_CANARY');
    expect(serialized).not.toContain('TOOL_ROLE_CANARY');
    expect(serialized).not.toContain('HIDDEN_CANARY');
    expect(serialized).not.toContain('privateCanary');
    expect(serialized).not.toContain('assistant-visible');
  });

  it('materializes rewinds before projecting the visible surface', () => {
    resetSequence();

    const userOne = createMessage('user-1', 'user');
    const assistantOne = createMessage('assistant-1', 'assistant', {
      parentMessageId: 'user-1',
    });
    const userTwo = createMessage('user-2', 'user');
    const assistantTwo = createMessage('assistant-2', 'assistant', {
      parentMessageId: 'user-2',
    });
    const userThree = createMessage('user-3', 'user');

    const projected = projectSessionSurfaceMessages(
      [
        userOne,
        createTextPart('user-1', 'user-1-text', 'first request'),
        assistantOne,
        createTextPart('assistant-1', 'assistant-1-text', 'first answer'),
        userTwo,
        createTextPart('user-2', 'user-2-text', 'second request'),
        assistantTwo,
        createTextPart('assistant-2', 'assistant-2-text', 'second answer'),
        createRewind('user-2'),
        userThree,
        createTextPart('user-3', 'user-3-text', 'replacement request'),
      ],
      { privateRoots: [] }
    );

    expect(projected.map((message) => message.content)).toEqual([
      'first request',
      'first answer',
      'replacement request',
    ]);
    expect(JSON.stringify(projected)).not.toContain('second request');
    expect(JSON.stringify(projected)).not.toContain('second answer');
  });

  it('throws a typed projection error for invalid committed message sequences', () => {
    resetSequence();

    const invalidSequenceMessage: MessageCreatedEvent = {
      id: 'bad-seq-event',
      seq: 0,
      sessionId: SESSION_ID,
      timestamp: '2026-09-03T00:00:00.000Z',
      type: 'message_created',
      cwd: CWD,
      version: 'test',
      data: {
        messageId: 'bad-seq-message',
        role: 'user',
        createdAt: '2026-09-03T00:00:00.000Z',
      },
    };

    expect(() =>
      projectSessionSurfaceMessages(
        [
          invalidSequenceMessage,
          createTextPart('bad-seq-message', 'bad-seq-text', 'hello'),
        ],
        { privateRoots: [] }
      )
    ).toThrow(SessionSurfaceProjectionError);
  });

  it('preserves valid original timestamps and redacts invalid timestamp errors', () => {
    resetSequence();

    const offsetTimestamp = '2026-09-03T08:00:00+08:00';
    const validTimestampMessage = createMessage('valid-time', 'assistant', {
      createdAt: offsetTimestamp,
    });
    expect(
      projectSessionSurfaceMessages(
        [
          validTimestampMessage,
          createTextPart('valid-time', 'valid-time-text', 'hello'),
        ],
        { privateRoots: [] }
      )
    ).toMatchObject([{ timestamp: offsetTimestamp }]);

    const invalidTimestampMessage = createMessage('bad-time', 'assistant', {
      createdAt: 'INVALID_TIMESTAMP_PRIVATE_CANARY',
    });
    let thrown: unknown;
    try {
      projectSessionSurfaceMessages(
        [invalidTimestampMessage, createTextPart('bad-time', 'bad-time-text', 'hello')],
        { privateRoots: [] }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionSurfaceProjectionError);
    if (!(thrown instanceof SessionSurfaceProjectionError)) {
      throw new Error('expected SessionSurfaceProjectionError');
    }
    expect(thrown).toMatchObject({
      code: 'session_surface_state_invalid',
      message: 'session surface projection state is invalid',
    });
    expect(String(thrown)).not.toContain('INVALID_TIMESTAMP_PRIVATE_CANARY');
  });

  it('rejects impossible calendar timestamps even when Date.parse normalizes them', () => {
    resetSequence();

    const invalidTimestampMessage = createMessage('bad-calendar-time', 'assistant', {
      createdAt: '2026-02-30T00:00:00.000Z',
    });

    expect(() =>
      projectSessionSurfaceMessages(
        [
          invalidTimestampMessage,
          createTextPart('bad-calendar-time', 'bad-time-text', 'hello'),
        ],
        { privateRoots: [] }
      )
    ).toThrow(SessionSurfaceProjectionError);
  });

  it('caps content on UTF-8 byte boundaries and only marks truly oversized messages as truncated', () => {
    resetSequence();

    const exactFitMessage = createMessage('exact-fit', 'assistant');
    const truncatedMessage = createMessage('truncated', 'assistant');
    const exactFitContent = '🙂';
    const truncatedContent = '🙂🙂🙂🙂🙂🙂🙂';
    const truncationBudget = Buffer.byteLength('🙂\n[content truncated]');

    const projected = projectSessionSurfaceMessages(
      [
        exactFitMessage,
        createTextPart('exact-fit', 'exact-fit-text', exactFitContent),
        truncatedMessage,
        createTextPart('truncated', 'truncated-text', truncatedContent),
      ],
      {
        privateRoots: [],
        maxContentBytes: truncationBudget,
      }
    );

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      id: expectedSurfaceId(committedSeq(exactFitMessage), 'exact-fit'),
      role: 'assistant',
      content: exactFitContent,
      timestamp: exactFitMessage.data.createdAt,
    });
    expect(projected[0]?.truncated).toBeUndefined();
    assertStrictMessage(projected[0], ['id', 'role', 'content', 'timestamp']);

    expect(projected[1]).toMatchObject({
      id: expectedSurfaceId(committedSeq(truncatedMessage), 'truncated'),
      role: 'assistant',
      content: '🙂\n[content truncated]',
      timestamp: truncatedMessage.data.createdAt,
      truncated: true,
    });
    expect(Buffer.byteLength(projected[1].content, 'utf8')).toBe(truncationBudget);
    expect(projected[1].content).not.toContain('\uFFFD');
    assertStrictMessage(projected[1], [
      'id',
      'role',
      'content',
      'timestamp',
      'truncated',
    ]);
  });

  it('normalizes terminal controls before redacting private roots so split escape attacks cannot reconstruct private paths', () => {
    resetSequence();

    const attackMessage = createMessage('path-attack', 'assistant');
    const attackedRoot = '/private/root';

    const projected = projectSessionSurfaceMessages(
      [
        attackMessage,
        createTextPart(
          'path-attack',
          'path-attack-text',
          `/private/\u001B[31mroot/secret.txt`
        ),
      ],
      { privateRoots: [attackedRoot] }
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe('[private state path]');
    expect(projected[0]?.content).not.toContain('/private/root');
    expect(projected[0]?.content).not.toContain('secret.txt');
  });

  it('filters legacy verification control messages after assembling raw content', () => {
    resetSequence();

    const legacyControlMessage = createMessage('legacy-control', 'user');
    const visibleMessage = createMessage('legacy-visible', 'user');

    const projected = projectSessionSurfaceMessages(
      [
        legacyControlMessage,
        createTextPart(
          'legacy-control',
          'legacy-control-text',
          [
            'This turn made a non-trivial implementation. Before finishing, call Task 12.',
            'Only a fresh structured PASS verdict allows completion.',
          ].join(' ')
        ),
        visibleMessage,
        createTextPart('legacy-visible', 'legacy-visible-text', 'keep me'),
      ],
      { privateRoots: [] }
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe('keep me');
    expect(JSON.stringify(projected)).not.toContain('structured PASS verdict');
  });

  it('caps truncated content within tiny budgets and safely clips the marker itself', () => {
    resetSequence();

    const budgets = [1, 5, 10] as const;

    for (const budget of budgets) {
      const oversizedMessage = createMessage(`tiny-budget-${budget}`, 'assistant');
      const projected = projectSessionSurfaceMessages(
        [
          oversizedMessage,
          createTextPart(
            `tiny-budget-${budget}`,
            `tiny-budget-text-${budget}`,
            repeatedCharacter('🙂', 32)
          ),
        ],
        {
          privateRoots: [],
          maxContentBytes: budget,
        }
      );

      expect(projected).toHaveLength(1);
      expect(projected[0]?.truncated).toBe(true);
      expect(
        Buffer.byteLength(projected[0]?.content ?? '', 'utf8')
      ).toBeLessThanOrEqual(budget);
      expect(projected[0]?.content).not.toContain('\uFFFD');
    }
  });
});
