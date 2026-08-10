import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  MAX_SESSION_MARKDOWN_ACTIVITY_BYTES,
  renderSessionMarkdown,
} from '../../../src/services/SessionMarkdownExporter.js';

const projectPath = '/private/tmp/export-workspace';
const timestamp = '2026-08-09T00:00:00.000Z';

function event(type: SessionEvent['type'], data: unknown, id: string): SessionEvent {
  return {
    id,
    sessionId: 'session-export',
    timestamp,
    type,
    cwd: projectPath,
    version: 'test',
    data,
  } as SessionEvent;
}

function message(
  messageId: string,
  role: 'user' | 'assistant' | 'system'
): SessionEvent {
  return event(
    'message_created',
    { messageId, role, createdAt: timestamp },
    `${messageId}-message`
  );
}

function part(
  messageId: string,
  partId: string,
  partType:
    | 'text'
    | 'reasoning'
    | 'image'
    | 'tool_call'
    | 'tool_result'
    | 'summary'
    | 'subtask_ref'
    | 'diff',
  payload: unknown,
  type: 'part_created' | 'part_updated' = 'part_created'
): SessionEvent {
  return event(
    type,
    {
      partId,
      messageId,
      partType,
      payload,
      createdAt: timestamp,
    },
    `${partType}-${partId}-${type}`
  );
}

const metadata = {
  sessionId: 'session-export',
  projectPath,
  taskSourceProjectPath: '/private/tmp/source-project',
  title: 'Export title',
  selectedModelId: 'model-safe',
  communicationStyle: 'project:strict' as const,
  communicationStyleDigest: 'a'.repeat(64),
  firstMessageTime: timestamp,
  lastMessageTime: '2026-08-09T00:01:00.000Z',
};

describe('SessionMarkdownExporter', () => {
  it('renders ordered user, assistant, image, summary, and optional reasoning sections', () => {
    const events = [
      message('user-1', 'user'),
      part('user-1', 'user-text', 'text', {
        text: 'Explain **the change**',
      }),
      part('user-1', 'image', 'image', {
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,RAW_IMAGE',
      }),
      message('assistant-1', 'assistant'),
      part('assistant-1', 'reasoning', 'reasoning', {
        text: 'private chain of thought',
      }),
      part('assistant-1', 'answer', 'text', {
        text: '```ts\nconst answer = 42;\n```',
      }),
      message('system-1', 'system'),
      part('system-1', 'internal', 'text', {
        text: '<turn_aborted>internal recovery</turn_aborted>',
      }),
      part('system-1', 'summary', 'summary', {
        text: 'Durable compact summary',
      }),
    ];

    const hidden = renderSessionMarkdown(events, metadata);
    expect(hidden.markdown).toContain('# Blade conversation');
    expect(hidden.markdown).toContain('## User\n\nExplain **the change**');
    expect(hidden.markdown).toContain('[Image: image/png]');
    expect(hidden.markdown).toContain('## Assistant\n\n```ts\nconst answer = 42;\n```');
    expect(hidden.markdown).toContain('## Summary\n\nDurable compact summary');
    expect(hidden.markdown).toContain('- Communication style: project:strict');
    expect(hidden.markdown).toContain(
      `- Communication style SHA-256: \`${'a'.repeat(64)}\``
    );
    expect(hidden.markdown).not.toContain('private chain of thought');
    expect(hidden.markdown).not.toContain('internal recovery');
    expect(hidden.markdown).not.toContain('RAW_IMAGE');
    expect(hidden.reasoningIncluded).toBe(false);
    expect(hidden.messageCount).toBe(2);

    const visible = renderSessionMarkdown(events, metadata, {
      includeReasoning: true,
    });
    expect(visible.markdown).toContain('## Reasoning\n\nprivate chain of thought');
    expect(visible.markdown.indexOf('## Reasoning')).toBeLessThan(
      visible.markdown.indexOf('## Assistant')
    );
    expect(visible.reasoningCount).toBe(1);
  });

  it('redacts credentials, binary data, signed URLs, and host paths from tool activity', () => {
    const events = [
      message('assistant-1', 'assistant'),
      part('assistant-1', 'tool-1', 'tool_call', {
        toolCallId: 'tool-1',
        toolName: 'Bash',
        input: {
          command: `cat ${projectPath}/src/index.ts /Users/alice/.ssh/id_rsa`,
          apiKey: 'sk-RAWSECRET123456789',
          authorization: 'Bearer RAW_BEARER',
          url: 'https://example.com/download?token=raw#fragment',
          image: 'data:image/png;base64,RAW_BINARY',
        },
      }),
      part('tool-1', 'tool-1', 'tool_result', {
        toolCallId: 'tool-1',
        toolName: 'Bash',
        output: {
          stdout:
            'password=RAW_PASSWORD\n/private/var/private.log\n/mnt/private/report\nC:\\Users\\alice\\secret.txt',
          nested: { refresh_token: 'RAW_REFRESH' },
        },
        error: null,
      }),
    ];

    const result = renderSessionMarkdown(events, metadata);
    expect(result.markdown).toContain('## Activity: Bash call');
    expect(result.markdown).toContain('./src/index.ts');
    expect(result.markdown).toContain('[host-path]');
    expect(result.markdown).toContain('[binary omitted]');
    expect(result.markdown).toContain('https://example.com/download');
    for (const secret of [
      'RAWSECRET',
      'RAW_BEARER',
      'raw#fragment',
      'RAW_BINARY',
      'RAW_PASSWORD',
      'RAW_REFRESH',
      '/Users/alice',
      '/private/var',
      '/mnt/private',
      'C:\\Users\\alice',
    ]) {
      expect(result.markdown).not.toContain(secret);
    }
    expect(result.redactionCount).toBeGreaterThanOrEqual(7);
    expect(result.activityCount).toBe(2);
  });

  it('uses the latest part update, produces a verifiable body hash, and avoids unsafe filenames', () => {
    const events = [
      message('user-1', 'user'),
      part('user-1', 'text', 'text', { text: 'old text' }),
      part(
        'user-1',
        'text',
        'text',
        { text: 'new text with `` fenced content' },
        'part_updated'
      ),
    ];

    const result = renderSessionMarkdown(events, {
      ...metadata,
      sessionId: 'session-export.with-safe-id',
    });
    expect(result.markdown).toContain('new text');
    expect(result.markdown).not.toContain('old text');
    const body = result.markdown.split('\n---\n\n')[1];
    expect(body).toBeDefined();
    expect(createHash('sha256').update(body!).digest('hex')).toBe(result.contentSha256);
    expect(result.filename).toBe('blade-session-session-expo.md');
  });

  it('exports user shell records without exposing their internal XML wrapper', () => {
    const events = [
      event(
        'message_created',
        {
          messageId: 'shell-1',
          role: 'user',
          createdAt: timestamp,
          metadata: {
            userShellCommand: {
              version: 1,
              command: 'pwd',
              status: 'completed',
              exitCode: 0,
              durationMs: 4,
              stdout: '/workspace',
              stderr: '',
              stdoutOmittedBytes: 0,
              stderrOmittedBytes: 0,
              binaryOutput: false,
              truncated: false,
            },
          },
        },
        'shell-message'
      ),
      part('shell-1', 'shell-text', 'text', {
        text: '<user_shell_command>private wrapper</user_shell_command>',
      }),
    ];

    const result = renderSessionMarkdown(events, metadata);
    expect(result.markdown).toContain('## User shell command');
    expect(result.markdown).toContain('$ pwd\n/workspace');
    expect(result.markdown).not.toContain('<user_shell_command>');
  });

  it('bounds individual activity projections without dropping the conversation', () => {
    const oversized = 'x'.repeat(MAX_SESSION_MARKDOWN_ACTIVITY_BYTES * 2);
    const result = renderSessionMarkdown(
      [
        message('user-1', 'user'),
        part('user-1', 'text', 'text', { text: 'keep this message' }),
        message('assistant-1', 'assistant'),
        part('assistant-1', 'tool', 'tool_result', {
          toolName: 'Read',
          output: oversized,
          error: null,
        }),
      ],
      metadata
    );
    expect(result.markdown).toContain('keep this message');
    expect(result.markdown).toContain('[activity truncated]');
    expect(result.markdown).not.toContain(oversized);
  });

  it('exports the materialized conversation after durable rewind markers', () => {
    const events = [
      message('user-1', 'user'),
      part('user-1', 'first', 'text', { text: 'keep first turn' }),
      message('assistant-1', 'assistant'),
      part('assistant-1', 'first-answer', 'text', { text: 'first answer' }),
      message('user-2', 'user'),
      part('user-2', 'second', 'text', { text: 'remove second turn' }),
      event(
        'session_rewound',
        {
          rewindId: 'rewind-1',
          targetMessageId: 'user-2',
          mode: 'conversation',
          restoredFiles: [],
          createdAt: timestamp,
        },
        'rewind'
      ),
    ];
    const result = renderSessionMarkdown(events, metadata);
    expect(result.markdown).toContain('keep first turn');
    expect(result.markdown).toContain('first answer');
    expect(result.markdown).not.toContain('remove second turn');
  });

  it('fails when no user-visible or auditable content exists', () => {
    expect(() =>
      renderSessionMarkdown(
        [
          message('system-1', 'system'),
          part('system-1', 'internal', 'text', { text: 'internal only' }),
        ],
        metadata
      )
    ).toThrow('No conversation content to export');
  });
});
